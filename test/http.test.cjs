const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createApplication}=require('../server');
test('HTTP authentication, permissions, CSRF, failures, PDFs, and backups',async t=>{
  const errors=[];
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'profitpulse-http-')),app=createApplication({dataDir:dir,startTimers:false,logger:{error:(...args)=>errors.push(args)}});
  await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve);});
  const origin='http://127.0.0.1:'+app.server.address().port;
  t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
  let cookie='',csrf='';
  async function request(route,method='GET',data,extra={}){
    return fetch(origin+'/api'+route,{method,headers:{Origin:origin,...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{}),...(data?{'Content-Type':'application/json'}:{}),...extra},body:data?JSON.stringify(data):undefined});
  }
  await t.test('unauthenticated records are denied and initial setup uses a secure session',async()=>{
    assert.equal((await request('/bootstrap')).status,401);
    const setup=await request('/setup','POST',{businessName:'HTTP Test',name:'Owner',email:'http@example.test',password:'http-test-password-2026'});
    assert.equal(setup.status,200);cookie=setup.headers.get('set-cookie').split(';')[0];csrf=(await setup.json()).csrf;
    assert.match(setup.headers.get('set-cookie'),/HttpOnly/);assert.match(setup.headers.get('set-cookie'),/SameSite=Lax/);
    assert.equal((await request('/setup','POST',{})).status,409);
  });
  await t.test('wrong origins and missing CSRF tokens are blocked',async()=>{
    assert.equal((await request('/records/customers','POST',{name:'Blocked'},{Origin:'https://attacker.example'})).status,403);
    assert.equal((await request('/records/customers','POST',{name:'Blocked'},{'X-CSRF-Token':''})).status,403);
    assert.equal(app.store.db.prepare('SELECT COUNT(*) AS n FROM records').get().n,0);
  });
  let customer,quote;
  await t.test('record writes validate, persist, and reject conflicts',async()=>{
    assert.equal((await request('/records/customers','POST',{name:' '})).status,422);
    const response=await request('/records/customers','POST',{name:'Réne Test',email:'customer@example.test'});
    assert.equal(response.status,201);customer=await response.json();
    assert.equal((await request('/records/customers/'+customer.id,'PUT',{record:{...customer,notes:'Saved'},version:customer.version})).status,200);
    assert.equal((await request('/records/customers/'+customer.id,'PUT',{record:{...customer,notes:'Stale'},version:customer.version})).status,409);
    assert.equal((await(await request('/records/customers/'+customer.id)).json()).notes,'Saved');
  });
  await t.test('PDF endpoint returns a real downloadable quote without internal costs',async()=>{
    const input={customerId:customer.id,items:[{description:'Printed brochures',quantity:10,unitPrice:200,unitCost:80}],labour:100,transport:0,overhead:0,discountPercent:5,taxPercent:16,feePercent:1,fixedFee:0,targetMargin:25,issuedOn:'2026-10-14',expiresOn:'2026-10-28',status:'accepted',terms:'Payment within 14 days'};
    quote=await(await request('/records/quotes','POST',input)).json();
    const response=await request('/records/quotes/'+quote.id+'/pdf');
    assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'application/pdf');
    assert.match(response.headers.get('content-disposition'),/QUO-00001\.pdf/);
    const bytes=Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.subarray(0,5).toString(),'%PDF-');assert.ok(bytes.length>5000);
    assert.equal((bytes.toString('latin1').match(/\/Type \/Page\b/g)||[]).length,1);
  });
  await t.test('backup preview is read only and restore requires a fresh revision',async()=>{
    const response=await request('/backup');assert.equal(response.status,200);
    const backup=await response.json(),revision=(await(await request('/bootstrap')).json()).business.revision;
    const preview=await request('/restore/preview','POST',{backup});assert.equal(preview.status,200);
    assert.equal((await preview.json()).counts.quotes,1);
    await request('/records/customers','POST',{name:'Changed after preview'});
    assert.equal((await request('/restore','POST',{backup,revision})).status,409);
  });
  await t.test('storage errors return a failure status and preserve existing data',async()=>{
    const original=app.store.write;
    app.store.write=()=>{throw Error('Simulated disk failure');};
    const response=await request('/records/customers','POST',{name:'Cannot save'});
    assert.equal(response.status,500);assert.match((await response.json()).error,/could not be saved/);
    assert.equal(errors.length,1);
    app.store.write=original;
    assert.equal(app.store.list({business_id:app.store.db.prepare('SELECT id FROM businesses').get().id},'customers').length,2);
  });
  await t.test('staff cannot export backups or alter business permissions over HTTP',async()=>{
    const added=await request('/users','POST',{name:'Staff',email:'staff-http@example.test',password:'staff-http-password-2026',role:'staff'});assert.equal(added.status,201);
    const login=await request('/login','POST',{email:'staff-http@example.test',password:'staff-http-password-2026'});cookie=login.headers.get('set-cookie').split(';')[0];csrf=(await login.json()).csrf;
    assert.equal((await request('/backup')).status,403);assert.equal((await request('/users','POST',{})).status,403);
    assert.equal((await request('/records/customers','POST',{name:'Staff record'})).status,201);
    assert.equal((await request('/logout','POST')).status,200);assert.equal((await request('/bootstrap')).status,401);
  });
});
