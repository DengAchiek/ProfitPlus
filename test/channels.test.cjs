'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createHmac}=require('node:crypto');
const {getExpectedTwilioSignature}=require('twilio/lib/webhooks/webhooks');
const {Store}=require('../lib/store'),{Analytics}=require('../lib/analytics'),{Channels}=require('../lib/channels');
const {createApplication}=require('../server');
const account=email=>({businessName:'Capture QA',name:'Owner',email,password:'synthetic-channel-password',currency:'KES'});
function fixture(t,options={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pulse-channels-')),store=new Store(dir);
  const user=store.createBusiness(account('owner@example.test')),other=store.createBusiness(account('other@example.test'));
  const analytics=new Analytics(store,{adminEmails:user.email}),channels=new Channels(store,analytics,{publicOrigin:'https://capture.example.test',...options});
  const f={store,user,other,analytics,channels,dir};
  t.after(async()=>{await Promise.allSettled([...f.channels.tasks]);f.store.close();fs.rmSync(dir,{recursive:true,force:true});});return f;
}
const status=n=>e=>e.status===n;
const site=f=>f.channels.website(f.user,{websiteOrigin:'https://client.example.test',visitsEnabled:true,label:'Client website'});
const input=(f,id,extra={})=>({name:'Customer One',email:'customer@example.test',message:'Please quote for 50 brochures.',submissionId:'submission-one',nonce:f.channels.formNonce(id),...extra});
const collect=(f,c,extra={})=>f.channels.websiteEnquiry(c.id,input(f,c.id,extra),f.channels.origin,'synthetic-ip');
const json=data=>new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
function meta(f,provider='facebook',external='12345'){
  f.channels.saveAdminConfig(f.user,{appId:'12345678',appSecret:'synthetic-meta-secret',version:'v24.0'});
  const id=f.channels.reserve(f.user,provider,external,'Business inbox',{pageId:'12345'},{token:'synthetic-page-token'});f.channels.connected(id);return id;
}
const notification=(provider='page',recipient='12345',mid='message-one',sender='67890',extra={})=>({object:provider,entry:[{id:recipient,messaging:[{sender:{id:sender},recipient:{id:recipient},timestamp:Date.now(),message:{mid,text:'What is the price?',...extra}}]}]});
const signed=(f,payload)=>{const bytes=Buffer.from(JSON.stringify(payload));return [bytes,'sha256='+createHmac('sha256',f.channels.metaConfig().appSecret).update(bytes).digest('hex')];};

test('website intake over HTTP: source identity, permissions, privacy and immutable messages',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pulse-capture-http-')),store=new Store(dir),user=store.createBusiness(account('owner@example.test')),other=store.createBusiness(account('other@example.test'));
  const app=createApplication({store,startTimers:false,adminEmails:user.email});
  await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve);});
  const origin='http://127.0.0.1:'+app.server.address().port;
  t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
  const sessions={};for(const u of [user,other]){const s=store.session(u);sessions[u.id]={Cookie:'pulse_session='+s.token,'X-CSRF-Token':s.csrf};}
  const request=(route,method='GET',body,who=user,headers={})=>fetch(origin+route,{method,headers:{Origin:origin,...(who?sessions[who.id]:{}),...(body?{'Content-Type':'application/json'}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});
  let connection,nonce,lead;
  await t.test('manual and forged-source enquiries are rejected; owners cannot configure the platform app',async()=>{
    for(const body of [{message:'Manual'},{captured:{provider:'website'},message:'Forged'}])assert.equal((await request('/api/records/leads','POST',body)).status,403);
    assert.equal((await request('/api/admin/channel-settings','GET',null,other)).status,403);
    const staff=store.addUser(user,{name:'Staff',email:'staff@example.test',password:account().password,role:'staff'}),s=store.session(staff);sessions[staff.id]={Cookie:'pulse_session='+s.token,'X-CSRF-Token':s.csrf};
    assert.equal((await request('/api/integrations/website','POST',{websiteOrigin:'https://client.example.test'},staff)).status,403);
  });
  await t.test('Meta redirects distinguish expired, cancelled, empty-account and provider failures without leaking credentials',async()=>{
    app.channels.saveAdminConfig(user,{appId:'12345678',appSecret:'synthetic-meta-secret',version:'v24.0'});
    const callback=async(query,expected)=>{
      const response=await fetch(origin+'/api/integrations/oauth/callback?'+new URLSearchParams(query),{headers:sessions[user.id],redirect:'manual'});
      assert.equal(response.status,302);assert.equal(response.headers.get('location'),'/app?channel='+expected+'#integrations');assert.doesNotMatch(response.headers.get('location'),/synthetic-meta-secret|access_token|code=/);
    };
    const start=()=>new URL(app.channels.startMeta(user,'facebook').url).searchParams.get('state');
    await callback({state:'unknown',code:'private-code'},'expired');
    await callback({state:start(),error:'access_denied'},'cancelled');
    const realFetch=app.channels.fetch;
    app.channels.fetch=async url=>json(url.includes('/oauth/access_token')?{access_token:'private-token'}:{data:[]});
    await callback({state:start(),code:'private-code'},'no_accounts');
    app.channels.fetch=async()=>new Response(JSON.stringify({error:{message:'private-provider-error'}}),{status:400});
    await callback({state:start(),code:'private-code'},'provider_error');
    app.channels.fetch=realFetch;
    app.channels.saveAdminConfig(user,{appId:'12345678',appSecret:'synthetic-meta-secret',version:'v24.0'});
  });
  await t.test('website connection and embed are tenant scoped and permit framing only by the client site',async()=>{
    const r=await request('/api/integrations/website','POST',{websiteOrigin:'https://client.example.test',label:'Public enquiries',visitsEnabled:true});assert.equal(r.status,201);connection=await r.json();
    assert.equal((await(await request('/api/integrations','GET',null,other)).json()).connections.length,0);
    assert.equal((await request('/api/integrations/'+connection.id+'/disconnect','POST',{},other)).status,404);
    const form=await request('/enquire?site='+connection.id,'GET',null,null);assert.equal(form.status,200);assert.equal(form.headers.get('x-frame-options'),null);assert.match(form.headers.get('content-security-policy'),/frame-ancestors https:\/\/client.example.test/);assert.equal(form.headers.get('cache-control'),'no-store');
    const info=await(await request('/api/capture/'+connection.id+'/info','GET',null,null)).json();nonce=info.nonce;
    assert.deepEqual(Object.keys(info).sort(),['name','nonce','visitsEnabled','websiteOrigin']);assert.doesNotMatch(JSON.stringify(info),/owner@|business_id|secret|token/i);
  });
  await t.test('anonymous visits have exact CORS scope and never create customers or enquiries',async()=>{
    const url='/api/capture/'+connection.id+'/visit';assert.equal((await request(url,'POST',{},null)).status,403);
    const r=await request(url,'POST',{},null,{Origin:'https://client.example.test'});assert.equal(r.status,204);assert.equal(r.headers.get('access-control-allow-origin'),'https://client.example.test');
    assert.equal((await request(url,'OPTIONS',null,null,{Origin:'https://client.example.test'})).status,204);
    assert.equal(store.list(user,'customers').length,0);assert.equal(store.list(user,'leads').length,0);
    assert.equal((await(await request('/api/integrations')).json()).websiteVisits[0].views,1);
  });
  await t.test('real form submission captures the customer, source and sanitized context exactly once',async()=>{
    const url='/api/capture/'+connection.id+'/enquiry',body={name:'Website customer',email:'customer@example.test',message:'Please quote for 50 brochures.',submissionId:'stable-submission',nonce,pageURL:'https://client.example.test/contact?secret=remove',referrer:'https://search.example.test/?q=private',campaign:'brochures'};
    assert.equal((await request(url,'POST',body,null,{Origin:'https://attacker.example'})).status,403);
    assert.equal((await request(url,'POST',{...body,nonce:'invalid'},null)).status,403);
    assert.equal((await request(url,'POST',{...body,pageURL:'https://wrong.example/contact'},null)).status,422);
    for(let n=0;n<2;n++){const r=await request(url,'POST',body,null);assert.equal(r.status,202);assert.deepEqual(await r.json(),{accepted:true});}
    assert.equal(store.list(user,'leads').length,1);assert.equal(store.list(user,'customers').length,1);lead=store.list(user,'leads')[0];
    assert.equal(lead.channel,'Website');assert.equal(lead.captured.pageURL,'https://client.example.test/contact');assert.equal(lead.captured.referrer,'https://search.example.test/');assert.equal(lead.captured.email,body.email);assert.equal(lead.message,body.message);assert.equal(lead.value,null);
    assert.equal(store.list(other,'leads').length,0);
  });
  await t.test('captured content cannot be rewritten, while assignment and follow-up details can',async()=>{
    for(const record of [{...lead,message:'Altered'},{...lead,channel:'Other'},{...lead,receivedAt:new Date().toISOString()}])assert.equal((await request('/api/records/leads/'+lead.id,'PUT',{record,version:lead.version})).status,422);
    const r=await request('/api/records/leads/'+lead.id,'PUT',{record:{...lead,notes:'Follow up tomorrow',status:'contacted',captured:{provider:'twilio'}},version:lead.version});assert.equal(r.status,200);const saved=await r.json();assert.deepEqual(saved.captured,lead.captured);assert.equal(saved.notes,'Follow up tomorrow');
    const backup=await(await request('/api/backup')).json();assert.equal(backup.records.leads[0].captured.provider,'website');assert.doesNotMatch(JSON.stringify(backup),/channel_encryption_key|channel_connections|authToken|channel_meta_app/);
  });
  await t.test('disconnect invalidates public intake without deleting captured history',async()=>{
    assert.equal((await request('/api/integrations/'+connection.id+'/disconnect','POST',{})).status,200);
    assert.equal((await request('/api/capture/'+connection.id+'/info','GET',null,null)).status,404);
    assert.equal((await request('/enquire?site='+connection.id,'GET',null,null)).status,404);assert.equal(store.list(user,'leads').length,1);
  });
});

