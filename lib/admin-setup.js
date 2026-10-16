'use strict';
const { createHash, timingSafeEqual } = require('node:crypto');
const { AppError } = require('./store');
const digest = value => createHash('sha256').update(value).digest('hex');

// A deployment-controlled, expiring invitation can create one reserved admin
// account. Only digests are configured; the invitation never resets an account.
class AdminSetup {
  constructor(store, analytics, config = {}, now = Date.now) {
    this.store=store;this.analytics=analytics;this.config=config;this.now=now;
  }
  available() {
    const {tokenHash,emailHash,expiresAt}=this.config;
    return /^[a-f0-9]{64}$/.test(tokenHash||'') && /^[a-f0-9]{64}$/.test(emailHash||'') && Date.parse(expiresAt)>this.now() &&
      !this.store.db.prepare('SELECT value FROM platform_meta WHERE key=?').get('admin_setup_used:'+tokenHash);
  }
  claim(input) {
    const invalid=()=>{throw new AppError(403,'This setup link is invalid, expired or already used.');};
    if(!this.available() || !input || typeof input!=='object' || typeof input.setupCode!=='string' || !/^[a-f0-9]{64}$/.test(input.setupCode))invalid();
    const supplied=Buffer.from(digest(input.setupCode),'hex'),expected=Buffer.from(this.config.tokenHash,'hex');
    if(!timingSafeEqual(supplied,expected))invalid();
    const address=typeof input.email==='string'?input.email.trim().toLowerCase():'';
    if(digest(address)!==this.config.emailHash || !this.analytics.allowedEmail(address))invalid();
    if(this.store.db.prepare('SELECT id FROM users WHERE email=?').get(address))throw new AppError(409,'This account already exists. Sign in with its ProfitPlus password. Setup cannot reset a password.');
    const user=this.store.createBusiness({name:input.name,email:address,password:input.password,businessName:input.businessName||'ProfitPlus Administration',currency:'KES',locale:'en-KE',timezone:'Africa/Nairobi',plan:'starter'});
    // Account uniqueness also prevents reuse if a process stops between creation
    // and the marker. No account deletion or email-change route exists.
    this.store.db.prepare('INSERT INTO platform_meta VALUES (?,?)').run('admin_setup_used:'+this.config.tokenHash,new Date(this.now()).toISOString());
    this.analytics.registered(user);this.analytics.login(user);
    return user;
  }
}
module.exports={AdminSetup};
