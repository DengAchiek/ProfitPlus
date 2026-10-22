'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {createHash}=require('node:crypto');
const {Store}=require('../lib/store'),{createApplication}=require('../server');
const oldPassword='synthetic-original-password',newPassword='synthetic-recovered-password';
const canonical='https://bizatrio.example.test',key='re_synthetic_sending_key_12345';
const input=email=>({email,name:email.split('@')[0],businessName:'Recovery QA',password:oldPassword,currency:'KES'});
const hash=value=>createHash('sha256').update(value).digest('hex');

async function fixture(t,options={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bizatrio-reset-')),store=new Store(dir);
  const admin=store.createBusiness(input('admin@example.test')),owner=store.createBusiness(input('owner@example.test'));
  const staff=store.addUser(owner,{name:'Staff',email:'staff@example.test',password:oldPassword,role:'staff'});
  const disabled=store.createBusiness(input('disabled@example.test'));store.db.prepare('UPDATE users SET active=0 WHERE id=?').run(disabled.id);
  const messages=[],errors=[];let now=Date.now();
  const provider=async(url,request)=>{messages.push({url,headers:request.headers,...JSON.parse(request.body)});return new Response(JSON.stringify({id:'email-'+messages.length}),{status:200});};
  const app=createApplication({store,startTimers:false,production:false,publicOrigin:canonical,adminEmails:admin.email,logger:{error:(...values)=>errors.push(values)},passwordReset:{config:options.unconfigured?{}:{apiKey:key,fromAddress:'accounts@example.test'},fetch:provider,now:()=>now}});
  await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve);});
  const url='http://127.0.0.1:'+app.server.address().port;
  t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
  const sessions=new Map();
  const session=user=>{if(!sessions.has(user.id))sessions.set(user.id,store.session(user));return sessions.get(user.id);};
  const request=(route,method='GET',body,user,extra={})=>{
    const s=user?session(user):null;
    return fetch(url+route,{method,headers:{Origin:canonical,...(body!==undefined?{'Content-Type':'application/json'}:{}),...(s?{Cookie:'pulse_session='+s.token,'X-CSRF-Token':s.csrf}:{}),...extra},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  };
  const flush=()=>Promise.allSettled([...app.passwordReset.tasks]);
  const issue=async email=>{const response=await request('/api/password/forgot','POST',{email});assert.equal(response.status,202,await response.clone().text());await flush();return messages.filter(m=>m.to[0]===email.toLowerCase().trim()).at(-1)?.text.match(/#token=([a-f0-9]{64})/)?.[1];};
  return {app,store,dir,admin,owner,staff,disabled,request,messages,errors,issue,flush,session,advance:ms=>{now+=ms;}};
}

test('admins, client owners and staff recover by email without changing records, permissions or subscriptions',async t=>{
  const f=await fixture(t);
  const saved=f.store.saveRecord(f.owner,'customers',{name:'Keep this customer'});
  f.store.db.prepare('UPDATE subscriptions SET trial_end=? WHERE business_id=?').run(Date.now()-1,f.owner.business_id);
  for(const user of [f.admin,f.owner,f.staff]){
    const original=f.store.db.prepare('SELECT * FROM users WHERE id=?').get(user.id),session=f.session(user);
    const subscription=f.store.subscriptionRow(original),second=f.store.session(original);
    const token=await f.issue(' '+user.email.toUpperCase()+' ');assert.match(token,/^[a-f0-9]{64}$/);
    const email=f.messages.at(-1);assert.deepEqual(email.to,[user.email]);assert.equal(email.from,'BizAtrio <accounts@example.test>');
    assert.match(email.text,new RegExp(canonical.replaceAll('.','\\.')+'/reset-password#token='));assert.doesNotMatch(email.text,/\?token=|synthetic-original-password/);
    const record=f.store.db.prepare('SELECT * FROM password_reset_tokens WHERE token_hash=?').get(hash(token));assert.ok(record);assert.notEqual(record.token_hash,token);
    assert.equal((await f.request('/api/password/validate','POST',{token})).status,200);
    assert.equal((await f.request('/reset-password')).status,200,'loading a page cannot consume the link');
    const reset=await f.request('/api/password/reset','POST',{token,newPassword,confirmPassword:newPassword,userId:f.disabled.id,email:f.disabled.email,role:'admin'});
    assert.equal(reset.status,200,await reset.clone().text());
    const updated=f.store.authenticate(user.email,newPassword);assert.equal(updated.id,user.id);assert.equal(updated.role,original.role);assert.equal(updated.business_id,original.business_id);assert.equal(updated.active,original.active);
    assert.deepEqual(f.store.subscriptionRow(updated),subscription);assert.equal(f.store.findSession(session.token),undefined);assert.equal(f.store.findSession(second.token),undefined);
    assert.equal((await f.request('/api/password/reset','POST',{token,newPassword,confirmPassword:newPassword})).status,400);
    assert.throws(()=>f.store.authenticate(user.email,oldPassword),{status:401});
    if(user.id===f.admin.id)assert.equal(f.app.analytics.isAdmin(updated),true);
    else assert.equal(f.app.analytics.isAdmin(updated),false);
  }
  assert.equal(f.store.get(f.owner,'customers',saved.id).name,saved.name);
  assert.throws(()=>f.store.authenticate(f.disabled.email,newPassword),{status:401});
  const audit=f.store.db.prepare("SELECT before_data,after_data FROM audit WHERE action='reset password'").all();
  assert.equal(audit.length,3);assert.doesNotMatch(JSON.stringify(audit),/token|password|synthetic/);
  assert.equal(f.errors.length,0);
});

test('unknown and disabled accounts get the same response and no emailed token, including during provider failure',async t=>{
  const f=await fixture(t);
  const known=await f.request('/api/password/forgot','POST',{email:f.owner.email});
  const unknown=await f.request('/api/password/forgot','POST',{email:'unknown@example.test'});
  const disabled=await f.request('/api/password/forgot','POST',{email:f.disabled.email});
  assert.equal(known.status,202);assert.equal(unknown.status,202);assert.equal(disabled.status,202);
  assert.deepEqual(await known.json(),await unknown.json());assert.deepEqual(await disabled.json(),{ok:true,message:'If an active account matches that email, a reset link will be sent. Check your inbox and spam folder.'});
  await f.flush();assert.equal(f.messages.length,1);
  f.app.passwordReset.fetch=async()=>new Response(JSON.stringify({error:'private-provider-key '+key}),{status:403});
  const failure=await f.request('/api/password/forgot','POST',{email:f.staff.email});
  assert.equal(failure.status,202);assert.deepEqual(await failure.json(),{ok:true,message:'If an active account matches that email, a reset link will be sent. Check your inbox and spam folder.'});
  await f.flush();assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM password_reset_tokens WHERE user_id=?').get(f.staff.id).n,0);
  const health=await(await f.request('/api/admin/email-settings','GET',undefined,f.admin)).json();
  assert.match(health.lastError,/could not accept/);assert.doesNotMatch(JSON.stringify(health),/private-provider-key|re_synthetic|token/);
  assert.equal(f.errors.length,0);assert.equal(f.store.authenticate(f.staff.email,oldPassword).id,f.staff.id);
});

test('expiry, malformed links, disabled accounts, weak passwords, confirmation and simultaneous redemption fail closed',async t=>{
  const f=await fixture(t),token=await f.issue(f.owner.email);
  for(const bad of ['',null,'x'.repeat(64),'a'.repeat(64)])assert.equal((await f.request('/api/password/validate','POST',{token:bad})).status,400);
  assert.equal((await f.request('/api/password/reset','POST',{token,newPassword:'short',confirmPassword:'short'})).status,422);
  assert.equal((await f.request('/api/password/reset','POST',{token,newPassword,confirmPassword:'different'})).status,422);
  assert.equal((await f.request('/api/password/validate','POST',{token})).status,200);
  f.advance(15*60000);assert.equal((await f.request('/api/password/validate','POST',{token})).status,400);
  const fresh=await f.issue(f.owner.email),other=await f.issue(f.owner.email);
  assert.equal((await f.request('/api/password/validate','POST',{token:fresh})).status,200,'requesting another email keeps earlier unexpired links valid');
  const responses=await Promise.all([1,2].map(()=>f.request('/api/password/reset','POST',{token:fresh,newPassword,confirmPassword:newPassword})));
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,400]);
  assert.equal((await f.request('/api/password/validate','POST',{token:other})).status,400,'a reset invalidates every pending link for that account');
  const staffToken=await f.issue(f.staff.email);f.store.db.prepare('UPDATE users SET active=0 WHERE id=?').run(f.staff.id);
  assert.equal((await f.request('/api/password/reset','POST',{token:staffToken,newPassword,confirmPassword:newPassword})).status,400);
  assert.equal(f.store.db.prepare('SELECT active FROM users WHERE id=?').get(f.staff.id).active,0);
});

test('password changes invalidate old links and a failed reset transaction preserves password, sessions and token',async t=>{
  const f=await fixture(t),token=await f.issue(f.owner.email);
  f.store.changePassword(f.owner,oldPassword,newPassword);
  assert.equal((await f.request('/api/password/validate','POST',{token})).status,400);
  const current=await f.issue(f.owner.email),session=f.store.session(f.owner),audit=f.store.audit;
  f.store.audit=()=>{throw Error('Synthetic audit failure');};
  const failed=await f.request('/api/password/reset','POST',{token:current,newPassword:oldPassword,confirmPassword:oldPassword});
  assert.equal(failed.status,500);assert.equal(f.store.authenticate(f.owner.email,newPassword).id,f.owner.id);assert.equal(f.store.findSession(session.token).id,f.owner.id);
  assert.equal((await f.request('/api/password/validate','POST',{token:current})).status,200);
  f.store.audit=audit;
  assert.equal((await f.request('/api/password/reset','POST',{token:current,newPassword:oldPassword,confirmPassword:oldPassword})).status,200);
});

test('recovery setup is admin-only, credentials stay encrypted and tests send only to the administrator',async t=>{
  const f=await fixture(t,{unconfigured:true});
  assert.deepEqual(await(await f.request('/api/password/status')).json(),{available:false});
  for(const email of [f.admin.email,'unknown@example.test'])assert.equal((await f.request('/api/password/forgot','POST',{email})).status,503);
  for(const user of [f.owner,f.staff])for(const method of ['GET','PUT'])assert.equal((await f.request('/api/admin/email-settings',method,method==='PUT'?{apiKey:key,fromAddress:'accounts@example.test'}:undefined,user)).status,403);
  assert.equal((await f.request('/api/admin/email-settings','GET')).status,401);
  assert.equal((await f.request('/api/admin/email-settings','PUT',{apiKey:key,fromAddress:'accounts@example.test'},f.admin,{'X-CSRF-Token':''})).status,403);
  assert.equal((await f.request('/api/admin/email-settings','PUT',{apiKey:key,fromAddress:'bad\r\nBcc: attacker@example.test'},f.admin)).status,422);
  const configured=await f.request('/api/admin/email-settings','PUT',{apiKey:key,fromAddress:'accounts@example.test'},f.admin);
  assert.equal(configured.status,200);const settings=await configured.json();assert.equal(settings.apiKeySet,true);assert.equal(settings.ready,true);assert.doesNotMatch(JSON.stringify(settings),new RegExp(key));
  const stored=f.store.db.prepare('SELECT value FROM platform_meta WHERE key=?').get('password_reset_email').value;assert.ok(!stored.includes(key));
  assert.equal((await f.request('/api/admin/email-settings','PUT',{apiKey:'',fromAddress:'security@example.test'},f.admin)).status,200);
  assert.equal(f.app.passwordReset.config().apiKey,key);
  assert.equal((await f.request('/api/admin/email-settings/test','POST',{to:'attacker@example.test'},f.owner)).status,403);
  assert.equal((await f.request('/api/admin/email-settings/test','POST',{to:'attacker@example.test'},f.admin)).status,200);
  assert.deepEqual(f.messages.at(-1).to,[f.admin.email]);assert.equal(f.messages.at(-1).from,'BizAtrio <security@example.test>');assert.doesNotMatch(f.messages.at(-1).text,/#token=/);
  const backup=await(await f.request('/api/backup','GET',undefined,f.owner)).json();assert.doesNotMatch(JSON.stringify(backup),/password_reset|re_synthetic|token_hash/);
});

test('recovery has independent persistent limits, exact origins and no token in page requests or redirects',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('/api/password/forgot','POST',{email:f.owner.email},undefined,{Origin:'https://attacker.example'})).status,403);
  assert.equal((await f.request('/api/password/reset','POST',{token:'a'.repeat(64),newPassword,confirmPassword:newPassword},undefined,{Origin:'https://attacker.example'})).status,403);
  const responses=[];for(let i=0;i<5;i++)responses.push(await f.request('/api/password/forgot','POST',{email:'unknown@example.test'}));
  assert.ok(responses.every(r=>r.status===202));assert.equal(f.messages.length,0);
  for(let i=0;i<11;i++)await f.request('/api/password/forgot','POST',{email:'unknown'+i+'@example.test'});
  assert.equal((await f.request('/api/password/forgot','POST',{email:f.owner.email})).status,429);
  f.advance(15*60000+1);const token=await f.issue(f.owner.email);assert.ok(token);
  for(const route of ['/forgot-password','/reset-password']){const r=await f.request(route);assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(r.headers.get('referrer-policy'),'no-referrer');assert.match(await r.text(),/password-reset.js/);}
  const limits=f.store.db.prepare('SELECT key FROM password_reset_limits').all();assert.doesNotMatch(JSON.stringify(limits),/owner@|unknown@|127\.0\.0\.1/);
  const before=f.store.db.prepare('SELECT token_hash FROM password_reset_tokens').all();
  const {PasswordReset}=require('../lib/password-reset');
  const recovered=new PasswordReset(f.store,f.app.analytics,{codec:f.app.channels,publicOrigin:canonical,now:()=>Date.now()+15*60000+1});
  assert.ok(recovered.lookup(token));assert.deepEqual(f.store.db.prepare('SELECT token_hash FROM password_reset_tokens').all(),before);
  assert.throws(()=>new PasswordReset(f.store,f.app.analytics,{codec:f.app.channels,publicOrigin:'http://insecure.example.test'}).request({email:f.owner.email},'test-ip'),{status:503});
});

