import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unstable_dev } from 'wrangler';
import Stripe from 'stripe';

test('Cloudflare runtime: public routing, sessions, tenant and team access, PDFs, recovery, persistence', { timeout: 120000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profitplus-worker-'));
  const origin = 'http://127.0.0.1:8787';
  const start = (vars = {}) => unstable_dev('cloudflare/worker.mjs', {
    config: 'wrangler.jsonc', ip: '127.0.0.1', port: 0, local: true,
    persist: true, persistTo: dir, logLevel: 'error',
    vars: { PUBLIC_ORIGIN: origin, ...vars },
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
  let owner, other, staff, customer, quote;
  await t.test('root is public and application routes load without static redirects', async () => {
    for (const route of ['/', '/index.html', '/login', '/signup', '/app', '/landing.css', '/app.js']) {
      const response = await request(route);
      assert.equal(response.status, 200, route); assert.equal(response.headers.get('location'), null);
    }
    assert.match(await (await request('/')).text(), /More clarity/);
    assert.match(await (await request('/signup')).text(), /id="auth"/);
    assert.equal((await request('/api/bootstrap')).status, 401);
    assert.deepEqual(await (await request('/api/status')).json(), { needsSetup: true });
    assert.equal((await (await request('/api/plans')).json()).plans.length, 3);
    assert.equal((await request('/missing')).status, 404);
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
  await t.test('restore safety copies are persistent and scoped to their business', async () => {
    for (let n = 0; n < 35; n++) {
      assert.equal((await request('/api/records/customers', 'POST', { name: 'Unicode customer ' + n, notes: '🧩'.repeat(2000) }, owner)).status, 201);
    }
    const backup = await (await request('/api/backup', 'GET', null, owner)).json();
    assert.equal((await request('/api/restore/preview', 'POST', { backup }, owner)).status, 200);
    const boot = await (await request('/api/bootstrap', 'GET', null, owner)).json();
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
});
