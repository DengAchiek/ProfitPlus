'use strict';
const { AppError } = require('./store');
const { createHash } = require('node:crypto');

const MODULES = { overview: 'Overview', customers: 'Customers', leads: 'Enquiries', quotes: 'Quotations', invoices: 'Invoices & payments', reports: 'Reports', integrations:'Connections',billing: 'Subscription', settings: 'Settings & backups' };
const DAY = 86400000;
const iso = value => new Date(value).toISOString();
const date = value => iso(value).slice(0, 10);
const denied = () => { throw new AppError(403, 'Platform administrator access is required.'); };

// Operational analytics live outside tenant exports/restores. No record contents,
// passwords, session tokens, IP addresses or raw URLs are collected here.
class Analytics {
  constructor(store, options = {}) {
    this.db = store.db;
    this.now = options.now || Date.now;
    this.adminEmails = new Set(String(options.adminEmails || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean));
    this.adminEmailHashes = new Set(String(options.adminEmailHashes || '').split(',').map(x => x.trim().toLowerCase()).filter(x=>/^[a-f0-9]{64}$/.test(x)));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS platform_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS platform_profiles(user_id TEXT PRIMARY KEY REFERENCES users(id), registered_at TEXT, first_observed_at TEXT NOT NULL, last_login_at TEXT, last_seen_at TEXT);
      CREATE TABLE IF NOT EXISTS platform_usage(day TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), module TEXT NOT NULL, active_seconds REAL NOT NULL DEFAULT 0, visits INTEGER NOT NULL DEFAULT 0, actions INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(day,user_id,module));
      CREATE INDEX IF NOT EXISTS platform_usage_user ON platform_usage(user_id,day);
      CREATE TABLE IF NOT EXISTS platform_presence(user_id TEXT PRIMARY KEY REFERENCES users(id), last_credit INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS platform_tabs(user_id TEXT NOT NULL REFERENCES users(id), tab_id TEXT NOT NULL, sequence INTEGER NOT NULL, last_ping INTEGER NOT NULL, PRIMARY KEY(user_id,tab_id));
      CREATE TABLE IF NOT EXISTS platform_requests(day TEXT NOT NULL, route TEXT NOT NULL, method TEXT NOT NULL, requests INTEGER NOT NULL DEFAULT 0, server_errors INTEGER NOT NULL DEFAULT 0, client_errors INTEGER NOT NULL DEFAULT 0, duration_ms REAL NOT NULL DEFAULT 0, max_ms REAL NOT NULL DEFAULT 0, slow INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(day,route,method));
    `);
    const stamp = iso(this.now());
    this.db.prepare('INSERT OR IGNORE INTO platform_meta VALUES (?,?)').run('tracking_started_at', stamp);
    this.db.prepare('INSERT OR IGNORE INTO platform_profiles(user_id,first_observed_at) SELECT id,? FROM users').run(stamp);
    this.prune();
  }
  allowedEmail(address) { const normalized=String(address||'').trim().toLowerCase(); return this.adminEmails.has(normalized)||this.adminEmailHashes.has(createHash('sha256').update(normalized).digest('hex')); }
  isAdmin(user) { return !!user?.active && this.allowedEmail(user.email); }
  requireAdmin(user) { if (!this.isAdmin(user)) denied(); }
  reserveEmail(address) {
    if (typeof address === 'string' && this.allowedEmail(address)) throw new AppError(422, 'This administrator address is reserved. Use your private admin setup invitation, or sign in with an existing BizAtrio account.');
  }
  registered(user) {
    const stamp = iso(this.now());
    this.db.prepare('INSERT INTO platform_profiles(user_id,registered_at,first_observed_at) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET registered_at=excluded.registered_at').run(user.id, stamp, stamp);
  }
  login(user) { this.db.prepare('UPDATE platform_profiles SET last_login_at=?,last_seen_at=? WHERE user_id=?').run(iso(this.now()), iso(this.now()), user.id); }
  prune() {
    const day = date(this.now());
    if (this.prunedOn === day) return;
    const before = date(Date.parse(day) - 89 * DAY);
    this.db.prepare('DELETE FROM platform_usage WHERE day<?').run(before);
    this.db.prepare('DELETE FROM platform_requests WHERE day<?').run(before);
    this.db.prepare('DELETE FROM platform_tabs WHERE last_ping<?').run(this.now() - DAY);
    this.prunedOn = day;
  }
  addUsage(user, module, seconds = 0, visits = 0, actions = 0) {
    if(this.isAdmin(user))return;
    this.db.prepare(`INSERT INTO platform_usage VALUES (?,?,?,?,?,?) ON CONFLICT(day,user_id,module) DO UPDATE SET
      active_seconds=active_seconds+excluded.active_seconds, visits=visits+excluded.visits, actions=actions+excluded.actions`)
      .run(date(this.now()), user.id, module, seconds, visits, actions);
    this.db.prepare('UPDATE platform_profiles SET last_seen_at=? WHERE user_id=?').run(iso(this.now()), user.id);
  }
  heartbeat(user, input) {
    if(this.isAdmin(user))return {ok:true};
    if (!input || !Object.hasOwn(MODULES, input.module) || typeof input.tabId !== 'string' || !/^[\w-]{8,80}$/.test(input.tabId) || !Number.isSafeInteger(input.sequence) || input.sequence < 1 || typeof input.view !== 'boolean' || !Number.isFinite(input.activeSeconds) || input.activeSeconds < 0 || input.activeSeconds > 60) throw new AppError(422, 'Invalid usage measurement.');
    this.prune();
    const now = this.now();
    const tab = this.db.prepare('SELECT * FROM platform_tabs WHERE user_id=? AND tab_id=?').get(user.id, input.tabId);
    if (tab && input.sequence <= tab.sequence) return { ok: true };
    if (tab && now - tab.last_ping < 1000) throw new AppError(429, 'Usage updates are too frequent.');
    if (!tab && this.db.prepare('SELECT COUNT(*) AS n FROM platform_tabs WHERE user_id=?').get(user.id).n >= 50) throw new AppError(429, 'Too many usage sessions.');
    const presence = this.db.prepare('SELECT last_credit FROM platform_presence WHERE user_id=?').get(user.id);
    // Cap credited time across every tab and login for this user. A first ping
    // establishes a baseline; browser clocks cannot manufacture historical time.
    const seconds = presence ? Math.min(input.activeSeconds, 60, Math.max(0, (now - presence.last_credit) / 1000)) : 0;
    this.db.prepare('INSERT INTO platform_tabs VALUES (?,?,?,?) ON CONFLICT(user_id,tab_id) DO UPDATE SET sequence=excluded.sequence,last_ping=excluded.last_ping').run(user.id, input.tabId, input.sequence, now);
    this.db.prepare('INSERT INTO platform_presence VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET last_credit=excluded.last_credit').run(user.id, now);
    if (seconds || input.view) this.addUsage(user, input.module, seconds, input.view ? 1 : 0);
    return { ok: true };
  }
  route(path) {
    if (/^\/api\/records\/(customers|leads|quotes|invoices|payments|expenses)(?:\/[^/]+)?(?:\/(pdf|history))?$/.test(path)) return path.replace(/(\/api\/records\/[^/]+)\/[^/]+/, '$1/:id');
    if (/^\/api\/capture\/[^/]+\/(info|visit|enquiry)$/.test(path)) return path.replace(/(\/api\/capture)\/[^/]+/, '$1/:id');
    if (/^\/api\/channel-webhooks\/twilio\/[^/]+$/.test(path)) return '/api/channel-webhooks/twilio/:id';
    if (/^\/api\/integrations\/events\/[^/]+\/retry$/.test(path)) return '/api/integrations/events/:id/retry';
    if (/^\/api\/integrations\/[^/]+\/disconnect$/.test(path)) return '/api/integrations/:id/disconnect';
    if (/^\/api\/integrations(?:\/(?:website|twilio|meta\/start|meta\/connect|oauth\/callback))?$/.test(path)||path==='/api/channel-webhooks/meta')return path;
    if (/^\/api\/users\/[^/]+$/.test(path)) return '/api/users/:id';
    if (/^\/api\/backups\/[^/]+$/.test(path)) return '/api/backups/:name';
    return ['/api/bootstrap', '/api/status', '/api/plans', '/api/setup', '/api/register', '/api/login', '/api/logout', '/api/account/password', '/api/settings', '/api/users', '/api/backup', '/api/backups', '/api/restore', '/api/restore/preview', '/api/legacy', '/api/legacy/preview', '/api/billing', '/api/billing/checkout', '/api/billing/portal', '/api/billing/cancel-checkout', '/api/billing/webhook'].includes(path) ? path : '/api/other';
  }
  request(path, method, status, duration, user) {
    if (!path.startsWith('/api/') || path.startsWith('/api/admin') || path === '/api/telemetry' || this.isAdmin(user)) return;
    this.prune();
    const ms = Math.max(0, duration), route = this.route(path);
    const verb = ['GET', 'POST', 'PUT', 'HEAD', 'DELETE', 'PATCH', 'OPTIONS'].includes(method) ? method : 'OTHER';
    this.db.prepare(`INSERT INTO platform_requests VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(day,route,method) DO UPDATE SET
      requests=requests+1, server_errors=server_errors+excluded.server_errors, client_errors=client_errors+excluded.client_errors,
      duration_ms=duration_ms+excluded.duration_ms, max_ms=MAX(max_ms,excluded.max_ms), slow=slow+excluded.slow`)
      .run(date(this.now()), route, verb, 1, status >= 500 ? 1 : 0, status >= 400 && status < 500 ? 1 : 0, ms, ms, ms >= 1000 ? 1 : 0);
    if (!user || status >= 400) return;
    const record = path.match(/^\/api\/records\/(customers|leads|quotes|invoices|payments|expenses)(?:\/[^/]+)?(?:\/(pdf|history))?$/);
    let module;
    if (record && (['POST', 'PUT'].includes(method) || record[2] === 'pdf')) module = ['payments', 'expenses'].includes(record[1]) ? 'invoices' : record[1];
    else if (['/api/settings', '/api/users', '/api/account/password', '/api/backup', '/api/restore', '/api/legacy'].includes(path) && (method !== 'GET' || path === '/api/backup') || route === '/api/users/:id' && method === 'PUT' || route === '/api/backups/:name') module = 'settings';
    else if (path.startsWith('/api/integrations/') && method==='POST') module='integrations';
    else if (path.startsWith('/api/billing/') && path !== '/api/billing/webhook') module = 'billing';
    if (module) this.addUsage(user, module, 0, 0, 1);
  }
  window(value) {
    const days = Number(value || 30);
    if (![7, 30, 90].includes(days)) throw new AppError(422, 'Choose 7, 30 or 90 days.');
    const end = date(this.now()), start = date(Date.parse(end + 'T00:00:00Z') - (days - 1) * DAY);
    return { days, start, end };
  }
  clientScope(column='user_id') {
    const ids=this.db.prepare('SELECT id,email FROM users').all().filter(u=>this.allowedEmail(u.email)).map(u=>u.id);
    return {sql:ids.length?column+' NOT IN ('+ids.map(()=>'?').join(',')+')':'1=1',parameters:ids};
  }
  subscriptionStatus(row) {
    const until=row.status==='trialing'?(row.subscription_id?row.period_end:row.trial_end):row.period_end;
    return ['active','trialing'].includes(row.status)&&!(until>this.now())?(row.status==='trialing'?'trial_expired':'expired'):row.status||'unavailable';
  }
  businessSubscriptionStatus(id) {
    return this.subscriptionStatus(this.db.prepare('SELECT status,subscription_id,trial_end,period_end FROM subscriptions WHERE business_id=?').get(id)||{});
  }
  clientRows(window) {
    const scope=this.clientScope('u.id');
    const rows=this.db.prepare(`SELECT b.id,json_extract(b.settings,'$.name') AS name,
      MIN(CASE WHEN u.role='owner' THEN json_object('email',u.email,'name',u.name) END) AS owner,
      COUNT(*) AS users,SUM(u.active) AS enabledUsers,MIN(p.registered_at) AS registeredAt,MAX(p.last_seen_at) AS lastSeenAt,
      s.plan,s.status,s.subscription_id,s.trial_end,s.period_end,s.cancel_at_period_end,s.billing_currency,
      COALESCE(SUM(a.activeSeconds),0) AS activeSeconds,COALESCE(SUM(a.actions),0) AS actions
      FROM users u JOIN businesses b ON b.id=u.business_id LEFT JOIN subscriptions s ON s.business_id=b.id
      LEFT JOIN platform_profiles p ON p.user_id=u.id
      LEFT JOIN (SELECT user_id,SUM(active_seconds) AS activeSeconds,SUM(actions) AS actions FROM platform_usage WHERE day>=? AND day<=? GROUP BY user_id) a ON a.user_id=u.id
      WHERE ${scope.sql} GROUP BY b.id ORDER BY MAX(p.last_seen_at) DESC,b.id`).all(window.start,window.end,...scope.parameters);
    return rows.map(r=>{const owner=JSON.parse(r.owner||'{}');return {id:r.id,name:r.name,ownerName:owner.name||null,ownerEmail:owner.email||null,users:r.users,enabledUsers:r.enabledUsers,
      registeredAt:r.registeredAt,lastSeenAt:r.lastSeenAt,plan:r.plan,subscriptionStatus:this.subscriptionStatus(r),
      trialEndsAt:r.trial_end?iso(r.trial_end):null,periodEndsAt:r.period_end?iso(r.period_end):null,
      cancelAtPeriodEnd:!!r.cancel_at_period_end,billingCurrency:r.billing_currency,activeSeconds:r.activeSeconds,actions:r.actions};});
  }
  subscriptionTotals(rows) {
    const byStatus=Object.entries(rows.reduce((all,r)=>{all[r.subscriptionStatus]=(all[r.subscriptionStatus]||0)+1;return all;},{})).map(([status,clients])=>({status,clients}));
    return {clients:rows.length,activeSubscribers:rows.filter(r=>r.subscriptionStatus==='active').length,
      trialingClients:rows.filter(r=>r.subscriptionStatus==='trialing').length,pastDueClients:rows.filter(r=>r.subscriptionStatus==='past_due').length,byStatus};
  }
  clients(user,options={}) {
    this.requireAdmin(user);
    const window=this.window(options.days),search=String(options.search||'').trim().slice(0,100).toLowerCase();
    const page=Math.max(1,Math.min(100000,Number.parseInt(options.page,10)||1)),all=this.clientRows(window);
    const rows=all.filter(r=>(!search||[r.name,r.ownerName,r.ownerEmail].some(v=>String(v||'').toLowerCase().includes(search)))&&(!options.status||r.subscriptionStatus===options.status));
    return {clients:rows.slice((page-1)*20,page*20),total:rows.length,page,pageSize:20,subscriptions:this.subscriptionTotals(all)};
  }
  services(start, end, userId = null) {
    const scope=this.clientScope();
    const rows = this.db.prepare(`SELECT module,SUM(active_seconds) AS activeSeconds,SUM(visits) AS visits,SUM(actions) AS actions,COUNT(DISTINCT user_id) AS users FROM platform_usage WHERE day>=? AND day<=? AND ${scope.sql} ${userId ? 'AND user_id=?' : ''} GROUP BY module ORDER BY actions DESC,activeSeconds DESC,visits DESC`)
      .all(start, end, ...scope.parameters, ...(userId ? [userId] : []));
    return rows.map(r => ({ ...r, label: MODULES[r.module] }));
  }
  dashboard(user, days) {
    this.requireAdmin(user); this.prune();
    const window = this.window(days), { start, end } = window, scope=this.clientScope(), usersScope=this.clientScope('id');
    const totals = this.db.prepare(`SELECT COUNT(*) AS registeredUsers,COALESCE(SUM(active),0) AS enabledUsers,COUNT(DISTINCT business_id) AS businesses FROM users WHERE ${usersScope.sql}`).get(...usersScope.parameters);
    const usage = this.db.prepare(`SELECT COUNT(DISTINCT user_id) AS activeUsers,COALESCE(SUM(active_seconds),0) AS activeSeconds,COALESCE(SUM(actions),0) AS actions FROM platform_usage WHERE day>=? AND day<=? AND ${scope.sql}`).get(start, end,...scope.parameters);
    const newUsers = this.db.prepare(`SELECT COUNT(*) AS n FROM platform_profiles WHERE registered_at>=? AND registered_at<? AND ${scope.sql}`).get(start, date(Date.parse(end) + DAY),...scope.parameters).n;
    const missingRegistrationDates = this.db.prepare(`SELECT COUNT(*) AS n FROM platform_profiles WHERE registered_at IS NULL AND ${scope.sql}`).get(...scope.parameters).n;
    const requests = this.db.prepare('SELECT route,method,SUM(requests) AS requests,SUM(server_errors) AS serverErrors,SUM(client_errors) AS clientErrors,SUM(duration_ms) AS durationMs,MAX(max_ms) AS maxMs,SUM(slow) AS slow FROM platform_requests WHERE day>=? AND day<=? GROUP BY route,method ORDER BY requests DESC').all(start, end);
    const performance = requests.reduce((a,r) => ({ requests:a.requests+r.requests,serverErrors:a.serverErrors+r.serverErrors,clientErrors:a.clientErrors+r.clientErrors,durationMs:a.durationMs+r.durationMs,maxMs:Math.max(a.maxMs,r.maxMs),slow:a.slow+r.slow }), { requests:0,serverErrors:0,clientErrors:0,durationMs:0,maxMs:0,slow:0 });
    performance.averageMs = performance.requests ? performance.durationMs / performance.requests : null;
    performance.errorRate = performance.requests ? performance.serverErrors / performance.requests * 100 : null;
    const usageDaily = this.db.prepare(`SELECT day,COUNT(DISTINCT user_id) AS activeUsers,SUM(active_seconds) AS activeSeconds,SUM(actions) AS actions FROM platform_usage WHERE day>=? AND day<=? AND ${scope.sql} GROUP BY day`).all(start,end,...scope.parameters);
    const requestDaily = this.db.prepare('SELECT day,SUM(requests) AS requests,SUM(server_errors) AS serverErrors FROM platform_requests WHERE day>=? AND day<=? GROUP BY day').all(start,end);
    const registrations = this.db.prepare(`SELECT substr(registered_at,1,10) AS day,COUNT(*) AS newUsers FROM platform_profiles WHERE registered_at>=? AND registered_at<? AND ${scope.sql} GROUP BY day`).all(start, date(Date.parse(end) + DAY),...scope.parameters);
    const daily = Array.from({length:window.days}, (_,i) => {
      const day = date(Date.parse(start) + i * DAY);
      return {day,activeUsers:0,activeSeconds:0,actions:0,requests:0,serverErrors:0,newUsers:0,...usageDaily.find(r=>r.day===day),...requestDaily.find(r=>r.day===day),...registrations.find(r=>r.day===day)};
    });
    return { generatedAt:iso(this.now()), trackingStartedAt:this.db.prepare('SELECT value FROM platform_meta WHERE key=?').get('tracking_started_at').value, window, totals:{...totals,...usage,newUsers,missingRegistrationDates}, subscriptions:this.subscriptionTotals(this.clientRows(window)), services:this.services(start,end), daily, performance, routes:requests.slice(0,30) };
  }
  users(user, options = {}) {
    this.requireAdmin(user);
    const {start,end} = this.window(options.days);
    const search = String(options.search || '').trim().slice(0,100).toLowerCase(), page = Math.max(1,Math.min(100000,Number.parseInt(options.page,10)||1));
    const scope=this.clientScope('u.id');
    const businessId=String(options.businessId||'').slice(0,80);
    const predicate = "(?='' OR instr(lower(u.name),?)>0 OR instr(lower(u.email),?)>0 OR instr(lower(json_extract(b.settings,'$.name')),?)>0) AND (?='' OR u.business_id=?) AND "+scope.sql;
    const parameters = [search,search,search,search,businessId,businessId,...scope.parameters];
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM users u JOIN businesses b ON b.id=u.business_id WHERE ${predicate}`).get(...parameters).n;
    const rows = this.db.prepare(`SELECT u.id,u.name,u.email,u.role,u.active,u.business_id AS businessId,json_extract(b.settings,'$.name') AS businessName,p.registered_at AS registeredAt,p.last_login_at AS lastLoginAt,p.last_seen_at AS lastSeenAt,s.plan,s.status AS subscriptionStatus,
      COALESCE(a.activeSeconds,0) AS activeSeconds,COALESCE(a.actions,0) AS actions,
      (SELECT module FROM platform_usage WHERE user_id=u.id AND day>=? AND day<=? GROUP BY module ORDER BY SUM(actions) DESC,SUM(active_seconds) DESC,SUM(visits) DESC LIMIT 1) AS topModule
      FROM users u JOIN businesses b ON b.id=u.business_id LEFT JOIN platform_profiles p ON p.user_id=u.id LEFT JOIN subscriptions s ON s.business_id=u.business_id
      LEFT JOIN (SELECT user_id,SUM(active_seconds) AS activeSeconds,SUM(actions) AS actions FROM platform_usage WHERE day>=? AND day<=? GROUP BY user_id) a ON a.user_id=u.id
      WHERE ${predicate} ORDER BY p.last_seen_at DESC,u.name,u.id LIMIT 20 OFFSET ?`).all(start,end,start,end,...parameters,(page-1)*20);
    return {users:rows.map(r=>({...r,subscriptionStatus:this.businessSubscriptionStatus(r.businessId),active:!!r.active,topService:MODULES[r.topModule] || null})),total,page,pageSize:20};
  }
  profile(user, id, days) {
    this.requireAdmin(user);
    const row = this.db.prepare(`SELECT u.id,u.name,u.email,u.role,u.active,u.business_id AS businessId,b.settings,p.registered_at AS registeredAt,p.first_observed_at AS firstObservedAt,p.last_login_at AS lastLoginAt,p.last_seen_at AS lastSeenAt,s.plan,s.status AS subscriptionStatus FROM users u JOIN businesses b ON b.id=u.business_id LEFT JOIN platform_profiles p ON p.user_id=u.id LEFT JOIN subscriptions s ON s.business_id=u.business_id WHERE u.id=?`).get(id);
    if (!row) throw new AppError(404,'User not found.');
    const config = JSON.parse(row.settings), window = this.window(days);
    delete row.settings;
    return {user:{...row,subscriptionStatus:this.businessSubscriptionStatus(row.businessId),active:!!row.active},business:{name:config.name,email:config.email,phone:config.phone,address:config.address,currency:config.currency,timezone:config.timezone},window,services:this.services(window.start,window.end,id)};
  }
}
module.exports = { Analytics, MODULES };
