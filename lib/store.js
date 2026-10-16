'use strict';
const { DatabaseSync, backup } = require('node:sqlite');
const { randomUUID, randomBytes, scryptSync, timingSafeEqual, createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const D = require('../dist/logic.js');
const { PLANS, TRIAL_DAYS } = require('./plans');

class AppError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new AppError(status, message); };
const hashToken = value => createHash('sha256').update(value).digest('hex');
function passwordHash(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) fail(422, 'Use a password of 12–256 characters.');
  const salt = randomBytes(16).toString('hex');
  return salt + ':' + scryptSync(password, salt, 64).toString('hex');
}
function checkPassword(password, encoded) {
  if (typeof password !== 'string' || password.length > 256) return false;
  const [salt, key] = encoded.split(':');
  return timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(key, 'hex'));
}
const defaults = { name: '', address: '', phone: '', email: '', taxId: '', terms: 'Payment is due by the stated date.', currency: 'USD', locale: 'en-US', timezone: 'UTC', responseHours: 24 };
function settings(input) {
  const out = { ...defaults };
  for (const field of ['name', 'address', 'phone', 'email', 'taxId', 'terms', 'timezone']) {
    if (input[field] !== undefined) out[field] = DText(input[field], field, field === 'terms' ? 3000 : 500, field === 'name');
  }
  if (!out.name) fail(422, 'Business name is required.');
  try { out.currency = D.currency(input.currency || defaults.currency); } catch(error) { fail(422,error.message); }
  out.locale = input.locale || defaults.locale;
  try { if(typeof out.locale !== 'string' || out.locale.length > 50) throw Error(); out.locale=Intl.getCanonicalLocales(out.locale)[0]; new Intl.NumberFormat(out.locale).format(1); } catch { fail(422,'Choose a valid number/date locale.'); }
  try { new Intl.DateTimeFormat('en', { timeZone: out.timezone }).format(); } catch { fail(422, 'Choose a valid IANA timezone.'); }
  out.responseHours = Number(input.responseHours ?? 24);
  if (!Number.isFinite(out.responseHours) || out.responseHours < 1 || out.responseHours > 720) fail(422, 'Response target must be 1–720 hours.');
  return out;
}
function DText(value, name, max, required = true) {
  if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim())) fail(422, 'Enter a valid ' + name + '.');
  return value.trim();
}
function email(value) {
  const result = DText(value, 'email', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) fail(422, 'Enter a valid email.');
  return result;
}
const publicUser = row => ({ id: row.id, name: row.name, email: row.email, role: row.role, active: !!row.active });

