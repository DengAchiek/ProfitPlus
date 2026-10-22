'use strict';
const {createHash,randomBytes,randomUUID}=require('node:crypto');
const {AppError,passwordHash}=require('./store');

const LIFE=15*60000;
const ACK={ok:true,message:'If an active account matches that email, a reset link will be sent. Check your inbox and spam folder.'};
const INVALID='This password reset link is invalid, expired or already used. Request a new link.';
const DELIVERY_ERROR='The email service could not accept the message. Check the Resend API key, verified sender domain and sending limits.';
const digest=value=>createHash('sha256').update(value).digest('hex');
function address(value) {
  if(typeof value!=='string'||value.length>254||!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value.trim()))throw new AppError(422,'Enter a valid email address.');
  return value.trim().toLowerCase();
}

// Recovery is independent of subscription entitlements and tenant permissions.
// Raw tokens exist only in the email and the receiver's browser memory.
class PasswordReset {
  constructor(store,analytics,options={}) {
    this.store=store;this.db=store.db;this.analytics=analytics;this.codec=options.codec;
    this.defaults=options.config||{};this.origin=options.publicOrigin;this.fetch=options.fetch||fetch;
    this.now=options.now||Date.now;this.background=options.background;this.tasks=new Set();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS password_reset_tokens(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),password_fingerprint TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS password_reset_user ON password_reset_tokens(user_id);
      CREATE TABLE IF NOT EXISTS password_reset_limits(key TEXT PRIMARY KEY,count INTEGER NOT NULL,reset INTEGER NOT NULL);
    `);
  }
  config() {
    const row=this.db.prepare('SELECT value FROM platform_meta WHERE key=?').get('password_reset_email');
    return row?this.codec.unseal(row.value):{apiKey:this.defaults.apiKey||'',fromAddress:this.defaults.fromAddress||''};
  }
  originReady() {
    try{const u=new URL(this.origin);return u.origin===this.origin&&(u.protocol==='https:'||u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname));}catch{return false;}
  }
  ready() {const c=this.config();return !!(c.apiKey&&c.fromAddress&&this.originReady());}
  settings(user) {
    this.analytics.requireAdmin(user);const c=this.config();
    const health=this.db.prepare('SELECT value FROM platform_meta WHERE key=?').get('password_reset_email_health');
    return {provider:'resend',fromAddress:c.fromAddress,apiKeySet:!!c.apiKey,originConfigured:this.originReady(),ready:this.ready(),...(health?JSON.parse(health.value):{lastAcceptedAt:null,lastError:null})};
  }
  saveSettings(user,input) {
    this.analytics.requireAdmin(user);
    const old=this.config(),apiKey=typeof input?.apiKey==='string'&&input.apiKey.trim()?input.apiKey.trim():old.apiKey;
    const fromAddress=address(input?.fromAddress);
    if(typeof apiKey!=='string'||apiKey.length>512||!/^re_[A-Za-z0-9_-]{10,}$/.test(apiKey))throw new AppError(422,'Enter a valid Resend API key.');
    this.store.transaction(()=>{
      this.db.prepare('INSERT INTO platform_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('password_reset_email',this.codec.seal({apiKey,fromAddress}));
      this.db.prepare('DELETE FROM platform_meta WHERE key=?').run('password_reset_email_health');
      this.store.audit(user,'configured','password recovery email',null,null,{provider:'resend',fromAddress});
    });
    return this.settings(user);
  }
  prune() {
    this.db.prepare('DELETE FROM password_reset_tokens WHERE expires<=?').run(this.now());
    this.db.prepare('DELETE FROM password_reset_limits WHERE reset<=?').run(this.now());
  }
  take(key,max,window=LIFE) {
    const now=this.now(),row=this.db.prepare('SELECT count,reset FROM password_reset_limits WHERE key=?').get(key);
    if(row&&row.reset>now&&row.count>=max)return false;
    this.db.prepare('INSERT INTO password_reset_limits VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET count=excluded.count,reset=excluded.reset').run(key,row&&row.reset>now?row.count+1:1,row&&row.reset>now?row.reset:now+window);
    return true;
  }
  limit(operation,ip,max) {
    this.prune();
    if(!this.take(operation+':'+digest(String(ip||'unknown')),max))throw new AppError(429,'Too many password recovery attempts. Try again in 15 minutes.');
  }
  health(error) {
    const old=this.db.prepare('SELECT value FROM platform_meta WHERE key=?').get('password_reset_email_health');
    const prior=old?JSON.parse(old.value):{};
    this.db.prepare('INSERT INTO platform_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('password_reset_email_health',JSON.stringify({lastAcceptedAt:error?prior.lastAcceptedAt||null:new Date(this.now()).toISOString(),lastError:error?DELIVERY_ERROR:null}));
  }
  async send(to,subject,text,key) {
    const c=this.config(),body=JSON.stringify({from:'BizAtrio <'+c.fromAddress+'>',to:[to],subject,text});
    for(let attempt=0;attempt<2;attempt++){
      try{
        const response=await this.fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+c.apiKey,'Content-Type':'application/json','Idempotency-Key':key},body,signal:AbortSignal.timeout(10000)});
        if(response.ok){const result=await response.json();if(typeof result.id==='string'&&result.id){this.health(false);return;}}
        if(response.status!==429&&response.status<500)break;
      }catch{/* Never log provider responses, recipient addresses or reset URLs. */}
      if(!attempt)await new Promise(resolve=>setTimeout(resolve,250));
    }
    this.health(true);throw new AppError(503,DELIVERY_ERROR);
  }
  request(input,ip) {
    this.limit('request-ip',ip,15);
    const email=address(input?.email);
    if(!this.ready())throw new AppError(503,'Password recovery email is not configured yet. Contact the platform administrator.');
    // Limit registered and unknown addresses identically, without revealing
    // account existence or invalidating a previously emailed, unused link.
    if(!this.take('request-email:'+digest(email),3))return {...ACK};
    const user=this.db.prepare('SELECT * FROM users WHERE email=? AND active=1').get(email);
    if(!user)return {...ACK};
    const token=randomBytes(32).toString('hex'),tokenHash=digest(token);
    this.db.prepare('INSERT INTO password_reset_tokens VALUES (?,?,?,?)').run(tokenHash,user.id,digest(user.password),this.now()+LIFE);
    const link=this.origin+'/reset-password#token='+token;
    const message='Reset your BizAtrio password\n\nOpen this link to choose a new password:\n'+link+'\n\nThis link expires in 15 minutes and can be used once. Resetting your password signs your account out on all devices. Your records and account permissions are kept.\n\nIf you did not request this, ignore this email. Your password will stay the same.\n\nBizAtrio · Your business, connected.';
    let task;
    task=Promise.resolve().then(()=>this.send(user.email,'Reset your BizAtrio password',message,'password-reset/'+tokenHash)).catch(()=>{this.db.prepare('DELETE FROM password_reset_tokens WHERE token_hash=?').run(tokenHash);}).finally(()=>this.tasks.delete(task));
    this.tasks.add(task);if(this.background)this.background(task);
    return {...ACK};
  }
  lookup(token) {
    if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token))throw new AppError(400,INVALID);
    const row=this.db.prepare('SELECT u.*,r.password_fingerprint,r.expires FROM password_reset_tokens r JOIN users u ON u.id=r.user_id WHERE r.token_hash=? AND r.expires>? AND u.active=1').get(digest(token),this.now());
    if(!row||row.password_fingerprint!==digest(row.password))throw new AppError(400,INVALID);
    return row;
  }
  validate(input,ip) {this.limit('validate-ip',ip,50);this.lookup(input?.token);return {valid:true};}
  reset(input,ip) {
    this.limit('reset-ip',ip,10);this.lookup(input?.token);
    if(input.newPassword!==input.confirmPassword)throw new AppError(422,'The new passwords must match.');
    const encoded=passwordHash(input.newPassword);
    this.store.transaction(()=>{
      const user=this.lookup(input.token);
      this.db.prepare('UPDATE users SET password=? WHERE id=?').run(encoded,user.id);
      this.db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
      this.db.prepare('DELETE FROM password_reset_tokens WHERE user_id=?').run(user.id);
      this.store.audit(user,'reset password','account',user.id,null,null);
    });
    return {ok:true};
  }
  async testEmail(user) {
    this.analytics.requireAdmin(user);this.limit('test-admin',user.id,3);
    if(!this.ready())throw new AppError(503,'Save the sender address and API key first. PUBLIC_ORIGIN must also be configured.');
    await this.send(user.email,'BizAtrio password recovery email test','BizAtrio can send account-recovery emails using the configured sender. This test does not change a password or create a reset link.','password-reset-test/'+randomUUID());
    return {ok:true,message:'Test email accepted. Check the inbox and spam folder for your administrator email.'};
  }
}
module.exports={PasswordReset};