test('captured queue preserves interactions across subscription, matching and transaction failures',async t=>{
  const f=fixture(t),c=site(f);
  await t.test('expired subscriptions queue safely and process after renewal, without orphan customers',()=>{
    f.store.db.prepare('UPDATE subscriptions SET trial_end=? WHERE business_id=?').run(Date.now()-1000,f.user.business_id);collect(f,c);
    assert.equal(f.channels.summary(f.user).pending,1);assert.equal(f.store.list(f.user,'customers').length,0);
    f.store.db.prepare('UPDATE subscriptions SET trial_end=? WHERE business_id=?').run(Date.now()+86400000,f.user.business_id);f.channels.drain(f.user.business_id);f.channels.drain(f.user.business_id);
    assert.equal(f.channels.summary(f.user).pending,0);assert.equal(f.store.list(f.user,'leads').length,1);
  });
  await t.test('conflicting contact matches require an owner to choose the customer',()=>{
    const a=f.store.saveRecord(f.user,'customers',{name:'Email match',email:'conflict@example.test'}),b=f.store.saveRecord(f.user,'customers',{name:'Phone match',phone:'+254700000002'}),foreign=f.store.saveRecord(f.other,'customers',{name:'Foreign'});
    collect(f,c,{submissionId:'conflicting-contact',email:a.email,phone:b.phone});
    const pending=f.channels.list(f.user).pending;assert.equal(pending.length,1);assert.match(pending[0].error,/different customers/);
    assert.throws(()=>f.channels.retry(f.other,pending[0].id,a.id),status(404));assert.throws(()=>f.channels.retry(f.user,pending[0].id,foreign.id),status(404));
    f.channels.retry(f.user,pending[0].id,a.id);assert.equal(f.channels.summary(f.user).pending,0);assert.equal(f.store.list(f.user,'leads').find(l=>l.captured.eventId==='conflicting-contact').customerId,a.id);
  });
  await t.test('a failed lead write rolls back the new customer and can retry the original event',()=>{
    const write=f.store.write,before=f.store.list(f.user,'customers').length;
    f.store.write=function(user,kind,...args){if(kind==='leads')throw Error('Synthetic save failure');return write.call(this,user,kind,...args);};
    collect(f,c,{submissionId:'atomic-capture',email:'new-atomic@example.test'});f.store.write=write;
    assert.equal(f.store.list(f.user,'customers').length,before);assert.equal(f.channels.summary(f.user).pending,1);
    f.channels.drain(f.user.business_id);assert.equal(f.store.list(f.user,'customers').length,before+1);assert.equal(f.channels.summary(f.user).pending,0);
  });
  await t.test('encrypted credentials, mapping and duplicate ledger survive a database reopen',()=>{
    const sealed=f.channels.seal({token:'private-provider-token'});assert.doesNotMatch(sealed,/private-provider-token/);
    const count=f.store.list(f.user,'leads').length;f.store.close();f.store=new Store(f.dir);f.analytics=new Analytics(f.store,{adminEmails:f.user.email});f.channels=new Channels(f.store,f.analytics,{publicOrigin:'https://capture.example.test'});
    assert.equal(f.channels.unseal(sealed).token,'private-provider-token');collect(f,c);assert.equal(f.store.list(f.user,'leads').length,count);
    const backup=f.store.export(f.user);f.store.restore(f.user,backup,f.store.business(f.user).revision);assert.equal(f.store.list(f.user,'leads')[0].captured.provider,'website');
  });
});