test('transient sends retry the same idempotent payload without exposing account existence',async t=>{
  const f=await fixture(t),attempts=[];
  f.app.passwordReset.fetch=async(url,request)=>{attempts.push(request);return attempts.length===1?new Response('{}',{status:503}):new Response('{"id":"accepted"}',{status:200});};
  const response=await f.request('/api/password/forgot','POST',{email:f.owner.email});assert.equal(response.status,202);await f.flush();
  assert.equal(attempts.length,2);assert.equal(attempts[0].headers['Idempotency-Key'],attempts[1].headers['Idempotency-Key']);assert.equal(attempts[0].body,attempts[1].body);
  assert.equal(f.app.passwordReset.settings(f.admin).lastError,null);
});

test('reset page clears URL tokens, validates without consuming them, confirms passwords and clears successful forms',async()=>{
  const elements=new Map(),calls=[],handlers={};
  const element=id=>{if(!elements.has(id))elements.set(id,{id,hidden:false,textContent:'',disabled:false,values:{},isConnected:true,querySelector(){return this.button||(this.button={disabled:false});},reset(){this.values={};}});return elements.get(id);};
  const token='ab'.repeat(32);
  const context={document:{getElementById:element},location:{pathname:'/reset-password',hash:'#token='+token},history:{replaceState(_a,_b,url){calls.push({history:url});context.location.hash='';}},window:{addEventListener(name,callback){handlers[name]=callback;}},URLSearchParams,FormData:class{constructor(form){this.values=form.values;}[Symbol.iterator](){return Object.entries(this.values)[Symbol.iterator]();}},fetch:async(url,options)=>{calls.push({url,...options});return {ok:true,status:200,json:async()=>({valid:true,ok:true})};}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../dist/password-reset.js'),'utf8'),context);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(context.location.hash,'');assert.equal(element('resetPasswordForm').hidden,false);
  assert.equal(calls.find(c=>c.url).url,'/api/password/validate');assert.equal(JSON.parse(calls.find(c=>c.url).body).token,token);assert.ok(!calls.some(c=>c.url?.includes(token)));
  const form=element('resetPasswordForm');form.values={newPassword,confirmPassword:'different'};form.onsubmit({preventDefault(){}});await new Promise(resolve=>setImmediate(resolve));
  assert.match(element('recoveryError').textContent,/must match/);assert.equal(calls.filter(c=>c.url==='/api/password/reset').length,0);
  form.values={newPassword,confirmPassword:newPassword};form.onsubmit({preventDefault(){}});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(form.hidden,true);assert.deepEqual(form.values,{});assert.match(element('recoveryTitle').textContent,/has been reset/);
});
