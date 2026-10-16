'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Store}=require('../lib/store');
const {Analytics}=require('../lib/analytics');
const {createApplication}=require('../server');
const PulseUsage=require('../dist/usage');
const {createHash}=require('node:crypto');
const account=(email,name='Owner')=>({businessName:'Workspace '+name,name,email,password:'synthetic-admin-password',currency:'KES'});

test('platform admin authorization, safe profiles, server metrics and tenant isolation over HTTP',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pulse-admin-')),store=new Store(dir);
  const admin=store.createBusiness(account('admin@example.test','Admin'));
  let now=Date.parse('2026-10-16T10:00:00Z');
  const errors=[],app=createApplication({store,startTimers:false,adminEmails:' ADMIN@example.test ',analyticsNow:()=>now,logger:{error:(...values)=>errors.push(values)}});
  await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve);});
  const origin='http://127.0.0.1:'+app.server.address().port;
  t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
  const request=(route,method='GET',body,session={},extra={})=>fetch(origin+route,{method,headers:{Origin:origin,...(body?{'Content-Type':'application/json'}:{}),...(session.cookie?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{}),...extra},body:body?JSON.stringify(body):undefined});
  const login=async email=>{const response=await request('/api/login','POST',{email,password:account(email).password});assert.equal(response.status,200);return{cookie:response.headers.get('set-cookie').split(';')[0],...(await response.json())};};
  const adminSession=await login(admin.email);
  const registered=await request('/api/register','POST',{...account('customer@example.test','Customer'),platformAdmin:true,role:'admin'});
  assert.equal(registered.status,200);
  const ownerSession={cookie:registered.headers.get('set-cookie').split(';')[0],...(await registered.json())};
  const owner=store.authenticate('customer@example.test',account().password);
  const staff=await request('/api/users','POST',{name:'Staff',email:'staff-admin@example.test',password:account().password,role:'staff',platformAdmin:true},ownerSession);
  assert.equal(staff.status,201);const staffSession=await login('staff-admin@example.test');
  await t.test('only configured admin can query any admin endpoint, including known user IDs',async()=>{
    for(const route of ['/api/admin/dashboard','/api/admin/users','/api/admin/users/'+admin.id]){
      assert.equal((await request(route)).status,401);
      for(const session of [ownerSession,staffSession])assert.equal((await request(route,'GET',null,session,{'X-Admin':'true','X-Role':'admin'})).status,403);
      assert.equal((await request(route,'GET',null,adminSession)).status,200);
    }
    assert.equal((await(await request('/api/bootstrap','GET',null,adminSession)).json()).platformAdmin,true);
    const otherBoot=await(await request('/api/bootstrap','GET',null,ownerSession)).json();
    assert.equal(otherBoot.platformAdmin,false);assert.equal(otherBoot.users.length,2);assert.ok(!otherBoot.users.some(u=>u.id===admin.id));
    assert.equal((await request('/api/admin/dashboard','GET',null,adminSession)).headers.get('cache-control'),'no-store');
    assert.equal((await request('/api/admin/dashboard?days=999','GET',null,adminSession)).status,422);
  });
  await t.test('configured addresses cannot be claimed through registration or team creation',async()=>{
    assert.equal((await request('/api/register','POST',account('ADMIN@example.test'))).status,422);
    assert.equal((await request('/api/users','POST',{name:'Impersonator',email:'admin@example.test',password:account().password,role:'owner'},ownerSession)).status,422);
  });
  await t.test('usage is session-scoped, validated and protected by CSRF and origin',async()=>{
    const ping={module:'invoices',tabId:'synthetic-tab-1',sequence:1,activeSeconds:60,view:true,userId:admin.id};
    assert.equal((await request('/api/telemetry','POST',ping,ownerSession,{'X-CSRF-Token':''})).status,403);
    assert.equal((await request('/api/telemetry','POST',ping,ownerSession,{Origin:'https://attacker.example'})).status,403);
    assert.equal((await request('/api/telemetry','POST',{...ping,module:'admin'},ownerSession)).status,422);
    assert.equal((await request('/api/telemetry','POST',{...ping,activeSeconds:100000},ownerSession)).status,422);
    assert.equal((await request('/api/telemetry','POST',ping,ownerSession)).status,200);
    now+=30000;assert.equal((await request('/api/telemetry','POST',{...ping,sequence:2,view:false,activeSeconds:30},ownerSession)).status,200);
    assert.equal((await request('/api/telemetry','POST',{...ping,sequence:2,view:false,activeSeconds:30},ownerSession)).status,200);
    const profile=await(await request('/api/admin/users/'+owner.id,'GET',null,adminSession)).json();
    assert.equal(profile.services.find(s=>s.module==='invoices').activeSeconds,30);assert.equal(profile.services.find(s=>s.module==='invoices').visits,1);
    const adminProfile=await(await request('/api/admin/users/'+admin.id,'GET',null,adminSession)).json();
    assert.equal(adminProfile.services.length,0);
  });
  await t.test('successful services and errors reconcile without exposing secrets or record contents',async()=>{
    const saved=await request('/api/records/customers','POST',{name:'Sensitive customer content'},ownerSession);assert.equal(saved.status,201);
    const write=store.write;store.write=()=>{throw Error('Synthetic failure');};
    assert.equal((await request('/api/records/customers','POST',{name:'Will fail'},ownerSession)).status,500);store.write=write;
    const data=await(await request('/api/admin/dashboard?days=7','GET',null,adminSession)).json();
    assert.equal(data.totals.registeredUsers,3);assert.equal(data.totals.newUsers,2);assert.equal(data.totals.missingRegistrationDates,1);
    assert.equal(data.totals.activeSeconds,30);assert.equal(data.totals.activeUsers,1);
    assert.equal(data.performance.serverErrors,1);assert.ok(data.performance.requests>0);
    assert.equal(data.daily.reduce((n,r)=>n+r.requests,0),data.performance.requests);
    assert.equal(data.daily.reduce((n,r)=>n+r.actions,0),data.totals.actions);
    assert.equal(data.services.reduce((n,r)=>n+r.activeSeconds,0),data.totals.activeSeconds);
    assert.equal(data.services.find(r=>r.module==='customers').actions,1);
    assert.ok(!data.routes.some(r=>/admin|telemetry/.test(r.route)));
    const profile=await(await request('/api/admin/users/'+owner.id,'GET',null,adminSession)).json();
    assert.equal(profile.user.registeredAt,'2026-10-16T10:00:00.000Z');
    assert.equal(profile.business.currency,'KES');
    assert.doesNotMatch(JSON.stringify(profile),/password|csrf|token|Sensitive customer content|synthetic-admin-password/);
    const users=await(await request('/api/admin/users?search=customer%40','GET',null,adminSession)).json();
    assert.equal(users.total,1);assert.equal(users.users[0].id,owner.id);assert.equal(users.users[0].topModule,'customers');
    assert.doesNotMatch(JSON.stringify(users),/password|csrf|token|Sensitive customer content/);
    const backup=await(await request('/api/backup','GET',null,ownerSession)).json();assert.ok(!backup.platform_profiles);
    assert.equal(errors.length,1);
  });
  await t.test('disabled admin sessions lose access immediately and metrics failure cannot fail a save',async()=>{
    store.db.prepare('UPDATE users SET active=0 WHERE id=?').run(admin.id);
    assert.equal((await request('/api/admin/dashboard','GET',null,adminSession)).status,401);
    app.analytics.request=()=>{throw Error('Synthetic analytics failure');};
    assert.equal((await request('/api/records/customers','POST',{name:'Still saved'},ownerSession)).status,201);
  });
});

