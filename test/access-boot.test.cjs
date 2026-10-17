'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../dist/app.js'), 'utf8');
function client(pathname, search, fetch) {
  const context = vm.createContext({
    Pulse: require('../dist/logic'), Intl, Date, URLSearchParams, fetch,
    location: { pathname, search, hash: '' },
    history: { replaceState(_state, _title, url) { context.redirect = url; } },
    outcome: null,
  });
  vm.runInContext(source.slice(0, source.indexOf("document.addEventListener('click'")), context);
  vm.runInContext(source.slice(source.indexOf('async function boot(){'), source.lastIndexOf('boot();')), context);
  vm.runInContext("showAuth=(setup,error)=>{outcome={setup,error};};startDemo=()=>{outcome={demo:true};};", context);
  return context;
}
test('demo entry works without contacting the authentication server', async () => {
  const context = client('/app', '?demo=1', () => { throw Error('The demo must not fetch the API.'); });
  await vm.runInContext('boot()', context);
  assert.equal(context.outcome.demo, true);
});
test('missing APIs preserve signup and show a useful service error', async () => {
  const context = client('/signup', '?plan=growth', async () => ({ ok: false, status: 404, json: async () => { throw SyntaxError('Empty response'); } }));
  await vm.runInContext('boot()', context);
  assert.equal(context.outcome.setup, true);
  assert.match(context.outcome.error, /workspace service is unavailable/i);
  assert.doesNotMatch(context.outcome.error, /npm|JSON|Unexpected/);
});
test('unauthenticated visitors see the requested signup or login form', async () => {
  for (const pathname of ['/signup', '/login', '/app']) {
    const context = client(pathname, '', async () => ({ ok: false, status: 401, json: async () => ({ error: 'Sign in to continue.' }) }));
    await vm.runInContext('boot()', context);
    assert.equal(context.outcome.setup, pathname === '/signup');
    assert.equal(context.outcome.error, '');
  }
});
test('signed-in visitors at login or signup continue to their workspace', async () => {
  const context = client('/login', '', () => {});
  vm.runInContext('refresh=async()=>{};', context);
  await vm.runInContext('boot()', context);
  assert.equal(context.redirect, '/app');
});
test('admin navigation normalizes client routes and client users cannot enter admin views',()=>{
  const context=client('/app','',()=>{});
  context.document={getElementById:()=>({hidden:true})};
  vm.runInContext("renderShell=()=>{};renderView=()=>{outcome=currentView;};showToast=message=>{outcome=message;};model.platformAdmin=true;model.business.currency='KES';",context);
  for(const view of ['overview','customers','leads','quotes','invoices','reports','settings','billing','integrations']){
    vm.runInContext('go('+JSON.stringify(view)+')',context);assert.equal(context.outcome,'admin');
  }
  for(const view of ['admin','admin-clients','admin-subscribers','admin-activity','admin-performance','admin-settings']){
    vm.runInContext('go('+JSON.stringify(view)+')',context);assert.equal(context.outcome,view);
  }
  vm.runInContext('model.platformAdmin=false;go("admin-clients")',context);
  assert.match(context.outcome,/administrator access is required/);
});
