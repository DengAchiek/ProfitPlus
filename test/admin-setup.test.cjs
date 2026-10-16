'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createHash}=require('node:crypto');
const {Store}=require('../lib/store');
const {createApplication}=require('../server');
const hash=value=>createHash('sha256').update(value).digest('hex');
const code='a1'.repeat(32),email='reserved-admin@example.test',password='synthetic-admin-setup-password';
const config={tokenHash:hash(code),emailHash:hash(email),expiresAt:'2026-10-17T16:30:00.000Z'};
const input={name:'Platform Admin',email,password,setupCode:code};
async function fixture(t,options={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pulse-admin-setup-')),store=new Store(dir);
  if(options.existing)store.createBusiness({...input,businessName:'Existing admin'});
  let now=Date.parse('2026-10-16T16:30:00Z');
  const app=createApplication({store,startTimers:false,adminEmails:email,adminSetup:options.config??config,analyticsNow:()=>now});
  await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve);});
  const origin='http://127.0.0.1:'+app.server.address().port;
  t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
  const request=(route,method='GET',body,extra={})=>fetch(origin+route,{method,headers:{Origin:origin,...(body!==undefined?{'Content-Type':'application/json'}:{}),...extra},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  return{app,store,request,expire:()=>{now=Date.parse(config.expiresAt)+1;}};
}
test('private setup creates only the invited administrator and immediately authenticates it',async t=>{
  const {app,store,request}=await fixture(t);
  const page=await request('/admin/setup');assert.equal(page.status,200);assert.match(await page.text(),/New ProfitPlus password/);
  const status=await request('/api/admin-setup/status');assert.deepEqual(await status.json(),{available:true});assert.equal(status.headers.get('cache-control'),'no-store');
  assert.equal((await request('/api/register','POST',{...input,businessName:'Cannot claim admin'})).status,422);
  assert.equal((await request('/api/admin-setup','POST',input,{Origin:'https://attacker.example'})).status,403);
  assert.equal((await request('/api/admin-setup','POST',{...input,setupCode:'b2'.repeat(32)})).status,403);
  assert.equal((await request('/api/admin-setup','POST',{...input,email:'different@example.test'})).status,403);
  assert.equal((await request('/api/admin-setup','POST',{...input,password:'short'})).status,422);
  assert.equal(store.needsSetup(),true,'rejected setup must create no account');
  const response=await request('/api/admin-setup','POST',{...input,email:email.toUpperCase(),role:'staff',platformAdmin:true});
  assert.equal(response.status,201,await response.clone().text());assert.match(response.headers.get('set-cookie'),/HttpOnly/);
  const cookie=response.headers.get('set-cookie').split(';')[0],session=await response.json();
  assert.equal(session.user.email,email);assert.equal(session.user.role,'owner');
  const boot=await(await request('/api/bootstrap','GET',undefined,{Cookie:cookie})).json();assert.equal(boot.platformAdmin,true);
  assert.equal((await request('/api/admin/dashboard','GET',undefined,{Cookie:cookie})).status,200);
  assert.equal(store.authenticate(email,password).id,session.user.id);
  assert.notEqual(store.db.prepare('SELECT password FROM users').get().password,password);
  assert.deepEqual(await(await request('/api/admin-setup/status')).json(),{available:false});
  assert.equal((await request('/api/admin-setup','POST',{...input,password:'different-synthetic-password'})).status,403);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM users').get().n,1);
  assert.equal(app.adminSetup.available(),false);
  const {AdminSetup}=require('../lib/admin-setup');
  assert.equal(new AdminSetup(store,app.analytics,config,()=>Date.parse('2026-10-16T18:00:00Z')).available(),false,'usage persists after a restart');
});
test('setup fails closed when missing, expired or for an email outside the admin allowlist',async t=>{
  const disabled=await fixture(t,{config:{}});
  assert.deepEqual(await(await disabled.request('/api/admin-setup/status')).json(),{available:false});
  assert.equal((await disabled.request('/api/admin-setup','POST',input)).status,403);
  const expired=await fixture(t);expired.expire();
  assert.equal((await expired.request('/api/admin-setup','POST',input)).status,403);
  assert.equal(expired.store.needsSetup(),true);
  const wrong=await fixture(t,{config:{...config,emailHash:hash('different@example.test')}});
  assert.equal((await wrong.request('/api/admin-setup','POST',{...input,email:'different@example.test'})).status,403);
});
test('setup never resets an existing account and rate limits repeated guesses',async t=>{
  const {store,request}=await fixture(t,{existing:true});
  const original=store.authenticate(email,password);
  assert.equal((await request('/api/admin-setup','POST',{...input,password:'replacement-synthetic-password'})).status,409);
  assert.equal(store.authenticate(email,password).id,original.id);
  for(let n=0;n<4;n++)assert.equal((await request('/api/admin-setup','POST',{...input,setupCode:'b2'.repeat(32)})).status,403);
  assert.equal((await request('/api/admin-setup','POST',input)).status,429);
});
test('concurrent claims cannot create more than one administrator account',async t=>{
  const {store,request}=await fixture(t);
  const responses=await Promise.all([request('/api/admin-setup','POST',input),request('/api/admin-setup','POST',input)]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[201,403]);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM users').get().n,1);
});