test('user directory search and pagination return bounded profiles without duplication',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pulse-admin-pages-')),store=new Store(dir);
  t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
  const admin=store.createBusiness(account('admin@example.test'));
  const analytics=new Analytics(store,{adminEmails:admin.email});
  for(let n=0;n<22;n++){
    const id='synthetic-user-'+n;
    store.db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,1)').run(id,admin.business_id,'Member '+n,'member-'+n+'@example.test','not-a-login-hash','staff');
    analytics.registered({id});
  }
  const first=analytics.users(admin,{page:1}),second=analytics.users(admin,{page:2});
  assert.equal(first.total,23);assert.equal(first.users.length,20);assert.equal(second.users.length,3);
  assert.equal(new Set([...first.users,...second.users].map(u=>u.id)).size,23);
  assert.equal(analytics.users(admin,{search:'MEMBER-21@'}).users[0].id,'synthetic-user-21');
  assert.equal(analytics.users(admin,{search:"' OR 1=1 --"}).total,0);
  assert.equal(analytics.users(admin,{page:3}).users.length,0);
});

test('analytics cap time across sessions, preserve history on restart and prune bounded aggregates',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pulse-analytics-')),store=new Store(dir);
  t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
  const user=store.createBusiness(account('admin@example.test'));
  let now=Date.parse('2026-10-16T10:00:00Z');
  let analytics=new Analytics(store,{adminEmails:user.email,now:()=>now});
  const ping={module:'quotes',tabId:'first-tab',sequence:1,activeSeconds:60,view:true};
  analytics.heartbeat(user,ping);now+=30000;
  analytics.heartbeat(user,{...ping,sequence:2,view:false});
  analytics.heartbeat(user,{...ping,tabId:'second-tab',sequence:1,view:true});
  assert.equal(analytics.dashboard(user,7).totals.activeSeconds,30);
  now+=600000;analytics.heartbeat(user,{...ping,sequence:3,view:false});
  assert.equal(analytics.dashboard(user,7).totals.activeSeconds,90);
  analytics.request('/api/records/quotes/private-id/pdf?private=query','GET',200,250,user);
  analytics.request('/api/login','POST',401,100,null);
  const before=analytics.dashboard(user,7);
  analytics=new Analytics(store,{adminEmails:user.email,now:()=>now});
  assert.equal(analytics.dashboard(user,7).trackingStartedAt,before.trackingStartedAt);
  assert.equal(analytics.dashboard(user,7).totals.activeSeconds,90);
  assert.equal(analytics.dashboard(user,7).performance.averageMs,175);
  assert.ok(!JSON.stringify(analytics.dashboard(user,7).routes).includes('private'));
  now+=92*86400000;
  const pruned=analytics.dashboard(user,90);
  assert.equal(pruned.totals.activeSeconds,0);assert.equal(pruned.performance.requests,0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM platform_usage').get().n,0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM platform_requests').get().n,0);
  assert.equal(pruned.totals.registeredUsers,1);
  const noAdmin=new Analytics(store,{now:()=>now});assert.throws(()=>noAdmin.dashboard(user,7),{status:403});
  const hashed=new Analytics(store,{adminEmailHashes:createHash('sha256').update(user.email).digest('hex'),now:()=>now});
  assert.equal(hashed.isAdmin(user),true);assert.throws(()=>hashed.reserveEmail(user.email.toUpperCase()),{status:422});
});