test('Meta authorization, signed messages, enrichment and workspace isolation',async t=>{
  const calls=[],f=fixture(t,{fetch:async(url,options)=>{calls.push({url,options});if(url.includes('/oauth/access_token'))return json({access_token:'synthetic-user-token'});if(url.includes('/me/accounts'))return json({data:[{id:'12345',name:'Client Page',access_token:'synthetic-page-token',instagram_business_account:{id:'54321',username:'client.business'}}]});if(url.includes('/subscribed_apps'))return json({success:true});if(url.includes('/67890?'))return json({first_name:'Customer',last_name:'One',name:'Customer One',username:'customer.one'});return json({error:{message:'Profile unavailable'}});}});
  let facebook,instagram;
  await t.test('only platform admins configure the app, and app secrets never return through read APIs',()=>{
    assert.throws(()=>f.channels.saveAdminConfig(f.other,{}),status(403));assert.throws(()=>f.channels.startMeta(f.user,'facebook'),status(503));
    const c=f.channels.saveAdminConfig(f.user,{appId:'12345678',appSecret:'synthetic-meta-secret',version:'v24.0'});assert.equal(c.secretSet,true);assert.doesNotMatch(JSON.stringify(c),/synthetic-meta-secret/);
    assert.doesNotMatch(f.store.db.prepare("SELECT value FROM platform_meta WHERE key='channel_meta_app'").get().value,/synthetic-meta-secret/);
    assert.equal(f.channels.verifyMeta({'hub.mode':'subscribe','hub.verify_token':c.verifyToken,'hub.challenge':'challenge'}),'challenge');assert.throws(()=>f.channels.verifyMeta({'hub.mode':'subscribe','hub.verify_token':'wrong','hub.challenge':'challenge'}),status(403));
  });
  await t.test('OAuth state and account selection are bound to the owner, workspace and expiry',async()=>{
    for(const provider of ['facebook','instagram']){
      const url=new URL(f.channels.startMeta(f.user,provider).url),state=url.searchParams.get('state');assert.equal(url.hostname,'www.facebook.com');assert.equal(url.searchParams.get('redirect_uri'),f.channels.origin+'/api/integrations/oauth/callback');
      await assert.rejects(f.channels.finishMeta(f.other,{state,code:'synthetic-code'}),status(403));
      await f.channels.finishMeta(f.user,{state,code:'synthetic-code'});await assert.rejects(f.channels.finishMeta(f.user,{state,code:'replay'}),status(403));
      const asset=f.channels.list(f.user).assets.find(a=>a.provider===provider);assert.doesNotMatch(JSON.stringify(asset),/synthetic-page-token/);await assert.rejects(f.channels.connectMeta(f.other,asset.id),status(404));
      const connection=await f.channels.connectMeta(f.user,asset.id);assert.equal(connection.status,'connected');if(provider==='facebook')facebook=connection;else instagram=connection;
    }
    assert.ok(calls.filter(c=>c.url.includes('/subscribed_apps')).every(c=>new URL(c.url).hostname==='graph.facebook.com'&&new URL(c.url).pathname==='/v24.0/12345/subscribed_apps'));
    const fbDiscovery=calls.find(c=>c.url.includes('/me/accounts'));assert.doesNotMatch(fbDiscovery.url,/instagram_business_account/);
    const url=new URL(f.channels.startMeta(f.user,'facebook').url);f.store.db.prepare('UPDATE channel_oauth SET expires=0').run();await assert.rejects(f.channels.finishMeta(f.user,{state:url.searchParams.get('state'),code:'expired'}),status(403));
  });
  await t.test('verified notifications capture platform and known profile without inventing private contacts',async()=>{
    for(const [provider,recipient]of [['page','12345'],['instagram','54321']]){
      const payload=notification(provider,recipient);await assert.rejects(f.channels.metaWebhook(Buffer.from(JSON.stringify(payload)),'sha256=invalid'),status(403));
      await f.channels.metaWebhook(...signed(f,payload));await f.channels.metaWebhook(...signed(f,payload));await Promise.allSettled([...f.channels.tasks]);
    }
    const leads=f.store.list(f.user,'leads');assert.equal(leads.length,2);assert.deepEqual(leads.map(l=>l.channel).sort(),['Facebook','Instagram']);
    const ig=leads.find(l=>l.channel==='Instagram');assert.equal(ig.captured.handle,'customer.one');assert.equal(ig.captured.name,'Customer One');assert.equal(ig.captured.email,'');assert.equal(ig.captured.phone,'');assert.equal(f.store.list(f.other,'leads').length,0);
    const echo=notification('page','12345','echo','67890',{is_echo:true}),unknown=notification('page','99999','unrelated');await f.channels.metaWebhook(...signed(f,echo));await f.channels.metaWebhook(...signed(f,unknown));assert.equal(f.store.list(f.user,'leads').length,2);
    await f.channels.metaWebhook(...signed(f,notification('page','12345','unknown-profile','88888')));await Promise.allSettled([...f.channels.tasks]);const fallback=f.store.list(f.user,'leads').find(l=>l.captured.senderId==='88888');assert.equal(fallback.captured.name,'');assert.equal(fallback.captured.handle,'');
  });
  await t.test('another workspace cannot claim an already connected social resource; changed app credentials require reconnect',async()=>{
    assert.throws(()=>f.channels.reserve(f.other,'facebook',facebook.externalId,'Other',{},{}),status(409));
    const before=f.store.list(f.user,'leads').length;await f.channels.disconnect(f.user,instagram.id);assert.ok(!calls.some(c=>c.options.method==='DELETE'),'the remaining Facebook connection keeps its Page subscription');await f.channels.metaWebhook(...signed(f,notification('instagram','54321','after-disconnect')));assert.equal(f.store.list(f.user,'leads').length,before);
    f.channels.saveAdminConfig(f.user,{appId:'12345678',appSecret:'synthetic-new-meta-secret',version:'v24.0'});assert.equal(f.channels.get(f.user,facebook.id).status,'reconnect_required');await f.channels.metaWebhook(...signed(f,notification('page','12345','after-key-change')));assert.equal(f.store.list(f.user,'leads').length,before);
  });
});