class Store {
  constructor(dataDir, options = {}) {
    this.dataDir = dataDir;
    let dbPath;
    if (options.database) {
      this.db = options.database;
    } else {
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      this.backupDir = path.join(dataDir, 'backups');
      fs.mkdirSync(this.backupDir, { recursive: true, mode: 0o700 });
      dbPath = path.join(dataDir, 'profitpulse.sqlite');
      this.db = new DatabaseSync(dbPath, { timeout: 5000 });
    }
    const schemaVersion = options.database ? options.schemaVersion : this.db.prepare('PRAGMA user_version').get().user_version;
    if (![0, 2, 3].includes(schemaVersion)) { this.db.close(); throw Error('Unsupported database version. Preserve this data directory and use a compatible application version.'); }
    if (schemaVersion === 2) {
      const snapshot=path.join(this.backupDir,'pre-saas-v2-'+Date.now()+'.sqlite');
      this.db.prepare('VACUUM INTO ?').run(snapshot); fs.chmodSync(snapshot,0o600);
      const check=new DatabaseSync(snapshot,{readOnly:true});
      try{if(check.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('Pre-migration backup verification failed.');}finally{check.close();}
    }
    if (!options.database) {
      fs.chmodSync(dbPath, 0o600);
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS businesses(id TEXT PRIMARY KEY, settings TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, business_id TEXT NOT NULL REFERENCES businesses(id), name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','staff')), active INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), csrf TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS records(id TEXT NOT NULL, business_id TEXT NOT NULL REFERENCES businesses(id), kind TEXT NOT NULL, data TEXT NOT NULL, number TEXT, version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(business_id,kind,id));
      CREATE UNIQUE INDEX IF NOT EXISTS document_number ON records(business_id,kind,number) WHERE number IS NOT NULL;
      CREATE INDEX IF NOT EXISTS workspace_records ON records(business_id,kind);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, business_id TEXT NOT NULL, user_name TEXT NOT NULL, action TEXT NOT NULL, kind TEXT NOT NULL, record_id TEXT, before_data TEXT, after_data TEXT, occurred_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS counters(business_id TEXT NOT NULL, kind TEXT NOT NULL, value INTEGER NOT NULL, PRIMARY KEY(business_id,kind));
      CREATE TABLE IF NOT EXISTS subscriptions(business_id TEXT PRIMARY KEY REFERENCES businesses(id), plan TEXT NOT NULL, status TEXT NOT NULL, trial_end INTEGER NOT NULL, customer_id TEXT UNIQUE, subscription_id TEXT UNIQUE, period_end INTEGER, cancel_at INTEGER, cancel_at_period_end INTEGER NOT NULL DEFAULT 0, billing_currency TEXT, updated_at INTEGER NOT NULL, checkout_key TEXT, checkout_plan TEXT, checkout_currency TEXT, checkout_interval TEXT, checkout_price TEXT, checkout_trial_end INTEGER, checkout_url TEXT, checkout_session_id TEXT, checkout_expires INTEGER, checkout_lock_until INTEGER);
      CREATE TABLE IF NOT EXISTS billing_events(event_id TEXT PRIMARY KEY, business_id TEXT NOT NULL, processed_at INTEGER NOT NULL);`);
    this.transaction(() => {
      if (schemaVersion === 2) {
        for (const business of this.db.prepare('SELECT * FROM businesses').all()) {
          const old=JSON.parse(business.settings), code=D.currency(old.currency || 'KES');
          this.db.prepare('UPDATE businesses SET settings=?,revision=revision+1 WHERE id=?').run(JSON.stringify(settings({...old,currency:code,locale:old.locale || 'en-KE'})),business.id);
          for (const row of this.db.prepare('SELECT * FROM records WHERE business_id=?').all(business.id)) {
            const data=JSON.parse(row.data);
            if(row.kind==='customers') data.preferredCurrency=code;
            else { data.currency=code; if(row.kind==='invoices')data.quote.currency=code; }
            this.db.prepare('UPDATE records SET data=?,version=version+1 WHERE business_id=? AND kind=? AND id=?').run(JSON.stringify(data),business.id,row.kind,row.id);
          }
        }
      }
      for(const business of this.db.prepare('SELECT id FROM businesses').all())this.db.prepare('INSERT OR IGNORE INTO subscriptions(business_id,plan,status,trial_end,updated_at) VALUES (?, ?, ?, ?, ?)').run(business.id,'starter','trialing',Date.now()+TRIAL_DAYS*86400000,Date.now());
      if (!options.database) this.db.exec('PRAGMA user_version=3;');
    });
    if (!options.database && this.db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw Error('Database integrity check failed. Preserve the data directory and restore a verified backup.');
    this.backupStatus = { lastSuccess: null, error: null };
  }
  transaction(fn) {
    if (this.db.transaction) return this.db.transaction(fn);
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  needsSetup() { return this.db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0; }
  createBusiness(input) {
    const config = settings({ ...defaults, name: input.businessName, currency:input.currency || defaults.currency, locale:input.locale || defaults.locale, timezone:input.timezone || defaults.timezone });
    const plan=input.plan || 'starter'; if(!PLANS[plan])fail(422,'Choose a valid subscription plan.');
    const name = DText(input.name, 'name', 100);
    const address = email(input.email);
    const password = passwordHash(input.password);
    return this.transaction(() => {
      if(this.db.prepare('SELECT id FROM users WHERE email=?').get(address))fail(409,'This email is already registered. Sign in to your account.');
      const businessId = randomUUID(), id = randomUUID();
      this.db.prepare('INSERT INTO businesses(id,settings) VALUES (?,?)').run(businessId, JSON.stringify(config));
      this.db.prepare('INSERT INTO users(id,business_id,name,email,password,role) VALUES (?,?,?,?,?,?)').run(id, businessId, name, address, password, 'owner');
      this.db.prepare('INSERT INTO subscriptions(business_id,plan,status,trial_end,updated_at) VALUES (?, ?, ?, ?, ?)').run(businessId,plan,'trialing',Date.now()+TRIAL_DAYS*86400000,Date.now());
      return this.db.prepare('SELECT * FROM users WHERE id=?').get(id);
    });
  }
  authenticate(address, password) {
    const row = typeof address === 'string' ? this.db.prepare('SELECT * FROM users WHERE email=? AND active=1').get(address.toLowerCase().trim()) : null;
    // Perform scrypt for unknown users too, avoiding a cheap account-enumeration path.
    const encoded = row?.password || '00000000000000000000000000000000:' + '00'.repeat(64);
    if (!checkPassword(password, encoded) || !row) fail(401, 'Email or password is incorrect.');
    return row;
  }
  session(user) {
    const token = randomBytes(32).toString('hex'), csrf = randomBytes(24).toString('hex');
    this.db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
    this.db.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(hashToken(token), user.id, csrf, Date.now() + 7 * 86400000);
    return { token, csrf, user: publicUser(user) };
  }
  findSession(token) {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    return this.db.prepare('SELECT u.*,s.csrf FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>? AND u.active=1').get(hashToken(token), Date.now());
  }
  logout(token) { if (token) this.db.prepare('DELETE FROM sessions WHERE token=?').run(hashToken(token)); }
  owner(user) { if (user.role !== 'owner') fail(403, 'Only a business owner can perform this action.'); }
  subscriptionRow(user) { return this.db.prepare('SELECT * FROM subscriptions WHERE business_id=?').get(typeof user==='string'?user:user.business_id); }
  subscription(user) {
    const row=this.subscriptionRow(user), plan=PLANS[row.plan] || PLANS.starter, now=Date.now();
    const entitled=row.status==='active' && row.period_end>now || row.status==='trialing' && (row.subscription_id?row.period_end:row.trial_end)>now;
    const status=row.status==='trialing'&&!entitled?'trial_expired':row.status==='active'&&!entitled?'expired':row.status;
    return {plan:plan.id,planName:plan.name,status,canWrite:!!entitled,trialEndsAt:new Date(row.trial_end).toISOString(),periodEndsAt:row.period_end?new Date(row.period_end).toISOString():null,cancelsAt:row.cancel_at?new Date(row.cancel_at).toISOString():null,cancelAtPeriodEnd:!!row.cancel_at_period_end,billingCurrency:row.billing_currency,
      daysRemaining:Math.max(0,Math.ceil((row.trial_end-now)/86400000)),limits:{seats:plan.seats,customers:plan.customers,documents:plan.documents},usage:{seats:this.users(user).filter(u=>u.active).length,customers:this.list(user,'customers').filter(c=>!c.archived).length,documents:['quotes','invoices'].reduce((n,k)=>n+this.list(user,k).filter(r=>!r.archived).length,0)},canSubscribe:!row.subscription_id||['canceled','incomplete_expired'].includes(row.status),portalAvailable:!!row.customer_id};
  }
  assertWrite(user) { if(!this.subscription(user).canWrite)fail(402,'Your subscription needs attention. Choose a plan in Billing to continue editing. Your records and backups remain available.'); }
  assertCapacity(user,kind,data,previous,records=null) {
    if(data.archived || previous&&!previous.archived)return;
    const plan=PLANS[this.subscriptionRow(user).plan], list=k=>records?records[k]:this.list(user,k);
    const count=kind==='customers'?list('customers').filter(r=>!r.archived).length:['quotes','invoices'].includes(kind)?['quotes','invoices'].reduce((n,k)=>n+list(k).filter(r=>!r.archived).length,0):0;
    const limit=kind==='customers'?plan.customers:['quotes','invoices'].includes(kind)?plan.documents:Infinity;
    if(count>=limit)fail(402,'Your '+plan.name+' plan limit has been reached. Archive inactive records or upgrade in Billing.');
  }
  setBillingCustomer(user,id) { this.db.prepare('UPDATE subscriptions SET customer_id=? WHERE business_id=?').run(id,user.business_id); }
  claimCheckout(user,choice) {
    return this.transaction(()=>{
      const row=this.subscriptionRow(user),now=Date.now();
      if(row.checkout_lock_until>now)fail(409,'Checkout is being prepared. Please try again in a moment.');
      const pending=row.checkout_key&&row.checkout_expires>now;
      if(pending&&(row.checkout_price!==choice.priceId))fail(409,'A different checkout is already open. Continue it or cancel the unfinished checkout first.');
      if(!pending)this.db.prepare('UPDATE subscriptions SET checkout_key=?,checkout_plan=?,checkout_currency=?,checkout_interval=?,checkout_price=?,checkout_trial_end=?,checkout_expires=?,checkout_url=NULL,checkout_session_id=NULL WHERE business_id=?')
        .run(randomUUID(),choice.plan,choice.currency,choice.interval,choice.priceId,row.trial_end>now+2*86400000?Math.floor(row.trial_end/1000):null,now+23*60*60000,user.business_id);
      this.db.prepare('UPDATE subscriptions SET checkout_lock_until=? WHERE business_id=?').run(now+30000,user.business_id);
      return this.subscriptionRow(user);
    });
  }
  completeCheckout(user,session) { this.db.prepare('UPDATE subscriptions SET checkout_session_id=?,checkout_url=?,checkout_expires=?,checkout_lock_until=0 WHERE business_id=?').run(session.id,session.url,session.expires_at*1000,user.business_id); }
  releaseCheckout(user) { this.db.prepare('UPDATE subscriptions SET checkout_lock_until=0 WHERE business_id=?').run(user.business_id); }
  clearCheckout(user) { this.db.prepare('UPDATE subscriptions SET checkout_key=NULL,checkout_url=NULL,checkout_session_id=NULL,checkout_expires=NULL,checkout_lock_until=0 WHERE business_id=?').run(user.business_id); }
  applyBillingEvent(event,subscription,plan) {
    return this.transaction(()=>{
      if(this.db.prepare('SELECT event_id FROM billing_events WHERE event_id=?').get(event.id))return {duplicate:true};
      const customer=typeof subscription.customer==='string'?subscription.customer:subscription.customer?.id;
      const row=this.db.prepare('SELECT * FROM subscriptions WHERE customer_id=?').get(customer);
      if(!row)return {ignored:true};
      if(row.subscription_id && row.subscription_id!==subscription.id && ['canceled','incomplete_expired','unpaid'].includes(subscription.status)) {
        this.db.prepare('INSERT INTO billing_events VALUES (?,?,?)').run(event.id,row.business_id,Date.now());return {ignored:true};
      }
      const end=(subscription.status==='trialing'&&subscription.trial_end) || subscription.current_period_end || Math.max(0,...(subscription.items?.data||[]).map(i=>i.current_period_end||0));
      this.db.prepare('UPDATE subscriptions SET plan=?,status=?,subscription_id=?,period_end=?,cancel_at=?,cancel_at_period_end=?,billing_currency=?,updated_at=?,checkout_key=NULL,checkout_url=NULL,checkout_session_id=NULL,checkout_expires=NULL,checkout_lock_until=0 WHERE business_id=?')
        .run(plan,subscription.status,subscription.id,end?end*1000:null,subscription.cancel_at?subscription.cancel_at*1000:null,subscription.cancel_at_period_end?1:0,subscription.currency?.toUpperCase() || null,Date.now(),row.business_id);
      this.db.prepare('INSERT INTO billing_events VALUES (?,?,?)').run(event.id,row.business_id,Date.now());
      this.db.prepare('UPDATE businesses SET revision=revision+1 WHERE id=?').run(row.business_id);
      return {updated:true};
    });
  }
  business(user) {
    const row = this.db.prepare('SELECT * FROM businesses WHERE id=?').get(user.business_id);
    return { id: row.id, ...JSON.parse(row.settings), revision: row.revision };
  }
  touch(user) { this.db.prepare('UPDATE businesses SET revision=revision+1 WHERE id=?').run(user.business_id); }
  audit(user, action, kind, id, before, after) {
    this.db.prepare('INSERT INTO audit(business_id,user_name,action,kind,record_id,before_data,after_data,occurred_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(user.business_id, user.name, action, kind, id || null, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, new Date().toISOString());
  }
  decode(row) { return row ? { ...JSON.parse(row.data), id: row.id, number: row.number, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at } : null; }
  get(user, kind, id, required = true) {
    const row = this.decode(this.db.prepare('SELECT * FROM records WHERE business_id=? AND kind=? AND id=?').get(user.business_id, kind, id));
    if (!row && required) fail(404, 'Record not found.');
    return row;
  }
  list(user, kind) { return this.db.prepare('SELECT * FROM records WHERE business_id=? AND kind=? ORDER BY updated_at DESC').all(user.business_id, kind).map(row => this.decode(row)); }
  records(user) { return Object.fromEntries(D.kinds.map(kind => [kind, this.list(user, kind)])); }
  users(user) { return this.db.prepare('SELECT * FROM users WHERE business_id=? ORDER BY name').all(user.business_id).map(publicUser); }
  activity(user) {
    return this.db.prepare('SELECT id,user_name AS userName,action,kind,record_id AS recordId,occurred_at AS occurredAt FROM audit WHERE business_id=? ORDER BY id DESC LIMIT 100').all(user.business_id);
  }
  revisions(user, kind, id) {
    this.get(user, kind, id);
    return this.db.prepare('SELECT user_name AS userName,action,before_data AS beforeData,after_data AS afterData,occurred_at AS occurredAt FROM audit WHERE business_id=? AND kind=? AND record_id=? ORDER BY id DESC LIMIT 50')
      .all(user.business_id, kind, id).map(row => ({ ...row, beforeData: row.beforeData ? JSON.parse(row.beforeData) : null, afterData: row.afterData ? JSON.parse(row.afterData) : null }));
  }
  number(user, kind) {
    this.db.prepare('INSERT INTO counters VALUES (?,?,0) ON CONFLICT DO NOTHING').run(user.business_id, kind);
    const n = this.db.prepare('UPDATE counters SET value=value+1 WHERE business_id=? AND kind=? RETURNING value').get(user.business_id, kind).value;
    return (kind === 'quotes' ? 'QUO-' : 'INV-') + String(n).padStart(5, '0');
  }
  validate(kind, input) { try { return D.validateRecord(kind, input); } catch (error) { fail(422, error.message); } }
  validateLinks(user, kind, data, records = null) {
    const find = (k, id) => records ? records[k].find(row => row.id === id) : this.get(user, k, id, false);
    const requireLink = (k, id) => { const row = find(k, id); if (!row) fail(422, 'Linked ' + k + ' record is missing or belongs to another business.'); return row; };
    if (['leads', 'quotes', 'invoices'].includes(kind)) requireLink('customers', data.customerId);
    if (kind === 'leads' && data.assignedTo && !this.users(user).some(u => u.id === data.assignedTo && u.active)) fail(422, 'Assign an active team member.');
    if (kind === 'quotes' && data.leadId && requireLink('leads', data.leadId).customerId !== data.customerId) fail(422, 'The enquiry belongs to a different customer.');
    if (kind === 'invoices' && data.quoteId && requireLink('quotes', data.quoteId).customerId !== data.customerId) fail(422, 'The quote belongs to a different customer.');
    if (kind === 'invoices' && data.currency !== data.quote.currency) fail(422, 'Invoice and pricing snapshot currencies must match.');
    if (['payments', 'expenses'].includes(kind) && requireLink('invoices', data.invoiceId).currency !== data.currency) fail(422, 'Payments and costs must use the invoice currency.');
  }
  write(user, kind, id, data, previous, number = null) {
    const stamp = new Date().toISOString();
    const version = (previous?.version || 0) + 1;
    this.db.prepare('INSERT INTO records(id,business_id,kind,data,number,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(business_id,kind,id) DO UPDATE SET data=excluded.data,version=excluded.version,updated_at=excluded.updated_at')
      .run(id, user.business_id, kind, JSON.stringify(data), previous?.number || number, version, previous?.createdAt || stamp, stamp);
    const result = this.get(user, kind, id);
    this.audit(user, previous ? data.archived && !previous.archived ? 'archived' : previous.archived && !data.archived ? 'restored' : 'updated' : 'created', kind, id, previous, result);
    this.touch(user);
    return result;
  }
  assertLedger(user, overrides = {}) {
    const records = { ...this.records(user), ...overrides };
    for (const invoice of records.invoices) {
      const summary = D.invoiceSummary(invoice, records.payments, records.expenses);
      if (D.cents(summary.received,summary.currency) < 0) fail(422, 'Refunds cannot exceed received payments.');
      if (D.cents(summary.received,summary.currency) > D.cents(summary.total,summary.currency)) fail(422, 'Payment exceeds the invoice balance.');
      if (invoice.status === 'cancelled' && D.cents(summary.received,summary.currency) > 0) fail(422, 'Refund received payments before cancelling an invoice.');
      if (invoice.archived && invoice.status !== 'cancelled' && D.cents(summary.balance,summary.currency) > 0) fail(422, 'Settle or cancel an outstanding invoice before archiving it.');
    }
  }
  saveRecord(user, kind, input, id = null, expectedVersion = null) {
    this.assertWrite(user);
    if (!D.kinds.includes(kind)) fail(404, 'Unknown record type.');
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail(422, 'A record must be an object.');
    return this.transaction(() => {
      const previous = id ? this.get(user, kind, id) : null;
      if (previous && expectedVersion !== previous.version) fail(409, 'This record changed in another session. Reload its latest version before saving. Your edits are still in the form.');
      const base = this.business(user).currency;
      let candidate = {...input};
      if(kind==='leads'&&previous?.captured){
        for(const key of ['customerId','channel','message','receivedAt'])if(input[key]!==undefined&&input[key]!==previous[key])fail(422,'Captured customer, channel, message and receipt time cannot be changed. Update follow-up details instead.');
        candidate={...candidate,customerId:previous.customerId,channel:previous.channel,message:previous.message,receivedAt:previous.receivedAt,captured:previous.captured};
      }
      if(kind==='customers') candidate.preferredCurrency=input.preferredCurrency || previous?.preferredCurrency || base;
      else candidate.currency=input.currency || previous?.currency || (kind==='invoices' ? input.quote?.currency : null) || (['leads','quotes','invoices'].includes(kind) && typeof input.customerId==='string' ? this.get(user,'customers',input.customerId,false)?.preferredCurrency : null) || base;
      if(['payments','expenses'].includes(kind)) {
        const invoice=this.get(user,'invoices',input.invoiceId);
        if(input.currency && input.currency!==invoice.currency)fail(422,'Payments and costs must use the invoice currency.');
        candidate.currency=invoice.currency;
      }
      if (kind === 'invoices') {
        if (input.quoteId && typeof input.quoteId !== 'string') fail(422, 'Choose a valid quotation.');
        if (!previous && input.quoteId) {
          const quote = this.get(user, 'quotes', input.quoteId);
          if (quote.archived || quote.status !== 'accepted') fail(422, 'Accept an active quote before creating an invoice.');
          if (this.list(user, 'invoices').some(i => i.quoteId === quote.id && i.status !== 'cancelled')) fail(409, 'This quote already has an invoice.');
          candidate = { ...input, currency:quote.currency, customerId: quote.customerId, quote: D.pricing(quote), terms: input.terms ?? quote.terms };
        } else if (!previous) {
          if (typeof input.customerId === 'string' && this.get(user, 'customers', input.customerId, false)?.archived) fail(422, 'Restore this customer before creating an invoice.');
          candidate = { ...candidate, quoteId: null, quote: { ...input.quote, currency: input.quote?.currency || candidate.currency }, terms: input.terms ?? this.business(user).terms };
        } else candidate = { ...input, currency:previous.currency, quoteId: previous.quoteId, customerId: previous.customerId, quote: previous.quote };
      }
      const data = this.validate(kind, candidate);
      if (kind === 'leads') {
        data.firstContactedAt = previous?.firstContactedAt || (data.status !== 'new' ? new Date(Math.max(Date.now(), Date.parse(data.receivedAt))).toISOString() : null);
        if (data.firstContactedAt && Date.parse(data.firstContactedAt) < Date.parse(data.receivedAt)) fail(422, 'Received time cannot be after the recorded first response.');
        if (previous && data.customerId !== previous.customerId && this.list(user, 'quotes').some(q => q.leadId === id)) fail(422, 'An enquiry with quotations must keep its original customer. Create a new enquiry for another customer.');
      }
      this.validateLinks(user, kind, data);
      this.assertCapacity(user,kind,data,previous);
      if (kind === 'customers' && !data.archived && this.list(user, kind).some(c => c.id !== id && !c.archived && ((data.email && c.email === data.email) || (data.phone && c.phone.replace(/\D/g, '') === data.phone.replace(/\D/g, ''))))) fail(409, 'A customer with this email or phone already exists. Open that customer instead.');
      if (kind === 'quotes' && previous && this.list(user, 'invoices').some(i => i.quoteId === id && i.status !== 'cancelled') && JSON.stringify(D.pricing(previous)) !== JSON.stringify(D.pricing(data))) fail(422, 'An invoiced quote cannot change its pricing. Duplicate it to make a new quotation.');
      if (kind === 'quotes' && previous && data.customerId !== previous.customerId && this.list(user, 'invoices').some(i => i.quoteId === id)) fail(422, 'A quote with invoice history must keep its original customer. Duplicate it for another customer.');
      if (kind === 'quotes' && previous && this.list(user, 'invoices').some(i => i.quoteId === id && i.status !== 'cancelled') && (data.customerId !== previous.customerId || data.status !== 'accepted')) fail(422, 'Keep the invoiced quote accepted and linked to its original customer.');
      if (['payments', 'expenses'].includes(kind)) {
        const invoice = this.get(user, 'invoices', data.invoiceId);
        if (invoice.status === 'cancelled' && !data.archived) fail(422, 'Reopen the cancelled invoice before recording a payment or cost.');
        if (invoice.archived && !data.archived) fail(422, 'Restore the invoice first.');
        if (previous && data.invoiceId !== previous.invoiceId) fail(422, 'The linked invoice cannot be changed.');
        if (kind === 'payments' && data.reference && !data.archived && this.list(user, 'payments').some(p => p.id !== id && !p.archived && p.invoiceId === data.invoiceId && p.reference === data.reference && p.direction === data.direction)) fail(409, 'This transaction reference is already recorded on the invoice.');
      }
      if (kind === 'customers' && data.archived && ['leads', 'quotes', 'invoices'].some(k => this.list(user, k).some(r => r.customerId === id && !r.archived))) fail(422, 'Archive this customer’s active enquiries, quotes, and invoices first.');
      const result = this.write(user, kind, id || randomUUID(), data, previous, !previous && ['quotes', 'invoices'].includes(kind) ? this.number(user, kind) : null);
      this.assertLedger(user);
      if (kind === 'quotes' && data.leadId && ['sent', 'accepted'].includes(data.status)) {
        const lead = this.get(user, 'leads', data.leadId);
        if (!lead.archived && lead.status !== 'lost' && !(lead.status === 'won' && data.status === 'sent')) this.write(user, 'leads', lead.id, { ...this.validate('leads', lead), status: data.status === 'accepted' ? 'won' : 'quoted', firstContactedAt: lead.firstContactedAt || new Date(Math.max(Date.now(), Date.parse(lead.receivedAt))).toISOString() }, lead);
      }
      return result;
    });
  }
  saveSettings(user, input, expectedRevision) {
    this.owner(user); this.assertWrite(user);
    const config = settings(input);
    return this.transaction(() => {
      const before = this.business(user);
      if (before.revision !== expectedRevision) fail(409, 'Workspace changed. Refresh before saving settings.');
      this.db.prepare('UPDATE businesses SET settings=?,revision=revision+1 WHERE id=?').run(JSON.stringify(config), user.business_id);
      this.audit(user, 'updated', 'settings', null, before, config);
      return this.business(user);
    });
  }
  addUser(user, input) {
    this.owner(user); this.assertWrite(user);
    const name = DText(input.name, 'name', 100), address = email(input.email), password = passwordHash(input.password);
    if (!['owner', 'staff'].includes(input.role)) fail(422, 'Choose owner or staff.');
    if (this.db.prepare('SELECT id FROM users WHERE email=?').get(address)) fail(409, 'This email is already registered.');
    return this.transaction(() => {
      if(this.users(user).filter(u=>u.active).length>=PLANS[this.subscriptionRow(user).plan].seats)fail(402,'Your team limit has been reached. Upgrade in Billing.');
      const id = randomUUID();
      this.db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,1)').run(id, user.business_id, name, address, password, input.role);
      this.audit(user, 'created', 'team', id, null, { name, email: address, role: input.role });
      return publicUser(this.db.prepare('SELECT * FROM users WHERE id=?').get(id));
    });
  }
  updateUser(user, id, input) {
    this.owner(user);
    return this.transaction(() => {
      const target = this.db.prepare('SELECT * FROM users WHERE id=? AND business_id=?').get(id, user.business_id);
      if (!target) fail(404, 'Team member not found.');
      const role = input.role ?? target.role, active = input.active ?? !!target.active;
      if(active&&!target.active){this.assertWrite(user);if(this.users(user).filter(u=>u.active).length>=PLANS[this.subscriptionRow(user).plan].seats)fail(402,'Your team limit has been reached. Upgrade in Billing.');}
      if (!['owner', 'staff'].includes(role) || typeof active !== 'boolean') fail(422, 'Invalid permissions.');
      if (target.role === 'owner' && target.active && (role !== 'owner' || !active) && this.users(user).filter(u => u.role === 'owner' && u.active).length <= 1) fail(422, 'Keep at least one active business owner.');
      this.db.prepare('UPDATE users SET role=?,active=? WHERE id=?').run(role, active ? 1 : 0, id);
      this.db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
      this.audit(user, 'updated', 'team', id, publicUser(target), { role, active });
      return { id, role, active };
    });
  }
  changePassword(user, oldPassword, newPassword) {
    const target = this.db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
    if (!checkPassword(oldPassword, target.password)) fail(422, 'Current password is incorrect.');
    const encoded = passwordHash(newPassword);
    this.transaction(() => {
      this.db.prepare('UPDATE users SET password=? WHERE id=?').run(encoded, user.id);
      this.db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
      this.audit(user, 'changed password', 'account', user.id, null, null);
    });
  }
  export(user) { this.owner(user); return { schemaVersion: 3, exportedAt: new Date().toISOString(), business: this.business(user), records: this.records(user) }; }
  normalizeBackup(user, input) {
    if (![2,3].includes(input?.schemaVersion) || !input.records || typeof input.records !== 'object') fail(422, 'Unsupported backup. Use a version 2 or 3 export or import a version 1 legacy backup.');
    const config = settings({...input.business,currency:input.business?.currency || (input.schemaVersion===2?'KES':this.business(user).currency)});
    const records = {}, ids = new Set(), numbers = new Set();
    let count = 0;
    for (const kind of D.kinds) {
      if (!Array.isArray(input.records[kind])) fail(422, 'Backup is missing ' + kind + '.');
      records[kind] = input.records[kind].map(raw => {
        if (++count > 50000) fail(422, 'Backup exceeds 50,000 records.');
        const id = DText(raw?.id, 'record id', 100);
        if (!/^[A-Za-z0-9_-]+$/.test(id)) fail(422, 'Backup record IDs must contain only letters, numbers, underscores, or hyphens.');
        if (ids.has(id)) fail(422, 'Duplicate record IDs are not allowed.');
        ids.add(id);
        const candidate={...raw};
        if(input.schemaVersion===2){if(kind==='customers')candidate.preferredCurrency=config.currency;else{candidate.currency=config.currency;if(kind==='invoices')candidate.quote={...raw.quote,currency:config.currency};}}
        else if(!candidate[kind==='customers'?'preferredCurrency':'currency'])fail(422,'Backup records must specify their currency.');
        const data = this.validate(kind, candidate);
        if (kind === 'leads' && data.assignedTo && !this.users(user).some(u => u.id === data.assignedTo && u.active)) data.assignedTo = null;
        let number = null;
        if (['quotes', 'invoices'].includes(kind)) {
          number = DText(raw.number, 'document number', 40);
          const key = kind + number;
          if (numbers.has(key)) fail(422, 'Duplicate document numbers are not allowed.');
          numbers.add(key);
        }
        const createdAt = typeof raw.createdAt === 'string' && Number.isFinite(Date.parse(raw.createdAt)) ? new Date(raw.createdAt).toISOString() : new Date().toISOString();
        return { ...data, id, number, createdAt, updatedAt: new Date().toISOString(), version: 1 };
      });
    }
    for (const kind of D.kinds) for (const record of records[kind]) this.validateLinks(user, kind, record, records);
    const invoiceQuotes = new Set();
    for (const invoice of records.invoices.filter(i => i.status !== 'cancelled' && i.quoteId)) {
      if (invoiceQuotes.has(invoice.quoteId)) fail(422, 'A quote cannot have multiple active invoices.');
      invoiceQuotes.add(invoice.quoteId);
    }
    this.assertLedger(user, records);
    return { config, records, count };
  }
  restore(user, input, revision, preview = false) {
    this.owner(user); this.assertWrite(user);
    const normalized = this.normalizeBackup(user, input);
    const plan=PLANS[this.subscriptionRow(user).plan];
    if(normalized.records.customers.filter(r=>!r.archived).length>plan.customers || ['quotes','invoices'].reduce((n,k)=>n+normalized.records[k].filter(r=>!r.archived).length,0)>plan.documents)fail(402,'This backup exceeds your plan limits. Upgrade in Billing before restoring.');
    if (preview) return { counts: Object.fromEntries(D.kinds.map(k => [k, normalized.records[k].length])), total: normalized.count, businessName: normalized.config.name };
    return this.transaction(() => {
      if (this.business(user).revision !== revision) fail(409, 'Workspace changed after the import preview. Preview the backup again.');
      const safety = this.export(user);
      const safetyFile = 'before-restore-' + Date.now() + '-' + randomBytes(4).toString('hex') + '.json';
      this.saveSafetyBackup(user, safetyFile, safety);
      this.db.prepare('DELETE FROM records WHERE business_id=?').run(user.business_id);
      for (const kind of D.kinds) for (const record of normalized.records[kind]) {
        const { id, number, createdAt, updatedAt, ...data } = record;
        delete data.version;
        const version = safety.business.revision + 1;
        this.db.prepare('INSERT INTO records VALUES (?,?,?,?,?,?,?,?)').run(id, user.business_id, kind, JSON.stringify(data), number, version, createdAt, updatedAt);
      }
      this.db.prepare('UPDATE businesses SET settings=?,revision=revision+1 WHERE id=?').run(JSON.stringify(normalized.config), user.business_id);
      for (const kind of ['quotes', 'invoices']) {
        const max = normalized.records[kind].reduce((n, r) => Math.max(n, Number(r.number.match(/-(\d+)$/)?.[1] || 0)), 0);
        this.db.prepare('INSERT INTO counters VALUES (?,?,?) ON CONFLICT(business_id,kind) DO UPDATE SET value=MAX(value,excluded.value)').run(user.business_id, kind, max);
      }
      this.audit(user, 'restored backup', 'workspace', null, { counts: D.kinds.map(k => safety.records[k].length) }, { safetyFile, count: normalized.count });
      return { restored: normalized.count, safetyFile };
    });
  }
  legacy(user, input, preview = false) {
    this.owner(user);
    if (!input || (input.version !== undefined && input.version !== 1) || !Array.isArray(input.quotes) || !Array.isArray(input.leads)) fail(422, 'Choose a version 1 ProfitPulse backup.');
    const existing = this.export(user), records = existing.records;
    const byName = new Map(records.customers.map(c => [c.name.toLowerCase(), c.id]));
    const customer = name => {
      const trimmed = DText(name, 'customer name', 100);
      if (!byName.has(trimmed.toLowerCase())) { const id = randomUUID(); byName.set(trimmed.toLowerCase(), id); records.customers.push({ id, name: trimmed, company: '', email: '', phone: '', address: '', preferredCurrency:'KES', notes: 'Imported from the original local workspace.' }); }
      return byName.get(trimmed.toLowerCase());
    };
    const stamp = new Date().toISOString(), today = stamp.slice(0, 10), suffix = randomBytes(4).toString('hex');
    let skippedExamples = 0;
    for (const lead of input.leads) {
      if (lead?.demo === true) { skippedExamples++; continue; }
      if (!lead || !['new', 'replied', 'won', 'lost'].includes(lead.status)) fail(422, 'Invalid legacy enquiry.');
      records.leads.push({ id: randomUUID(), currency:'KES', customerId: customer(lead.customer), channel: D.channels.includes(lead.channel) ? lead.channel : 'Other', receivedAt: lead.received, message: lead.message, value: lead.value, status: lead.status === 'replied' ? 'contacted' : lead.status, assignedTo: null, nextActionAt: null, priority: 'auto', notes: '', lostReason: lead.status === 'lost' ? 'Imported lost enquiry' : '', draft: '' });
    }
    input.quotes.forEach((q, index) => {
      if (!q || !['qty', 'price', 'materials', 'labour', 'transport', 'other', 'fee', 'target'].every(key => Number.isFinite(q[key]) && q[key] >= 0) || q.qty < 1) fail(422, 'Invalid legacy quote.');
      records.quotes.push({ id: randomUUID(), currency:'KES', number: 'QUO-LEG-' + suffix + '-' + (index + 1), customerId: customer(q.job), leadId: null,
        items: [{ description: q.job, quantity: q.qty, unitPrice: q.price, unitCost: q.materials }], labour: q.labour, transport: q.transport, overhead: q.other, fixedFee: 0, discountPercent: 0, taxPercent: 0, feePercent: q.fee, targetMargin: q.target, issuedOn: q.date && Number.isFinite(Date.parse(q.date)) ? q.date.slice(0, 10) : today, expiresOn: '2099-12-31', status: 'draft', notes: 'Imported quote; review expiry and customer details.', terms: this.business(user).terms });
    });
    const checked = this.normalizeBackup(user, existing);
    if (preview) return { total: input.quotes.length + input.leads.length - skippedExamples, skippedExamples, counts: Object.fromEntries(D.kinds.map(k => [k, checked.records[k].length])) };
    return { backup: existing, skippedExamples };
  }
  saveSafetyBackup(user, name, data) {
    fs.writeFileSync(path.join(this.backupDir, name), JSON.stringify(data), { mode: 0o600 });
  }
  listSafetyBackups(user) {
    this.owner(user);
    return fs.readdirSync(this.backupDir).filter(name => /^before-restore-[\w-]+\.json$/.test(name)).filter(name => {
      try { return JSON.parse(fs.readFileSync(path.join(this.backupDir, name))).business.id === user.business_id; } catch { return false; }
    }).sort().reverse().slice(0, 20);
  }
  readSafetyBackup(user, name) {
    this.owner(user);
    if (!/^before-restore-[\w-]+\.json$/.test(name)) fail(404, 'Backup not found.');
    const file = path.join(this.backupDir, name);
    if (!fs.existsSync(file)) fail(404, 'Backup not found.');
    const data = JSON.parse(fs.readFileSync(file));
    if (data.business.id !== user.business_id) fail(404, 'Backup not found.');
    return data;
  }
  async automaticBackup() {
    if (this.backupRunning) return;
    this.backupRunning = true;
    const target = path.join(this.backupDir, 'daily-' + new Date().toISOString().slice(0, 10) + '.sqlite');
    try {
      {
        const temporary = target + '.pending';
        await backup(this.db, temporary);
        fs.chmodSync(temporary, 0o600);
        const check = new DatabaseSync(temporary, { readOnly: true });
        try { if (check.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw Error('Backup integrity check failed.'); }
        finally { check.close(); }
        fs.renameSync(temporary, target);
      }
      this.backupStatus = { lastSuccess: fs.statSync(target).mtime.toISOString(), error: null };
      const files = fs.readdirSync(this.backupDir).filter(name => /^daily-.*\.sqlite$/.test(name)).sort().reverse();
      for (const old of files.slice(14)) fs.unlinkSync(path.join(this.backupDir, old));
    } catch (error) { this.backupStatus = { ...this.backupStatus, error: error.message }; }
    finally { this.backupRunning = false; }
  }
  close() { this.db.close(); }
}
module.exports = { Store, AppError, publicUser, passwordHash };