test('browser active time excludes hidden, unfocused, idle and suspended intervals',()=>{
  let now=100000,visible=true;const sent=[];
  const tracker=PulseUsage.create({now:()=>now,visible:()=>visible,tabId:'client-tab',send:body=>sent.push(body)});
  tracker.module('invoices');assert.equal(sent[0].view,true);assert.equal(sent[0].activeSeconds,0);
  for(let i=0;i<30;i++){now+=1000;tracker.sample();}
  assert.equal(sent[1].activeSeconds,30);
  visible=false;for(let i=0;i<30;i++){now+=1000;tracker.sample();}
  assert.equal(sent.length,2);
  visible=true;for(let i=0;i<30;i++){now+=1000;tracker.sample();}
  assert.equal(sent.length,2,'idle after 60 seconds must not generate time');
  tracker.activity();for(let i=0;i<30;i++){now+=1000;tracker.sample();}
  tracker.flush();assert.equal(sent.reduce((n,r)=>n+r.activeSeconds,0),60);
  now+=600000;tracker.sample();assert.equal(sent.reduce((n,r)=>n+r.activeSeconds,0),60,'sleep cannot credit the suspended interval');
  tracker.module('admin');now+=30000;tracker.sample();assert.notEqual(sent.at(-1).module,'admin');
  tracker.stop();
});