test('Twilio number ownership, SDK signature verification and call lifecycle',async t=>{
  const accountSid='AC'+'1'.repeat(32),numberSid='PN'+'2'.repeat(32),authToken='3'.repeat(32),calls=[];
  let callback='https://previous.example.test/status';
  const f=fixture(t,{fetch:async(url,options)=>{calls.push({url,options});if(options.method==='POST')callback=new URLSearchParams(options.body).get('StatusCallback');return json({account_sid:accountSid,sid:numberSid,phone_number:'+254700000001',friendly_name:'Business number',status_callback:callback});}});
  let c,base,url;
  await t.test('connecting verifies number ownership, encrypts the token and configures only status callbacks',async()=>{
    c=await f.channels.twilio(f.user,{accountSid,numberSid,authToken});assert.equal(c.status,'connected');assert.doesNotMatch(JSON.stringify(c),new RegExp(authToken));
    const update=calls.find(c=>c.options.method==='POST');assert.deepEqual([...new URLSearchParams(update.options.body).keys()].sort(),['StatusCallback','StatusCallbackMethod']);
    await assert.rejects(f.channels.twilio(f.other,{accountSid,numberSid,authToken}),status(409));
    base={AccountSid:accountSid,CallSid:'CA'+'4'.repeat(32),From:'+254700000002',To:c.phone,Direction:'inbound',CallStatus:'ringing',FutureProviderField:'signed-too'};url=c.callbackURL;
  });
  await t.test('all form fields and the exact URL are signed; forged accounts or destinations are denied',()=>{
    const signature=getExpectedTwilioSignature(authToken,url,base);
    assert.throws(()=>f.channels.twilioWebhook(c.id,base,'invalid',url),status(403));
    assert.throws(()=>f.channels.twilioWebhook(c.id,{...base,FutureProviderField:'tampered'},signature,url),status(403));
    assert.throws(()=>f.channels.twilioWebhook(c.id,base,signature,url+'?query=changed'),status(403));
    for(const params of [{...base,AccountSid:'AC'+'5'.repeat(32)},{...base,To:'+254700000009'}])assert.throws(()=>f.channels.twilioWebhook(c.id,params,getExpectedTwilioSignature(authToken,url,params),url),status(403));
    assert.equal(f.store.list(f.user,'leads').length,0);
  });
  await t.test('inbound call updates use one enquiry, preserve follow-ups and keep unknown duration null',()=>{
    const deliver=params=>f.channels.twilioWebhook(c.id,params,getExpectedTwilioSignature(authToken,url,params),url);deliver(base);
    let lead=f.store.list(f.user,'leads')[0];assert.equal(lead.captured.callDuration,null);assert.equal(lead.captured.phone,base.From);assert.equal(lead.channel,'Phone');assert.equal(lead.captured.email,'');
    f.store.saveRecord(f.user,'leads',{...lead,status:'contacted',notes:'Call back next week'},lead.id,lead.version);
    deliver({...base,CallStatus:'completed',CallDuration:'42'});deliver({...base,CallStatus:'completed',CallDuration:'42'});deliver(base);
    assert.equal(f.store.list(f.user,'leads').length,1);lead=f.store.list(f.user,'leads')[0];assert.equal(lead.captured.callStatus,'completed');assert.equal(lead.captured.callDuration,42);assert.equal(lead.notes,'Call back next week');assert.equal(lead.status,'contacted');
    deliver({...base,CallSid:'CA'+'6'.repeat(32),Direction:'outbound-api'});assert.equal(f.store.list(f.user,'leads').length,1);
    deliver({...base,CallSid:'CA'+'7'.repeat(32),From:'anonymous',CallStatus:'completed'});assert.equal(f.store.list(f.user,'leads').length,2);assert.equal(f.store.list(f.user,'leads').find(l=>l.captured.senderId==='CA'+'7'.repeat(32)).captured.phone,'');
  });
  await t.test('disconnect restores the old status callback, erases saved credentials and rejects new delivery',async()=>{
    await f.channels.disconnect(f.user,c.id);assert.equal(callback,'https://previous.example.test/status');assert.deepEqual(f.channels.unseal(f.channels.get(f.user,c.id).secrets),{});assert.throws(()=>f.channels.twilioWebhook(c.id,base,getExpectedTwilioSignature(authToken,url,base),url),status(403));
  });
});
