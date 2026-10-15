// Focused, dependency-free reproductions for the 2026-10-14 review.
// Uses a minimal document stub; this is not a browser or end-to-end test suite.
// Run from any directory: node /absolute/path/to/review/runtime-checks.cjs
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, 'v1');
const Pulse = require(path.join(root, 'logic.js'));
const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

function memoryStore(initial) {
  let value = initial === undefined ? null : JSON.stringify(initial);
  return {
    fail: false,
    getItem: () => value,
    setItem(key, next) {
      if (this.fail) throw new Error('quota exceeded');
      value = next;
    },
    snapshot: () => JSON.parse(value),
  };
}

function boot(store = memoryStore()) {
  const nodes = new Map();
  const intervals = [];
  const defaults = {
    qty: '100', price: '150', materials: '65', labour: '2000',
    transport: '500', other: '300', fee: '1', target: '25',
    filter: 'all', channel: 'WhatsApp', job: 'Audit quote',
    customer: 'Audit customer', message: 'Audit enquiry', value: '',
  };
  const get = id => {
    if (!nodes.has(id)) {
      nodes.set(id, {
        value: defaults[id] ?? '', textContent: '', innerHTML: '',
        style: {}, hidden: false, classList: { toggle() {} },
        querySelector() { return null; },
      });
    }
    return nodes.get(id);
  };
  const context = vm.createContext({
    document: { getElementById: get, querySelectorAll: () => [] },
    localStorage: store, Pulse,
    crypto: { randomUUID: () => Math.random().toString(36).slice(2) },
    setTimeout: () => 0, setInterval: fn => intervals.push(fn),
    confirm: () => true,
  });
  vm.runInContext(appSource, context);
  return { get, intervals, store, run: source => vm.runInContext(source, context) };
}

const results = [];
function submit(element) { element.onsubmit({ preventDefault() {} }); }
function observe(name, fn) {
  try { results.push({ name, ...fn() }); }
  catch (error) { results.push({ name, unexpectedError: error.message }); }
}

observe('Default quote arithmetic', () => ({
  actual: Pulse.quote({ qty: 100, price: 150, materials: 65, labour: 2000,
    transport: 500, other: 300, fee: 1, target: 25 }),
  expected: { revenue: 15000, cost: 9450, profit: 5550, margin: 37 },
}));

observe('Target plus fees of 100% is identified as unachievable', () => ({
  actual: Pulse.quote({ qty: 1, price: 100, materials: 50, labour: 0,
    transport: 0, other: 0, fee: 5, target: 95 }).recommended,
  expected: null,
}));

observe('Failed persistence still reports quote saved', () => {
  const app = boot();
  app.store.fail = true;
  submit(app.get('quoteForm'));
  return { toast: app.get('toast').textContent, stored: app.store.snapshot(),
    inMemoryQuotes: app.run('state.quotes.length') };
});

observe('Minute refresh replaces the inbox DOM', () => {
  const app = boot();
  app.get('inbox').innerHTML = 'SENTINEL UNSAVED DRAFT';
  app.intervals[0]();
  return { draftRemoved: !app.get('inbox').innerHTML.includes('SENTINEL') };
});

observe('Concurrent tabs overwrite each other', () => {
  const shared = memoryStore();
  const first = boot(shared);
  const second = boot(shared);
  first.get('job').value = 'Quote A';
  submit(first.get('quoteForm'));
  second.get('job').value = 'Quote B';
  submit(second.get('quoteForm'));
  return { storedNames: shared.snapshot().quotes.map(quote => quote.job) };
});

observe('Malformed stored records can stop initialization', () => {
  try {
    boot(memoryStore({ quotes: [null], leads: [] }));
    return { crashed: false };
  } catch (error) { return { crashed: true, error: error.message }; }
});

observe('Demo records inflate operational totals without per-record labels', () => {
  const app = boot();
  app.get('demo').onclick();
  return { metricHTML: app.get('leadMetrics').innerHTML,
    demoCount: app.run('state.leads.filter(lead => lead.demo).length'),
    visibleDemoLabel: /Synthetic|Example/.test(app.get('inbox').innerHTML) };
});

observe('Received timestamp is not refreshed after entry', () => {
  const app = boot();
  const initial = app.get('received').value;
  submit(app.get('leadForm'));
  return { initial, after: app.get('received').value,
    unchanged: initial === app.get('received').value };
});

observe('Backup accepts duplicate ids and an unknown schema version', () => {
  const app = boot();
  const lead = { id: 'same', customer: 'Test', channel: 'Email',
    received: new Date().toISOString(), message: 'Hi', value: null, status: 'new' };
  return { accepted: app.run(`valid(${JSON.stringify({
    version: 999, quotes: [], leads: [lead, lead],
  })})`) };
});

observe('Backup accepts future enquiry timestamps', () => {
  const app = boot();
  const lead = { id: 'future', customer: 'Test', channel: 'Email',
    received: '2099-01-01T00:00:00Z', message: 'Hi', value: null, status: 'new' };
  return { accepted: app.run(`valid(${JSON.stringify({
    version: 1, quotes: [], leads: [lead],
  })})`) };
});

observe('Whitespace-only fields are saved as empty strings', () => {
  const app = boot();
  app.get('job').value = '   ';
  submit(app.get('quoteForm'));
  app.get('customer').value = '   ';
  app.get('message').value = '   ';
  submit(app.get('leadForm'));
  const state = app.store.snapshot();
  return { job: state.quotes[0].job, customer: state.leads[0].customer,
    message: state.leads[0].message };
});

observe('Zero quantity produces an infinite live recommendation', () => {
  const app = boot();
  app.get('qty').value = '0';
  app.get('qty').oninput();
  return { recommendation: app.get('recommended').textContent };
});

observe('Rounded suggested price can fall below target', () => {
  const input = { qty: 1, price: 0, materials: 1, labour: 0,
    transport: 0, other: 0, fee: 0, target: 25 };
  const exact = Pulse.quote(input).recommended;
  const shown = Number(exact.toFixed(2));
  return { exact, shown, marginAtShown: Pulse.quote({ ...input, price: shown }).margin,
    target: input.target };
});

observe('Priority rules mishandle negation and miss a Swahili price enquiry', () => {
  const base = { status: 'new', received: new Date().toISOString() };
  return {
    negatedBuy: Pulse.priority({ ...base, message: 'I do not want to buy today' }),
    swahiliQuote: Pulse.priority({ ...base, message: 'Naomba bei ya viti 20' }),
  };
});

console.log(JSON.stringify({ checkCount: results.length, results }, null, 2));
