'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Store, AppError, publicUser } = require('./lib/store');
const D = require('./dist/logic');
const { Billing } = require('./lib/billing');
const { documentPdf } = require('./lib/pdf');
const { Analytics } = require('./lib/analytics');
const { AdminSetup } = require('./lib/admin-setup');
const { Channels, formHeaders, oauthResult } = require('./lib/channels');
const LIMIT = 50 * 1024 * 1024;
const STATIC_FILES = { '/': 'landing.html', '/index.html': 'landing.html', '/landing.css':'landing.css', '/landing.js':'landing.js', '/app':'index.html', '/signup':'index.html', '/login':'index.html', '/admin/setup':'admin-setup.html', '/admin-setup.js':'admin-setup.js', '/app.js': 'app.js', '/admin.js':'admin.js', '/usage.js':'usage.js', '/connections.js':'connections.js', '/capture.js':'capture.js', '/enquire':'enquire.html', '/enquire.js':'enquire.js', '/logic.js': 'logic.js', '/style.css': 'style.css', '/favicon.svg': 'favicon.svg' };

function createApplication(options = {}) {
  const backupLimit = options.backupLimit || LIMIT;
  const store = options.store || new Store(options.dataDir || process.env.DATA_DIR || path.join(__dirname, 'data'));
  const production = options.production ?? process.env.NODE_ENV === 'production';
  const publicOrigin = options.publicOrigin || process.env.PUBLIC_ORIGIN;
  const logger = options.logger || console;
  const analytics = new Analytics(store, { adminEmails: options.adminEmails ?? process.env.PLATFORM_ADMIN_EMAILS, adminEmailHashes:options.adminEmailHashes ?? process.env.PLATFORM_ADMIN_EMAIL_SHA256, now: options.analyticsNow });
  const adminSetup=new AdminSetup(store,analytics,options.adminSetup||{tokenHash:process.env.PLATFORM_ADMIN_SETUP_TOKEN_SHA256,emailHash:process.env.PLATFORM_ADMIN_SETUP_EMAIL_SHA256,expiresAt:process.env.PLATFORM_ADMIN_SETUP_EXPIRES_AT,mode:process.env.PLATFORM_ADMIN_SETUP_MODE},options.analyticsNow);
  const channels=new Channels(store,analytics,{...options.channels,publicOrigin,meta:options.channels?.meta||{appId:process.env.META_APP_ID,appSecret:process.env.META_APP_SECRET,version:process.env.META_API_VERSION}});
  const measure = callback => { try { return callback(); } catch (error) { logger.error('Analytics measurement failed:', error.message); } };
  if(publicOrigin){const parsed=new URL(publicOrigin);if(parsed.origin!==publicOrigin||!['https:','http:'].includes(parsed.protocol))throw Error('PUBLIC_ORIGIN must be an exact HTTP(S) origin without a path or trailing slash.');}
  if (production && (!publicOrigin || !publicOrigin.startsWith('https://'))) throw Error('Set PUBLIC_ORIGIN to the HTTPS address of this deployment.');
  const billing = new Billing(store,{...options.billing,publicOrigin});
  const attempts = options.attempts || new Map();
  const securityHeaders = {
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    ...(production ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
  };
  const cookie = token => 'pulse_session=' + token + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + (token ? 604800 : 0) + (production ? '; Secure' : '');
  function json(res, status, body, extra = {}) {
    res.writeHead(status, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
    res.end(JSON.stringify(body));
  }
  async function body(req, limit = 300000) {
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new AppError(415, 'Use application/json.');
    const chunks = [];
    let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > limit) throw new AppError(413, 'Request is too large. Maximum size is ' + (limit >= 1024 * 1024 ? limit / (1024 * 1024) + ' MB.' : Math.floor(limit / 1024) + ' KB.')); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AppError(400, 'Invalid JSON.'); }
  }
  async function rawBody(req,limit=512000){const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>limit)throw new AppError(413,'Request is too large.');chunks.push(chunk);}return Buffer.concat(chunks);}
  function guardOrigin(req) {
    const expected = publicOrigin || 'http://' + req.headers.host;
    if (req.headers.origin !== expected) throw new AppError(403, 'Request origin is not allowed.');
  }
  function auth(req) {
    const token = String(req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('pulse_session='))?.slice(14);
    const user = store.findSession(token);
    if (!user) throw new AppError(401, 'Sign in to continue.');
    if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-csrf-token'] !== user.csrf) throw new AppError(403, 'Session verification failed. Refresh and try again.');
    return { user, token };
  }
  const handleRequest = async (req, res) => {
    const started = performance.now();
    let measuredUser, measuredPath = '', responseStatus = 500;
    const writeHead = res.writeHead.bind(res);
    res.writeHead = (status, ...args) => { responseStatus = status; return writeHead(status, ...args); };
    try {
      const url = new URL(req.url, 'http://localhost');
      const route = url.pathname;
      measuredPath = route;
      channels.origin ||= publicOrigin||'http://'+req.headers.host;
      if (!route.startsWith('/api/')) {
        if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: 'Method not allowed.' });
        const files = STATIC_FILES;
        if (!files[route]) return json(res, 404, { error: 'Not found.' });
        const file = files[route], type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html';
        const bytes = req.method === 'HEAD' ? '' : fs.readFileSync(path.join(__dirname, 'dist', file));
        const pageHeaders=route==='/enquire'?formHeaders(securityHeaders,[channels.siteInfo(url.searchParams.get('site')).websiteOrigin]):securityHeaders;
        res.writeHead(200, { ...pageHeaders, 'Content-Type': type + '; charset=utf-8', 'Cache-Control':route==='/enquire'?'no-store':'no-cache' });
        return res.end(bytes);
      }
      if(route==='/api/channel-webhooks/meta'&&req.method==='GET'){const challenge=channels.verifyMeta(Object.fromEntries(url.searchParams));res.writeHead(200,{...securityHeaders,'Content-Type':'text/plain','Cache-Control':'no-store'});return res.end(challenge);}
      if(route==='/api/channel-webhooks/meta'&&req.method==='POST')return json(res,200,await channels.metaWebhook(await rawBody(req),req.headers['x-hub-signature-256']));
      const callWebhook=route.match(/^\/api\/channel-webhooks\/twilio\/([\w-]+)$/);
      if(callWebhook&&req.method==='POST'){
        if(!String(req.headers['content-type']||'').startsWith('application/x-www-form-urlencoded'))throw new AppError(415,'Use a form-encoded call callback.');
        const params={};for(const [key,value]of new URLSearchParams((await rawBody(req,64000)).toString('utf8')))params[key]=params[key]===undefined?value:Array.isArray(params[key])?[...params[key],value]:[params[key],value];
        const exactURL=String(req.url).startsWith(channels.origin+'/')?req.url:channels.origin+req.url;
        channels.twilioWebhook(callWebhook[1],params,req.headers['x-twilio-signature'],exactURL);res.writeHead(204,securityHeaders);return res.end();
      }
      const intake=route.match(/^\/api\/capture\/([\w-]+)\/(info|visit|enquiry)$/);
      if(intake){const [,id,action]=intake;
        if(action==='info'&&req.method==='GET')return json(res,200,{...channels.siteInfo(id),nonce:channels.formNonce(id)});
        if(action==='visit'){
          const info=channels.siteInfo(id);if(req.headers.origin!==info.websiteOrigin)throw new AppError(403,'This website is not allowed.');
          const cors={'Access-Control-Allow-Origin':info.websiteOrigin,'Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type','Vary':'Origin'};
          if(req.method==='OPTIONS'){res.writeHead(204,{...securityHeaders,...cors,'Cache-Control':'no-store'});return res.end();}
          if(req.method==='POST'){channels.visit(id,await body(req,10000),req.headers.origin,req.socket.remoteAddress);res.writeHead(204,{...securityHeaders,...cors,'Cache-Control':'no-store'});return res.end();}
        }
        if(action==='enquiry'&&req.method==='POST')return json(res,202,channels.websiteEnquiry(id,await body(req,15000),req.headers.origin,req.socket.remoteAddress));
      }
      if(route==='/api/billing/webhook' && req.method==='POST'){
        const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>1000000)throw new AppError(413,'Webhook too large.');chunks.push(chunk);}
        try{return json(res,200,await billing.webhook(Buffer.concat(chunks),req.headers['stripe-signature']));}catch(error){if(!error.status)throw new AppError(503,'Billing synchronization is temporarily unavailable.');throw error;}
      }
      if (!['GET', 'HEAD'].includes(req.method)) guardOrigin(req);
      if(route==='/api/admin-setup/status'&&req.method==='GET')return json(res,200,{available:!!adminSetup.available(),recovery:adminSetup.recoveryEnabled()});
      if(route==='/api/admin-setup'&&req.method==='POST'){
        const key='admin-setup:'+String(adminSetup.config.tokenHash||'disabled')+':'+req.socket.remoteAddress;
        let attempt=attempts.get(key);
        if(!attempt||attempt.reset<=Date.now())attempt={count:0,reset:Date.now()+15*60000};
        if(attempt.count>=5)throw new AppError(429,'Too many setup attempts. Try again in 15 minutes.');
        attempt.count++;attempts.set(key,attempt);
        const user=adminSetup.claim(await body(req,10000)),session=store.session(user);attempts.delete(key);attempts.delete(req.socket.remoteAddress);
        return json(res,201,{user:session.user,csrf:session.csrf},{'Set-Cookie':cookie(session.token)});
      }
      if(route==='/api/plans'&&req.method==='GET')return json(res,200,await billing.catalog());
      if (route === '/api/status' && req.method === 'GET') return json(res, 200, { needsSetup: store.needsSetup() });
      if (['/api/setup', '/api/register', '/api/login'].includes(route) && req.method === 'POST') {
        const key = req.socket.remoteAddress;
        const attempt = attempts.get(key) || { count: 0, reset: Date.now() + 15 * 60000 };
        if (attempt.reset <= Date.now()) { attempt.count = 0; attempt.reset = Date.now() + 15 * 60000; }
        if (attempt.count >= 10) throw new AppError(429, 'Too many attempts. Try again in 15 minutes.');
        attempt.count++; attempts.set(key, attempt);
        const input = await body(req);
        if (route !== '/api/login') analytics.reserveEmail(input.email);
        if (route === '/api/setup' && !store.needsSetup()) throw new AppError(409, 'This installation is already set up. Sign in or ask an owner for an account.');
        const user = route !== '/api/login' ? store.createBusiness(input) : store.authenticate(input.email, input.password);
        measure(() => { if (route !== '/api/login') analytics.registered(user); analytics.login(user); });
        const session = store.session(user);
        attempts.delete(key);
        return json(res, 200, { user: session.user, csrf: session.csrf }, { 'Set-Cookie': cookie(session.token) });
      }
      const { user, token } = auth(req);
      measuredUser = user;
      if (route.startsWith('/api/admin/')) {
        analytics.requireAdmin(user);
        if(route==='/api/admin/channel-settings'&&req.method==='GET')return json(res,200,channels.adminConfig(user));
        if(route==='/api/admin/channel-settings'&&req.method==='PUT')return json(res,200,channels.saveAdminConfig(user,await body(req,10000)));
        if (route === '/api/admin/dashboard' && req.method === 'GET') return json(res,200,analytics.dashboard(user,url.searchParams.get('days')));
        if (route === '/api/admin/clients' && req.method === 'GET') return json(res,200,analytics.clients(user,Object.fromEntries(url.searchParams)));
        if (route === '/api/admin/users' && req.method === 'GET') return json(res,200,analytics.users(user,Object.fromEntries(url.searchParams)));
        if (/^\/api\/admin\/users\/[^/]+$/.test(route) && req.method === 'GET') return json(res,200,analytics.profile(user,route.split('/')[4],url.searchParams.get('days')));
        return json(res,404,{error:'Endpoint not found.'});
      }
      if (route === '/api/telemetry' && req.method === 'POST') return json(res,200,analytics.heartbeat(user,await body(req,4096)));
      if (route === '/api/bootstrap' && req.method === 'GET') {
        if(analytics.isAdmin(user))return json(res,200,{user:publicUser(user),platformAdmin:true,csrf:user.csrf});
        channels.drain(user.business_id);return json(res, 200, { user: publicUser(user), platformAdmin:false, csrf: user.csrf, business: store.business(user), records: store.records(user), users: store.users(user), activity: store.activity(user), captureStatus:channels.summary(user),subscription:store.subscription(user), backupStatus: user.role === 'owner' ? store.backupStatus : null });
      }
      if (route === '/api/logout' && req.method === 'POST') { store.logout(token); return json(res, 200, { ok: true }, { 'Set-Cookie': cookie('') }); }
      if (route === '/api/account/password' && req.method === 'POST') { const input = await body(req); store.changePassword(user, input.currentPassword, input.newPassword); return json(res, 200, { ok: true }, { 'Set-Cookie': cookie('') }); }
      // A platform administrator is an operator, never a tenant business user.
      // Keep the boundary here so direct requests, PDFs and exports are covered
      // by the same policy in Node and the Cloudflare Durable Object.
      if(analytics.isAdmin(user))throw new AppError(403,'Platform administrators can monitor client activity but cannot access business workspaces.');
      if(route==='/api/integrations'&&req.method==='GET')return json(res,200,channels.list(user));
      if(route==='/api/integrations/website'&&req.method==='POST')return json(res,201,channels.website(user,await body(req,10000)));
      if(route==='/api/integrations/twilio'&&req.method==='POST')return json(res,201,await channels.twilio(user,await body(req,10000)));
      if(route==='/api/integrations/meta/start'&&req.method==='POST')return json(res,200,channels.startMeta(user,(await body(req)).provider));
      if(route==='/api/integrations/meta/connect'&&req.method==='POST')return json(res,201,await channels.connectMeta(user,(await body(req)).assetId));
      if(route==='/api/integrations/oauth/callback'&&req.method==='GET'){
        let result='connected';try{await channels.finishMeta(user,Object.fromEntries(url.searchParams));}catch(error){result=oauthResult(error);}
        res.writeHead(302,{...securityHeaders,'Cache-Control':'no-store',Location:'/app?channel='+result+'#integrations'});return res.end();
      }
      const disconnect=route.match(/^\/api\/integrations\/([\w-]+)\/disconnect$/);if(disconnect&&req.method==='POST')return json(res,200,await channels.disconnect(user,disconnect[1]));
      const retry=route.match(/^\/api\/integrations\/events\/([\w-]+)\/retry$/);if(retry&&req.method==='POST')return json(res,200,channels.retry(user,retry[1],(await body(req)).customerId));
      if(route==='/api/billing'&&req.method==='GET'){store.owner(user);return json(res,200,{subscription:store.subscription(user),catalog:await billing.catalog(),pendingCheckout:!!store.subscriptionRow(user).checkout_key});}
      if(route==='/api/billing/checkout'&&req.method==='POST')return json(res,200,await billing.checkout(user,await body(req)));
      if(route==='/api/billing/portal'&&req.method==='POST')return json(res,200,await billing.portal(user));
      if(route==='/api/billing/cancel-checkout'&&req.method==='POST')return json(res,200,await billing.cancelCheckout(user));
      if (route === '/api/settings' && req.method === 'PUT') { const input = await body(req); return json(res, 200, store.saveSettings(user, input.settings, input.revision)); }
      if (route === '/api/users' && req.method === 'POST') { const input = await body(req); analytics.reserveEmail(input.email); const added = store.addUser(user,input); measure(()=>analytics.registered(added)); return json(res,201,added); }
      if (/^\/api\/users\/[^/]+$/.test(route) && req.method === 'PUT') return json(res, 200, store.updateUser(user, route.split('/')[3], await body(req)));
      if (route === '/api/backup' && req.method === 'GET') {
        const bytes = Buffer.from(JSON.stringify(store.export(user), null, 2));
        if (bytes.length > backupLimit) throw new AppError(422, 'Workspace exceeds the portable backup limit. Contact the service operator for database recovery.');
        res.writeHead(200, { ...securityHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="bizatrio-' + new Date().toISOString().slice(0, 10) + '.json"' });
        return res.end(bytes);
      }
      if (route === '/api/backups' && req.method === 'GET') {
        return json(res, 200, { backups: store.listSafetyBackups(user) });
      }
      if (/^\/api\/backups\/before-restore-[\w-]+\.json$/.test(route) && req.method === 'GET') {
        const name = route.split('/')[3], data = store.readSafetyBackup(user, name);
        return json(res, 200, data, { 'Content-Disposition': 'attachment; filename="' + name + '"' });
      }
      if (['/api/restore/preview', '/api/restore', '/api/legacy/preview', '/api/legacy'].includes(route) && req.method === 'POST') {
        const input = await body(req, backupLimit);
        let result;
        if (route.startsWith('/api/legacy')) {
          if (route.endsWith('/preview')) result = store.legacy(user, input.backup, true);
          else { const legacy = store.legacy(user, input.backup); result = store.restore(user, legacy.backup, input.revision); result.skippedExamples = legacy.skippedExamples; }
        } else result = store.restore(user, input.backup, input.revision, route.endsWith('/preview'));
        return json(res, 200, result);
      }
      const match = route.match(/^\/api\/records\/(customers|leads|quotes|invoices|payments|expenses)(?:\/([^/]+))?(?:\/(pdf|history))?$/);
      if (match) {
        const [, kind, id, action] = match;
        if (action === 'history' && req.method === 'GET') return json(res, 200, store.revisions(user, kind, id));
        if (action === 'pdf' && ['quotes', 'invoices'].includes(kind) && req.method === 'GET') {
          const record = store.get(user, kind, id), customer = store.get(user, 'customers', record.customerId);
          const summary = kind === 'invoices' ? D.invoiceSummary(record, store.list(user, 'payments'), store.list(user, 'expenses')) : null;
          const bytes = await documentPdf(store.business(user), customer, record, kind, summary, options.pdfFonts);
          res.writeHead(200, { ...securityHeaders, 'Content-Type': 'application/pdf', 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="' + record.number.replace(/[^\w-]/g, '_') + '.pdf"' });
          return res.end(bytes);
        }
        if (!action && !id && req.method === 'POST') {if(kind==='leads')throw new AppError(403,'Enquiries are captured from connected customer channels. Open Connections to collect them.');return json(res, 201, store.saveRecord(user, kind, await body(req)));}
        if (!action && id && req.method === 'PUT') { const input = await body(req); return json(res, 200, store.saveRecord(user, kind, input.record, id, input.version)); }
        if (!action && id && req.method === 'GET') return json(res, 200, store.get(user, kind, id));
      }
      return json(res, 404, { error: 'Endpoint not found.' });
    } catch (error) {
      const status = error.status || 500;
      if (status === 500) logger.error(new Date().toISOString(), req.method, req.url, error.stack);
      if (!res.headersSent) json(res, status, { error: status === 500 ? 'The operation could not be saved. Your edits remain available. Please retry or contact the owner.' : error.message });
      else res.end();
    } finally {
      measure(() => analytics.request(measuredPath,req.method,responseStatus,performance.now()-started,measuredUser));
    }
  };
  const server = http.createServer(handleRequest);
  let timer;
  if (options.startTimers !== false) { store.automaticBackup(); timer = setInterval(() => store.automaticBackup(), 60 * 60000); timer.unref(); }
  return { server, store, billing, analytics, adminSetup, channels,handleRequest, close: async () => { clearInterval(timer); await new Promise(resolve => server.close(resolve));await Promise.allSettled([...channels.tasks]);while (store.backupRunning) await new Promise(resolve => setTimeout(resolve, 10)); store.close(); } };
}
if (require.main === module) {
  const app = createApplication();
  const port = Number(process.env.PORT || 8080), host = process.env.BIND_HOST || '127.0.0.1';
  app.server.listen(port, host, () => console.log('BizAtrio is running at http://' + host + ':' + port));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => app.close().then(() => process.exit(0)));
}
module.exports = { createApplication, STATIC_FILES };
