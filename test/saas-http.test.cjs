'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),Stripe=require('stripe');
const {createApplication}=require('../server');
test('public landing, multiple signup, tenant isolation, subscription gate and signed webhook route',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pulse-saas-http-')),sdk=new Stripe('sk_test_synthetic'),app=createApplication({dataDir:dir,startTimers:false,billing:{stripe:{webhooks:sdk.webhooks,subscriptions:{retrieve:async()=>({id:'sub_http',customer:'cus_http',metadata:{businessId:first.business_id},currency:'usd',status:'active',current_period_end:Math.floor(Date.now()/1000)+86400,items:{data:[{price:{id:'price_http'},quantity:1}]}})}},prices:{starter:{USD:{month:'price_http'}}},webhookSecret:'whsec_http'}});
 await new Promise((r,j)=>{app.server.once('error',j);app.server.listen(0,'127.0.0.1',r);});const origin='http://127.0.0.1:'+app.server.address().port;app.billing.origin=origin;
 t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
 const request=async(route,method='GET',data,session={})=>fetch(origin+route,{method,headers:{Origin:origin,...(data?{'Content-Type':'application/json'}:{}),...(session.cookie?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{})},body:data?JSON.stringify(data):undefined});
 for(const route of ['/','/app','/signup','/login','/landing.css','/landing.js'])assert.equal((await request(route)).status,200);
 assert.match(await(await request('/')).text(),/More clarity/);assert.match(await(await request('/signup')).text(),/id="auth"/);
 async function register(email,currency){const r=await request('/api/register','POST',{businessName:'HTTP SaaS',name:'Owner',email,password:'synthetic-http-password',currency});assert.equal(r.status,200);return{cookie:r.headers.get('set-cookie').split(';')[0],...(await r.json())};}
 const session=await register('first@example.test','KWD'),other=await register('other@example.test','JPY');
 const first=app.store.authenticate('first@example.test','synthetic-http-password');
 const saved=await request('/api/records/customers','POST',{name:'Private customer'},session),customer=await saved.json();assert.equal(customer.preferredCurrency,'KWD');
 assert.equal((await request('/api/records/customers/'+customer.id,'GET',null,other)).status,404);assert.equal((await(await request('/api/bootstrap','GET',null,other)).json()).records.customers.length,0);
 app.store.db.prepare('UPDATE subscriptions SET trial_end=? WHERE business_id=?').run(Date.now()-1,first.business_id);
 assert.equal((await request('/api/records/customers','POST',{name:'Denied'},session)).status,402);assert.equal((await request('/api/backup','GET',null,session)).status,200);
 app.store.setBillingCustomer(first,'cus_http');const payload=JSON.stringify({id:'evt_http',type:'customer.subscription.updated',data:{object:{id:'sub_http'}}}),signature=sdk.webhooks.generateTestHeaderString({payload,secret:'whsec_http'});
 assert.equal((await fetch(origin+'/api/billing/webhook',{method:'POST',headers:{'stripe-signature':'bad','Content-Type':'application/json'},body:payload})).status,400);
 const result=await fetch(origin+'/api/billing/webhook',{method:'POST',headers:{'stripe-signature':signature,'Content-Type':'application/json'},body:payload});assert.equal(result.status,200);assert.equal(app.store.subscription(first).status,'active');
 assert.equal((await request('/api/records/customers','POST',{name:'Allowed after verified event'},session)).status,201);
 const staff=app.store.addUser(first,{name:'Staff',email:'staff@example.test',password:'synthetic-staff-password',role:'staff'}),login=await request('/api/login','POST',{email:staff.email,password:'synthetic-staff-password'}),staffSession={cookie:login.headers.get('set-cookie').split(';')[0],...(await login.json())};assert.equal((await request('/api/billing/checkout','POST',{},staffSession)).status,403);
});
