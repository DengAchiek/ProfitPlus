import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unstable_dev } from 'wrangler';
import Stripe from 'stripe';
import { createHash } from 'node:crypto';

test('Cloudflare runtime: public routing, sessions, tenant and team access, PDFs, recovery, persistence', { timeout: 120000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profitplus-worker-'));
  const origin = 'http://127.0.0.1:8787';
  let adminEmails='';
  const start = (vars = {}) => unstable_dev('cloudflare/worker.mjs', {
    config: 'wrangler.jsonc', ip: '127.0.0.1', port: 0, local: true,
    persist: true, persistTo: dir, logLevel: 'error',
    vars: { PUBLIC_ORIGIN: origin, PLATFORM_ADMIN_EMAILS:'', PLATFORM_ADMIN_EMAIL_SHA256:adminEmails?createHash('sha256').update(adminEmails).digest('hex'):'', PLATFORM_ADMIN_SETUP_TOKEN_SHA256:'',PLATFORM_ADMIN_SETUP_EMAIL_SHA256:'',PLATFORM_ADMIN_SETUP_EXPIRES_AT:'',PLATFORM_ADMIN_SETUP_MODE:'create', ...vars },
    experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false },
  });
  let worker = await start();
  t.after(async () => { await worker?.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const request = (route, method = 'GET', data, session = {}, extra = {}) => worker.fetch(origin + route, {
    method,
    headers: { Origin: origin, ...(data ? { 'Content-Type': 'application/json' } : {}),
      ...(session.cookie ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrf } : {}), ...extra },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  async function session(response) {
    assert.equal(response.status, 200, await response.clone().text());
    const cookie = response.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Lax/);
    return { cookie: cookie.split(';')[0], ...(await response.json()) };
  }
  const account = suffix => ({ businessName: 'Worker QA ' + suffix, name: 'Owner ' + suffix,
    email: suffix + '@example.test', password: 'synthetic-worker-password', currency: 'KES', timezone: 'Africa/Nairobi' });
  let owner, other, staff, customer, quote, direct, converted;
  await t.test('root is public and application routes load without static redirects', async () => {
    for (const route of ['/', '/index.html', '/login', '/signup', '/app', '/forgot-password', '/reset-password', '/password-reset.js', '/landing.css', '/app.js']) {
      const response = await request(route);
      assert.equal(response.status, 200, route); assert.equal(response.headers.get('location'), null);
    }
    assert.match(await (await request('/')).text(), /More clarity/);
    assert.match(await (await request('/signup')).text(), /id="auth"/);
    assert.equal((await request('/api/bootstrap')).status, 401);
    assert.deepEqual(await (await request('/api/status')).json(), { needsSetup: true });
    assert.equal((await (await request('/api/plans')).json()).plans.length, 3);
    assert.equal((await request('/missing')).status, 404);
    assert.deepEqual(await(await request('/api/password/status')).json(),{available:false});
    assert.equal((await request('/api/password/forgot','POST',{email:'unknown@example.test'})).status,503);
    const recoveryPage=await request('/reset-password');assert.equal(recoveryPage.headers.get('cache-control'),'no-store');assert.equal(recoveryPage.headers.get('referrer-policy'),'no-referrer');
  });
  await t.test('signup and login create independent persistent sessions', async () => {
    owner = await session(await request('/api/register', 'POST', account('owner')));
    other = await session(await request('/api/register', 'POST', account('other')));
    const boot = await (await request('/api/bootstrap', 'GET', null, owner)).json();
    assert.equal(boot.user.role, 'owner'); assert.equal(boot.business.currency, 'KES');
    assert.equal(boot.backupStatus.mode, 'cloudflare'); assert.equal(boot.subscription.canWrite, true);
    assert.equal((await request('/api/register', 'POST', account('owner'))).status, 409);
    assert.equal((await request('/api/login', 'POST', { email: account('owner').email, password: 'incorrect' })).status, 401);
    customer = await (await request('/api/records/customers', 'POST', { name: 'Worker Customer', email: 'customer@example.test' }, owner)).json();
    assert.ok(customer.id);
    assert.equal((await request('/api/records/customers/' + customer.id, 'GET', null, other)).status, 404);
    const separate = await (await request('/api/bootstrap', 'GET', null, other)).json();
    assert.equal(separate.records.customers.length, 0);
  });
  await t.test('origin, CSRF and team permissions are enforced by the shared backend', async () => {
    assert.equal((await request('/api/records/customers', 'POST', { name: 'Blocked' }, owner, { Origin: 'https://attacker.example' })).status, 403);
    assert.equal((await request('/api/records/customers', 'POST', { name: 'Blocked' }, owner, { 'X-CSRF-Token': '' })).status, 403);
    const added = await request('/api/users', 'POST', { name: 'Staff', email: 'staff@example.test', password: 'synthetic-staff-password', role: 'staff' }, owner);
    assert.equal(added.status, 201); const user = await added.json();
    staff = await session(await request('/api/login', 'POST', { email: user.email, password: 'synthetic-staff-password' }));
    assert.equal((await request('/api/records/customers/' + customer.id, 'GET', null, staff)).status, 200);
    assert.equal((await request('/api/backup', 'GET', null, staff)).status, 403);
    assert.equal((await request('/api/users', 'POST', {}, staff)).status, 403);
    assert.equal((await request('/api/records/customers', 'POST', { name: 'X'.repeat(310000) }, owner)).status, 413);
    assert.equal((await request('/api/users/' + user.id, 'PUT', { active: false, role: 'staff' }, owner)).status, 200);
    assert.equal((await request('/api/bootstrap', 'GET', null, staff)).status, 401);
    assert.equal((await request('/api/login', 'POST', { email: user.email, password: 'synthetic-staff-password' })).status, 401);
  });
  await t.test('platform admin configuration protects cross-workspace analytics and persists usage',async()=>{
    assert.equal((await request('/api/admin/dashboard','GET',null,owner)).status,403);
    await worker.stop();adminEmails=account('owner').email;worker=await start();
    const boot=await(await request('/api/bootstrap','GET',null,owner)).json();assert.equal(boot.platformAdmin,true);
    assert.equal((await(await request('/api/bootstrap','GET',null,other)).json()).platformAdmin,false);
    for(const route of ['/api/admin/dashboard','/api/admin/users','/api/admin/users/'+owner.user.id]){
      assert.equal((await request(route)).status,401);assert.equal((await request(route,'GET',null,other)).status,403);assert.equal((await request(route,'GET',null,owner)).status,200);
    }
    const pulse={module:'invoices',tabId:'worker-synthetic-tab',sequence:1,activeSeconds:0,view:true};
    assert.equal((await request('/api/telemetry','POST',pulse,other,{'X-CSRF-Token':''})).status,403);
    assert.equal((await request('/api/telemetry','POST',pulse,other)).status,200);
    const profile=await(await request('/api/admin/users/'+other.user.id,'GET',null,owner)).json();assert.equal(profile.services[0].visits,1);
    assert.doesNotMatch(JSON.stringify(profile),/password|csrf|token/);
    const summary=await(await request('/api/admin/dashboard?days=7','GET',null,owner)).json();assert.equal(summary.totals.registeredUsers,2);assert.equal(summary.totals.activeUsers,1);assert.ok(summary.performance.requests>0);
    assert.equal((await request('/api/register','POST',account('owner'))).status,422);
    assert.equal(boot.records,undefined);assert.equal(boot.subscription,undefined);
    for(const [route,method] of [['/api/records/customers/'+customer.id,'GET'],['/api/records/customers','POST'],['/api/backup','GET'],['/api/billing','GET'],['/api/integrations','GET']])assert.equal((await request(route,method,method==='POST'?{name:'Blocked admin'}:null,owner)).status,403);
    const clients=await(await request('/api/admin/clients','GET',null,owner)).json();assert.equal(clients.total,2);
    await worker.stop();adminEmails='';worker=await start();
  });
  await t.test('quote PDFs embed the bundled fonts without a local filesystem', async () => {
    const response = await request('/api/records/quotes', 'POST', { customerId: customer.id, currency: 'KES',
      items: [{ description: 'Worker service', quantity: 1, unitPrice: 1000, unitCost: 200 }],
      issuedOn: '2026-10-15', expiresOn: '2026-10-29', status: 'draft' }, owner);
    assert.equal(response.status, 201); quote = await response.json();
    const pdf = await request('/api/records/quotes/' + quote.id + '/pdf', 'GET', null, owner);
    assert.equal(pdf.status, 200, await pdf.clone().text());
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    const bytes = Buffer.from(await pdf.arrayBuffer());
    assert.equal(bytes.subarray(0, 5).toString(), '%PDF-'); assert.ok(bytes.length > 5000);
  });
  await t.test('direct and quotation-based invoices share numbering, PDFs, payments and tenant protection', async () => {
    const input={customerId:customer.id,currency:'KES',quote:{currency:'KES',items:[{description:'Direct invoice service',quantity:2,unitPrice:250,unitCost:50}],discountPercent:10,taxPercent:16},issuedOn:'2026-10-16',dueOn:'2026-10-30',status:'open',terms:'Pay within 14 days.'};
    const response=await request('/api/records/invoices','POST',input,owner);
    assert.equal(response.status,201,await response.clone().text());direct=await response.json();
    assert.equal(direct.quoteId,null);assert.equal(direct.number,'INV-00001');
    assert.equal((await request('/api/records/invoices/'+direct.id,'GET',null,other)).status,404);
    const pdf=await request('/api/records/invoices/'+direct.id+'/pdf','GET',null,owner);
    assert.equal(pdf.status,200);assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0,5).toString(),'%PDF-');
    const payment={invoiceId:direct.id,amount:222,fee:0,direction:'receipt',method:'Bank',paidOn:'2026-10-16'};
    assert.equal((await request('/api/records/payments','POST',payment,owner)).status,201);
    assert.equal((await request('/api/records/payments','POST',{...payment,amount:301},owner)).status,422);
    const accepted=await request('/api/records/quotes/'+quote.id,'PUT',{record:{...quote,status:'accepted'},version:quote.version},owner);
    assert.equal(accepted.status,200);quote=await accepted.json();
    const conversion=await request('/api/records/invoices','POST',{quoteId:quote.id,customerId:'untrusted',currency:'USD',quote:{items:[]},issuedOn:'2026-10-16',dueOn:'2026-10-30',status:'open'},owner);
    assert.equal(conversion.status,201,await conversion.clone().text());converted=await conversion.json();
    assert.equal(converted.number,'INV-00002');assert.equal(converted.currency,'KES');assert.equal(converted.customerId,customer.id);assert.equal(converted.quote.items[0].unitPrice,1000);
    assert.equal((await request('/api/records/invoices','POST',{quoteId:quote.id,issuedOn:'2026-10-16',dueOn:'2026-10-30',status:'open'},owner)).status,409);
  });
  await t.test('restore safety copies are persistent and scoped to their business', async () => {
    for (let n = 0; n < 35; n++) {
      assert.equal((await request('/api/records/customers', 'POST', { name: 'Unicode customer ' + n, notes: '🧩'.repeat(2000) }, owner)).status, 201);
    }
    const backup = await (await request('/api/backup', 'GET', null, owner)).json();
    assert.equal((await request('/api/restore/preview', 'POST', { backup }, owner)).status, 200);
    const boot = await (await request('/api/bootstrap', 'GET', null, owner)).json();
    assert.equal(boot.platformAdmin,false);
    assert.equal((await request('/api/admin/users/'+other.user.id,'GET',null,owner)).status,403);
    const result = await request('/api/restore', 'POST', { backup, revision: boot.business.revision }, owner);
    assert.equal(result.status, 200); const { safetyFile } = await result.json();
    const copies = await (await request('/api/backups', 'GET', null, owner)).json();
    assert.deepEqual(copies.backups, [safetyFile]);
    const copy = await request('/api/backups/' + safetyFile, 'GET', null, owner);
    assert.equal(copy.status, 200);
    const safety = await copy.json();
    assert.deepEqual(safety.records, backup.records); assert.deepEqual(safety.business, backup.business);
    assert.equal((await request('/api/backups/' + safetyFile, 'GET', null, other)).status, 404);
  });
  await t.test('sessions, records, safety copies and throttling survive a Worker restart', async () => {
    const limitedIP = { 'CF-Connecting-IP': '192.0.2.8' };
    for (let n = 0; n < 10; n++) assert.equal((await request('/api/login', 'POST', { email: 'unknown@example.test', password: 'incorrect' }, {}, limitedIP)).status, 401);
    await worker.stop(); worker = await start();
    const boot = await (await request('/api/bootstrap', 'GET', null, owner)).json();
    assert.ok(boot.records.customers.some(record => record.id === customer.id));
    assert.equal(boot.records.quotes[0].id, quote.id);
    assert.equal(boot.records.invoices.length,2);assert.ok(boot.records.invoices.some(i=>i.id===direct.id && i.quoteId===null));
    assert.ok(boot.records.invoices.some(i=>i.id===converted.id && i.quoteId===quote.id));assert.equal(boot.records.payments[0].amount,222);
    assert.equal((await (await request('/api/backups', 'GET', null, owner)).json()).backups.length, 1);
    assert.equal((await request('/api/login', 'POST', { email: 'unknown@example.test', password: 'incorrect' }, {}, limitedIP)).status, 429);
    const login = await session(await request('/api/login', 'POST', { email: account('owner').email, password: account('owner').password }));
    assert.equal((await request('/api/logout', 'POST', null, login)).status, 200);
    assert.equal((await request('/api/bootstrap', 'GET', null, login)).status, 401);
  });
  await t.test('configured webhooks verify signatures in the Worker without a charge or network call', async () => {
    await worker.stop();
    const secret = 'whsec_synthetic_worker';
    worker = await start({ STRIPE_SECRET_KEY: 'sk_test_synthetic', STRIPE_WEBHOOK_SECRET: secret,
      STRIPE_PRICES_JSON: JSON.stringify({ starter: { USD: { month: 'price_synthetic' } } }) });
    const payload = { id: 'evt_worker', type: 'product.created', data: { object: { id: 'prod_synthetic' } } };
    assert.equal((await request('/api/billing/webhook', 'POST', payload, {}, { 'Stripe-Signature': 'invalid' })).status, 400);
    const signature = new Stripe('sk_test_synthetic').webhooks.generateTestHeaderString({ payload: JSON.stringify(payload), secret });
    const response = await request('/api/billing/webhook', 'POST', payload, {}, { 'Stripe-Signature': signature });
    assert.equal(response.status, 200, await response.clone().text()); assert.deepEqual(await response.json(), { ignored: true });
  });
  await t.test('an unregistered reserved admin can claim an expiring invitation once, across restarts',async()=>{
    const target='setup-admin@example.test',code='c3'.repeat(32),hash=value=>createHash('sha256').update(value).digest('hex');
    const vars={PLATFORM_ADMIN_EMAIL_SHA256:hash(target),PLATFORM_ADMIN_SETUP_EMAIL_SHA256:hash(target),PLATFORM_ADMIN_SETUP_TOKEN_SHA256:hash(code),PLATFORM_ADMIN_SETUP_EXPIRES_AT:new Date(Date.now()+3600000).toISOString()};
    await worker.stop();worker=await start(vars);
    assert.equal((await request('/admin/setup')).status,200);
    assert.deepEqual(await(await request('/api/admin-setup/status')).json(),{available:true,recovery:false});
    const input={name:'Invited administrator',email:target,password:'synthetic-invited-password',setupCode:code};
    assert.equal((await request('/api/register','POST',{...input,businessName:'Blocked claim'})).status,422);
    assert.equal((await request('/api/admin-setup','POST',{...input,setupCode:'d4'.repeat(32)})).status,403);
    const response=await request('/api/admin-setup','POST',input);assert.equal(response.status,201,await response.clone().text());
    const session={cookie:response.headers.get('set-cookie').split(';')[0],...(await response.json())};
    assert.equal((await(await request('/api/bootstrap','GET',null,session)).json()).platformAdmin,true);
    assert.equal((await request('/api/admin/dashboard','GET',null,session)).status,200);
    assert.equal((await request('/api/admin/dashboard','GET',null,owner)).status,403);
    await worker.stop();worker=await start(vars);
    assert.deepEqual(await(await request('/api/admin-setup/status')).json(),{available:false,recovery:false});
    assert.equal((await request('/api/admin-setup','POST',input)).status,403);
    assert.equal((await request('/api/admin/dashboard','GET',null,session)).status,200);
    const customerResponse=await request('/api/records/customers','POST',{name:'Blocked admin customer'},session);assert.equal(customerResponse.status,403);
    const recoveryCode='e5'.repeat(32);
    const recoveryVars={...vars,PLATFORM_ADMIN_SETUP_TOKEN_SHA256:hash(recoveryCode),PLATFORM_ADMIN_SETUP_MODE:'recover'};
    await worker.stop();worker=await start(recoveryVars);
    assert.deepEqual(await(await request('/api/admin-setup/status')).json(),{available:true,recovery:true});
    assert.equal((await request('/api/admin-setup','POST',input)).status,403,'old invitation is no longer valid');
    const recovery=await request('/api/admin-setup','POST',{...input,name:'Recovered administrator',password:'fresh-private-admin-password',setupCode:recoveryCode});
    assert.equal(recovery.status,201,await recovery.clone().text());
    const recoveredSession={cookie:recovery.headers.get('set-cookie').split(';')[0],...(await recovery.json())};
    assert.equal(recoveredSession.user.id,session.user.id);
    assert.equal((await request('/api/bootstrap','GET',null,session)).status,401);
    assert.equal((await request('/api/records/customers/'+customer.id,'GET',null,recoveredSession)).status,403);
    assert.equal((await(await request('/api/records/customers/'+customer.id,'GET',null,owner)).json()).name,customer.name);
    assert.equal((await request('/api/login','POST',{email:target,password:input.password})).status,401);
    assert.equal((await request('/api/login','POST',{email:target,password:'fresh-private-admin-password'})).status,200);
    await worker.stop();worker=await start(recoveryVars);
    assert.deepEqual(await(await request('/api/admin-setup/status')).json(),{available:false,recovery:true});
    assert.equal((await request('/api/admin-setup','POST',{...input,setupCode:recoveryCode})).status,403);
    assert.equal((await request('/api/admin/dashboard','GET',null,recoveredSession)).status,200);
    assert.equal((await request('/api/admin/email-settings','GET',null,owner)).status,403);
    const emailSettings=await request('/api/admin/email-settings','PUT',{apiKey:'re_synthetic_worker_key_12345',fromAddress:'accounts@example.test'},recoveredSession);
    assert.equal(emailSettings.status,200,await emailSettings.clone().text());assert.equal((await emailSettings.json()).ready,true);
    assert.deepEqual(await(await request('/api/password/status')).json(),{available:true});
    const unknown=await request('/api/password/forgot','POST',{email:'not-a-registered-user@example.test'});assert.equal(unknown.status,202);assert.doesNotMatch(await unknown.text(),/token|key|not-a-registered-user/);
    assert.equal((await request('/api/password/validate','POST',{token:'a'.repeat(64)})).status,400);
    assert.equal((await request('/api/password/reset','POST',{token:'a'.repeat(64),newPassword:'synthetic-new-password',confirmPassword:'synthetic-new-password'}, {}, {Origin:'https://attacker.example'})).status,403);
    await worker.stop();worker=await start(recoveryVars);
    const persisted=await(await request('/api/admin/email-settings','GET',null,recoveredSession)).json();assert.equal(persisted.ready,true);assert.equal(persisted.fromAddress,'accounts@example.test');assert.doesNotMatch(JSON.stringify(persisted),/re_synthetic|token/);
  });
  await t.test('connected website intake, framing policy, tenant isolation and duplicate ledger survive a Worker restart',async()=>{
    const connected=await request('/api/integrations/website','POST',{websiteOrigin:'https://worker-client.example.test',label:'Worker website',visitsEnabled:true},owner);
    assert.equal(connected.status,201,await connected.clone().text());const connection=await connected.json();
    const info=await(await request('/api/capture/'+connection.id+'/info')).json();
    const form=await request('/enquire?site='+connection.id);assert.equal(form.status,200);assert.equal(form.headers.get('x-frame-options'),null);assert.match(form.headers.get('content-security-policy'),/frame-ancestors https:\/\/worker-client.example.test/);
    const input={name:'Worker inbound customer',email:'inbound@example.test',message:'Please send a service quotation.',submissionId:'worker-submission',nonce:info.nonce,pageURL:'https://worker-client.example.test/contact'};
    assert.equal((await request('/api/records/leads','POST',input,owner)).status,403);
    assert.equal((await request('/api/capture/'+connection.id+'/enquiry','POST',input)).status,202);
    let boot=await(await request('/api/bootstrap','GET',null,owner)).json();const captured=boot.records.leads.find(l=>l.captured?.eventId===input.submissionId);assert.ok(captured);assert.equal(captured.channel,'Website');assert.equal(captured.captured.email,input.email);
    assert.equal((await(await request('/api/bootstrap','GET',null,other)).json()).records.leads.length,0);
    assert.equal((await request('/api/records/leads/'+captured.id,'PUT',{record:{...captured,message:'Altered'},version:captured.version},owner)).status,422);
    const visit=await request('/api/capture/'+connection.id+'/visit','POST',{}, {}, {Origin:'https://worker-client.example.test'});assert.equal(visit.status,204);assert.equal(visit.headers.get('access-control-allow-origin'),'https://worker-client.example.test');
    await worker.stop();worker=await start();
    assert.equal((await request('/api/capture/'+connection.id+'/enquiry','POST',input)).status,202);
    boot=await(await request('/api/bootstrap','GET',null,owner)).json();assert.equal(boot.records.leads.filter(l=>l.captured?.eventId===input.submissionId).length,1);
    const connections=await(await request('/api/integrations','GET',null,owner)).json();assert.equal(connections.websiteVisits[0].views,1);assert.equal(connections.connections[0].status,'connected');
  });
});
