'use strict';
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const selectedCurrency=()=>filters.currency || model.business.currency || 'USD';
const money=(value,code=selectedCurrency())=>Pulse.formatMoney(Number(value || 0),code,model.business.locale || 'en-US');
const currencyOptions=()=>Pulse.currencies.map(value=>({value,label:value+' · '+new Intl.DisplayNames(['en'],{type:'currency'}).of(value)}));
function currencyControl(){return select('reportCurrency','Currency',selectedCurrency(),currencyOptions(),true).replace('name="reportCurrency"','id="currencyFilter"');}
const cap = value => String(value || '').replace(/_/g,' ').replace(/^\w/, c => c.toUpperCase());
const emptyRecords = () => Object.fromEntries(Pulse.kinds.map(k => [k, []]));
let model = { records: emptyRecords(), users: [], business: { name: 'ProfitPulse', timezone: 'UTC', currency:'USD', locale:'en-US', responseHours: 24 }, activity: [] };
let currentView = 'overview', demo = false, filters = { query: '', status: '', channel: '', from: '', to: '', archived: false, sort: 'updated' }, page = 1;
let formContext = null, formDirty = false, inlineDirty = false, settingsRevision = null, openDraft = null, importContext = null, toastTimer;
let usageTracker=null,usageUserId=null;
function syncUsage(){
  if(demo||!model.user){usageTracker?.stop();usageTracker=null;usageUserId=null;return;}
  if(usageUserId!==model.user.id){
    usageTracker?.stop();usageUserId=model.user.id;
    usageTracker=PulseUsage.create({tabId:crypto.randomUUID(),visible:()=>document.visibilityState==='visible'&&document.hasFocus(),send:(body,keepalive)=>fetch('/api/telemetry',{method:'POST',credentials:'same-origin',keepalive,headers:{'Content-Type':'application/json','X-CSRF-Token':model.csrf},body:JSON.stringify(body)})});
  }
  usageTracker.module(currentView);
}
const pageSize = 10;
const customer = id => model.records.customers.find(c => c.id === id) || { name: 'Customer unavailable' };
const member = id => { const user=model.users.find(u => u.id === id); return user ? user.name+(user.active?'':' (inactive)') : 'Unassigned'; };
const active = kind => model.records[kind].filter(r => !r.archived);
const quoteStatus = q => q.status === 'sent' && q.expiresOn < today() ? 'expired' : q.status;
function today() {
  const parts = new Intl.DateTimeFormat('en', { timeZone: model.business.timezone || 'UTC', year:'numeric',month:'2-digit',day:'2-digit' }).formatToParts(new Date());
  return ['year','month','day'].map(k => parts.find(p => p.type === k).value).join('-');
}
const plusDays = (date, n) => new Date(Date.parse(date + 'T12:00:00Z') + n * 86400000).toISOString().slice(0,10);
function localTime(value) { const d = new Date(value || Date.now()); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0,16); }
function when(value) { return value ? new Intl.DateTimeFormat(model.business.locale || 'en-US',{ timeZone:model.business.timezone || 'UTC', dateStyle:'medium', timeStyle:'short' }).format(new Date(value)) : 'No date'; }
function pill(text, type = text) { return '<span class="pill ' + esc(type) + '">' + esc(cap(text)) + '</span>'; }
function button(action, text, id = '', kind = '', cls = '') { const locked=!demo&&model.subscription&&!model.subscription.canWrite&&['new','edit','archive','restoreRecord','quoteFromLead','quoteFromCustomer','leadFromCustomer','acceptQuote','duplicateQuote','invoiceFromQuote','invoiceFromCustomer','payment','expense','draft','saveDraft','confirmImport'].includes(action); return '<button '+(locked?'disabled title="Open Subscription to continue editing" ':'')+'type="button" class="' + esc(cls) + '" data-action="' + action + '" data-id="' + esc(id) + '" data-kind="' + esc(kind) + '">' + text + '</button>'; }
function showToast(message, undo) {
  clearTimeout(toastTimer); $('toast').hidden = false; $('toast').textContent = message;
  if (undo) { const b = document.createElement('button'); b.textContent = 'Undo'; b.onclick = () => undo().catch(handleError); $('toast').append(b); }
  toastTimer = setTimeout(() => $('toast').hidden = true, undo ? 18000 : 6000);
}
function notice(message) { $('syncNotice').hidden = !message; $('syncNotice').textContent = message || ''; }
function handleError(error) { showToast(error.message || 'Something went wrong. Your edits have been kept.'); }
async function api(route, options = {}) {
  const response = await fetch('/api' + route, {
    method: options.method || 'GET', credentials: 'same-origin',
    headers: { ...(options.body ? {'Content-Type':'application/json'} : {}), ...(model.csrf ? {'X-CSRF-Token':model.csrf} : {}) },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  let result;
  try { result = await response.json(); }
  catch {
    const error = Error('The workspace service is unavailable. Please try again shortly or contact the service operator.');
    error.status = response.ok ? 503 : response.status;
    throw error;
  }
  if (!response.ok) { const error = Error(result.error || 'Request failed.'); error.status = response.status; throw error; }
  return result;
}
function download(data, name, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([typeof data === 'string' ? data : JSON.stringify(data,null,2)],{type}));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
}
async function downloadServer(route, name) {
  const response = await fetch('/api' + route, { credentials:'same-origin' });
  if (!response.ok) { let data = await response.json(); throw Error(data.error); }
  const blob = await response.blob(), url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
}
function ensureWritable() { if(demo)throw Error('This is a read-only demo. Sign in to create your own business records.');if(model.subscription&&!model.subscription.canWrite)throw Error('Your subscription needs attention. Open Billing to continue editing.'); }
async function refresh(render = true,reloadAdmin=false) {
  if (demo) { if (render) renderView(); return; }
  const previousRevision = model.business.revision;
  const data = await api('/bootstrap');
  model = data;
  $('connectionText').textContent = 'Connected · changes saved on server';
  if (render && !$('editor').open && !openDraft && !inlineDirty) { notice(''); renderShell(); if(currentView!=='admin'||!$('adminData'))renderView();else if(reloadAdmin)PlatformAdmin.reload(); }
  else if (previousRevision !== data.business.revision) notice('Workspace updates are available. Finish your current edit, then refresh.');
}
async function savedRefresh(record, kind) {
  const index = model.records[kind].findIndex(r => r.id === record.id);
  if (index >= 0) model.records[kind][index] = record; else model.records[kind].unshift(record);
  try { await refresh(false); notice(''); } catch { notice('Your change was saved on the server. Refresh is temporarily unavailable.'); }
  renderShell(); renderView();
}
async function saveRecord(kind, record, previous) {
  ensureWritable();
  const result = await api('/records/' + kind + (previous ? '/' + previous.id : ''), {method: previous ? 'PUT' : 'POST', body: previous ? {record,version:previous.version} : record});
  await savedRefresh(result, kind);
  return result;
}
function heading(title, intro, action = '') { return '<div class="page-heading"><div><h1>' + title + '</h1><p>' + intro + '</p></div>' + action + '</div>'; }
function metric(label, value, note, primary = false, negative = false) { return '<div class="metric ' + (primary ? 'primary-metric ' : '') + (negative ? 'negative' : '') + '"><label>' + esc(label) + '</label><strong>' + esc(value) + '</strong><small>' + esc(note || '') + '</small></div>'; }
function empty(title, description, action = '') { return '<div class="empty"><strong>' + title + '</strong><div>' + description + '</div>' + action + '</div>'; }
function renderShell() {
  if(currentView==='admin'&&(demo||!model.platformAdmin))currentView='overview';
  $('auth').hidden = true; $('workspace').hidden = false;
  const adminButton=$('platformAdminNav');
  if(!demo&&model.platformAdmin){if(!adminButton){const b=document.createElement('button');b.id='platformAdminNav';b.dataset.view='admin';b.innerHTML='<span>◉</span> Platform admin';b.onclick=()=>go('admin');$('navigation').append(b);}}
  else adminButton?.remove();
  $('businessLabel').textContent = model.business.name; $('workspaceName').textContent = model.business.name;
  $('accountButton').textContent = (model.user?.name || 'Demo').split(' ').map(w => w[0]).slice(0,2).join('').toUpperCase();
  $('accountButton').title = (model.user?.name || 'Demo') + ' · ' + (model.user?.role || 'Read only');
  document.querySelectorAll('.owner-only').forEach(el => el.hidden = demo || model.user?.role !== 'owner');
  document.querySelectorAll('[data-view]').forEach(el => { const selected = el.dataset.view === currentView; el.classList.toggle('active', selected); if (selected) el.setAttribute('aria-current','page'); else el.removeAttribute('aria-current'); });
  $('dueCount').textContent = active('leads').filter(l => Pulse.priority(l,Date.now(),model.business.responseHours).overdue).length || '';
  $('demoBanner').hidden = !demo;
  $('logoutButton').hidden = demo; $('exitDemo').textContent = signedInModel ? 'Return to your workspace' : needsSetup ? 'Set up your business' : 'Return to sign in';
  const sub=model.subscription; $('subscriptionBanner').hidden=demo||!sub||sub.status==='active';$('subscriptionMessage').textContent=sub?(sub.canWrite?sub.planName+' trial · '+sub.daysRemaining+' days remaining.': 'Subscription needs attention · Your records remain available to view and export.'):'';
  if (demo) $('connectionText').textContent = 'Read-only demo · synthetic records';
  try { $('legacyNotice').hidden = demo || model.user?.role !== 'owner' || !localStorage.getItem('profitpulse'); } catch { $('legacyNotice').hidden = true; }
  syncUsage();
}
function go(view) {
  if(view==='admin'&&(demo||!model.platformAdmin)){showToast('Platform administrator access is required.');return;}
  if (inlineDirty && !confirm('Leave this page and discard the unsaved settings or account form?')) { location.hash = currentView; return; }
  if (openDraft && !confirm('Leave this reply? Save or download it first if you need to keep unsaved changes.')) { location.hash = currentView; return; }
  currentView = view; filters = {query:'',status:'',channel:'',from:'',to:'',archived:false,sort:'updated',currency:model.business.currency || 'USD'}; page = 1; openDraft = null; inlineDirty = false; $('replyComposer').hidden = true;
  location.hash = view; renderShell(); renderView();
}
function toolbar(kind, report = false) {
  let statuses = kind === 'leads' ? Pulse.leadStatuses : kind === 'quotes' ? Pulse.quoteStatuses : kind === 'invoices' ? ['open','completed','cancelled','paid','partial','unpaid'] : [];
  return '<div class="toolbar">' + (!report ? '<label class="search">SEARCH<input id="searchInput" type="search" placeholder="Search customer, document, or message…" value="' + esc(filters.query) + '"></label>' : '') +
    (statuses.length ? '<label>STATUS<select id="statusFilter"><option value="">All statuses</option>' + statuses.map(s => '<option value="' + s + '"' + (filters.status === s ? ' selected' : '') + '>' + cap(s) + '</option>').join('') + '</select></label>' : '') +
    ((kind === 'leads' || report) ? '<label>CHANNEL<select id="channelFilter"><option value="">All channels</option>' + Pulse.channels.map(s => '<option' + (filters.channel === s ? ' selected' : '') + '>' + s + '</option>').join('') + '</select></label>' : '') +
    (report?currencyControl():'') + '<label>FROM<input id="fromFilter" type="date" value="' + filters.from + '"></label><label>TO<input id="toFilter" type="date" value="' + filters.to + '"></label>' +
    (!report ? '<label>SORT<select id="sortFilter"><option value="updated"' + (filters.sort === 'updated' ? ' selected' : '') + '>Recently updated</option><option value="oldest"' + (filters.sort === 'oldest' ? ' selected' : '') + '>Oldest first</option><option value="name"' + (filters.sort === 'name' ? ' selected' : '') + '>Customer A–Z</option>' + (kind === 'leads' ? '<option value="priority"' + (filters.sort === 'priority' ? ' selected' : '') + '>Highest priority</option>' : '') + '</select></label><label class="checkbox"><input id="archiveFilter" type="checkbox"' + (filters.archived ? ' checked' : '') + '> Archived only</label>' : '') + '</div>';
}
function inRange(value) {
  const raw = String(value || '');
  const parts = raw.length > 10 ? new Intl.DateTimeFormat('en', { timeZone: model.business.timezone || 'UTC', year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(new Date(raw)) : null;
  const date = parts ? ['year','month','day'].map(k=>parts.find(p=>p.type===k).value).join('-') : raw;
  return (!filters.from || date >= filters.from) && (!filters.to || date <= filters.to);
}
function filtered(kind) {
  let rows = model.records[kind].filter(r => !!r.archived === filters.archived);
  if (filters.query) { const needle = filters.query.toLowerCase(); rows = rows.filter(r => [r.name,r.company,r.phone,r.email,r.number,r.message,r.notes,customer(r.customerId).name].some(s => String(s || '').toLowerCase().includes(needle))); }
  if (filters.status) rows = rows.filter(r => (kind === 'quotes' ? quoteStatus(r) : r.status) === filters.status || (kind === 'invoices' && Pulse.invoiceSummary(r,model.records.payments,model.records.expenses).paymentStatus === filters.status));
  if (filters.channel) rows = rows.filter(r => r.channel === filters.channel);
  rows = rows.filter(r => inRange(r.receivedAt || r.issuedOn || r.createdAt));
  rows.sort((a,b) => filters.sort === 'name' ? String(a.name || customer(a.customerId).name).localeCompare(String(b.name || customer(b.customerId).name)) : filters.sort === 'oldest' ? Date.parse(a.createdAt) - Date.parse(b.createdAt) : filters.sort === 'priority' ? Pulse.priority(b,Date.now(),model.business.responseHours).score - Pulse.priority(a,Date.now(),model.business.responseHours).score || Date.parse(a.receivedAt) - Date.parse(b.receivedAt) : Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return rows;
}
function pagination(total) {
  page = Math.max(1,Math.min(page,Math.ceil(total/pageSize) || 1));
  return '<div class="pagination"><span>' + total + ' record' + (total === 1 ? '' : 's') + ' · Page ' + page + ' of ' + (Math.ceil(total/pageSize) || 1) + '</span><div>' + button('prev','← Previous') + ' ' + button('next','Next →') + '</div></div>';
}
function paginate(rows) { page = Math.max(1,Math.min(page,Math.ceil(rows.length/pageSize) || 1)); return rows.slice((page-1)*pageSize,page*pageSize); }
function rowActions(kind, r) {
  return '<div class="actions">' + button('detail','Open',r.id,kind) + (!r.archived ? button('edit','Edit',r.id,kind) : '') +
    (['quotes','invoices'].includes(kind) ? button('pdf','↓ PDF',r.id,kind) : '') +
    button(r.archived ? 'restoreRecord':'archive',r.archived ? 'Restore':'Archive',r.id,kind) + '</div>';
}
function customerTable(rows, compact = false) {
  return '<div class="table-wrap"><table class="table"><thead><tr><th>Customer</th><th>Contact</th><th>Enquiries</th><th>Quotes</th>' + (!compact ? '<th>Actions</th>' : '') + '</tr></thead><tbody>' + rows.map(c => '<tr><td class="wrap"><strong>' + esc(c.name) + '</strong><span class="row-sub">' + esc(c.company || 'Individual customer') + '</span></td><td class="wrap">' + esc(c.phone || 'No phone') + '<span class="row-sub">' + esc(c.email || 'No email') + '</span></td><td>' + active('leads').filter(l => l.customerId === c.id).length + '</td><td>' + active('quotes').filter(q => q.customerId === c.id).length + '</td>' + (!compact ? '<td>' + rowActions('customers',c) + '</td>' : '') + '</tr>').join('') + '</tbody></table></div>';
}
function quoteTable(rows) {
  return '<div class="table-wrap"><table class="table"><thead><tr><th>Quotation</th><th>Customer</th><th>Status</th><th>Total incl. tax</th><th>Est. profit</th><th>Actions</th></tr></thead><tbody>' + rows.map(q => { const r = Pulse.calculateQuote(q); const status = q.status === 'sent' && q.expiresOn < today() ? 'expired' : q.status; return '<tr><td><strong>' + esc(q.number) + '</strong><span class="row-sub">' + q.issuedOn + ' · rev ' + q.version + '</span></td><td class="wrap">' + esc(customer(q.customerId).name) + '</td><td>' + pill(status) + '</td><td>' + money(r.total,r.currency) + '</td><td class="' + (r.profit < 0 ? 'negative' : '') + '">' + money(r.profit,r.currency) + '<span class="row-sub">' + (r.margin === null ? '—' : r.margin.toFixed(1) + '% margin') + '</span></td><td>' + rowActions('quotes',q) + '</td></tr>'; }).join('') + '</tbody></table></div>';
}
function invoiceTable(rows) {
  return '<div class="table-wrap"><table class="table"><thead><tr><th>Invoice / order</th><th>Customer</th><th>Payment</th><th>Balance due</th><th>Actual profit</th><th>Actions</th></tr></thead><tbody>' + rows.map(i => { const r = Pulse.invoiceSummary(i,model.records.payments,model.records.expenses); return '<tr><td><strong>' + esc(i.number) + '</strong><span class="row-sub">Due ' + i.dueOn + ' · ' + esc(i.status) + '</span></td><td class="wrap">' + esc(customer(i.customerId).name) + '</td><td>' + pill(r.paymentStatus) + '</td><td>' + money(r.balance,r.currency) + '</td><td>' + (r.actualProfit === null ? '<span class="muted">Costs pending</span>' : money(r.actualProfit,r.currency)) + '</td><td>' + rowActions('invoices',i) + '</td></tr>'; }).join('') + '</tbody></table></div>';
}
function overview() {
  const leads = active('leads'), invoices = model.records.invoices.filter(i => i.status !== 'cancelled' && i.currency===selectedCurrency()), summaries = invoices.map(i => Pulse.invoiceSummary(i,model.records.payments,model.records.expenses));
  const overdue = leads.filter(l => Pulse.priority(l,Date.now(),model.business.responseHours).overdue);
  const received = active('payments').filter(p=>p.currency===selectedCurrency()).reduce((s,p) => s+(p.direction==='refund'?-p.amount:p.amount),0), outstanding = summaries.reduce((s,r) => s+Math.max(0,r.balance),0), profit = summaries.reduce((s,r) => s+(r.actualProfit ?? 0),0);
  const decisions = model.records.quotes.filter(q => ['accepted','declined','expired'].includes(quoteStatus(q)));
  const rate = decisions.length ? Math.round(decisions.filter(q => q.status === 'accepted').length/decisions.length*100) + '%' : '—';
  return heading('A clearer view of your business.','Your customers, follow-ups, and money — all in one place.',button('new','+ Add enquiry','','leads','primary')) +
    '<div class="toolbar">'+currencyControl()+'<p class="small">Money totals use this currency. No exchange conversion is applied.</p></div><div class="metrics">' + metric('Collected payments',money(received),'Receipts less refunds · includes tax',true) + metric('Outstanding invoices',money(outstanding),'Active invoices · includes tax') + metric('Actual profit',money(profit),'Completed orders with finalized costs',false,profit<0) + metric('Follow-ups overdue',overdue.length,'New enquiries and scheduled follow-ups') + metric('Open enquiries',leads.filter(l => !['won','lost'].includes(l.status)).length,'Across all channels') + metric('Quote acceptance',rate,'Accepted ÷ decided quotes') + '</div>' +
    '<div class="grid"><section class="card"><div class="card-head"><h2>Next on your list</h2>' + button('go','All enquiries →','','leads','quiet') + '</div>' +
    (overdue.length ? overdue.slice(0,5).map(l => '<div class="timeline-row"><span class="timeline-dot"></span><div class="full"><strong>' + esc(customer(l.customerId).name) + '</strong><small>' + esc(l.nextActionAt ? 'Follow-up due ' + when(l.nextActionAt) : 'Waiting since ' + when(l.receivedAt)) + ' · ' + esc(member(l.assignedTo)) + '</small></div>' + button('edit','Follow up',l.id,'leads') + '</div>').join('') : empty('You’re up to date.','Overdue enquiries and scheduled follow-ups will appear here.')) + '</section>' +
    '<section class="card"><div class="card-head"><h2>Recent activity</h2><span class="small">A shared history</span></div>' +
    (model.activity.length ? model.activity.slice(0,5).map(a => '<div class="timeline-row"><span class="timeline-dot"></span><div><strong>' + esc(a.userName) + '</strong> ' + esc(a.action) + ' ' + esc(a.kind) + '<small>' + when(a.occurredAt) + '</small></div></div>').join('') : empty('Your story starts here.','Add your first customer to begin.')) + '</section></div>' +
    '<section class="card"><div class="card-head"><h2>Open sales & payments</h2>' + button('go','All sales →','','invoices','quiet') + '</div>' + (invoices.length ? invoiceTable(invoices.slice(0,5)) : empty('From quote to payment.','Create an invoice directly or convert an accepted quotation to track payments and actual costs.',button('go','Create an invoice','','invoices'))) + '</section>';
}
function renderLeads(rows) {
  return '<div class="lead-list">' + rows.map(l => { const p = Pulse.priority(l,Date.now(),model.business.responseHours); return '<article class="lead-card" data-lead="' + esc(l.id) + '"><div class="lead-head"><div><h3>' + esc(customer(l.customerId).name) + '</h3><span class="small">' + esc(l.channel) + ' · ' + when(l.receivedAt) + '</span></div><div>' + pill(l.archived ? 'archived' : l.status) + ' <span data-priority="' + esc(l.id) + '">' + (p.high ? pill('Needs attention','high') : '') + '</span></div></div><p class="lead-message">' + esc(l.message) + '</p><div class="lead-meta"><span>' + esc(member(l.assignedTo)) + '</span><span>' + (l.value === null ? 'Value not entered' : money(l.value,l.currency) + ' potential value') + '</span><span class="due">' + (l.nextActionAt ? 'Next action: ' + when(l.nextActionAt) : 'No follow-up scheduled') + '</span></div><p class="small" data-reasons="' + esc(l.id) + '">' + esc(p.reasons.join(' · ')) + '</p><div class="actions">' + button('detail','Customer history',l.customerId,'customers') + button('edit','Edit / follow up',l.id,'leads') + button('history','Status history',l.id,'leads') + (!l.archived ? button('quoteFromLead','Create quote',l.id) + button('draft','Prepare reply',l.id) : '') + button(l.archived ? 'restoreRecord':'archive',l.archived ? 'Restore':'Archive',l.id,'leads') + '</div><div id="draft-' + esc(l.id) + '"></div></article>'; }).join('') + '</div>';
}
function renderList(kind) {
  const names = {customers:['People behind your business.','Keep contact details, notes, and a complete customer history.','customer'],leads:['Every enquiry, a next step.','Capture interest, assign a follow-up, and keep conversations moving.','enquiry'],quotes:['Price with confidence.','Build professional quotes and protect your margin.','quotation'],invoices:['Professional invoices, ready to send.','Create an invoice directly or from an accepted quotation, then track payments and costs.','invoice']};
  const [title,intro,label] = names[kind], rows = filtered(kind), visible = paginate(rows);
  const create = kind === 'invoices' ? '<div class="actions">'+button('new','+ Create invoice','','invoices','primary')+button('invoiceFromQuote','From quotation')+'</div>' : button('new','+ Add ' + label,'',kind,'primary');
  return heading(title,intro,create) + toolbar(kind) +
    (rows.length ? (kind === 'leads' ? renderLeads(visible) : '<section class="card">' + (kind === 'customers' ? customerTable(visible) : kind === 'quotes' ? quoteTable(visible) : invoiceTable(visible)) + '</section>') : '<section class="card">' + empty('No ' + (filters.archived ? 'archived ' : '') + label + 's here.',filters.query || filters.status || filters.from || filters.to ? 'Try changing your filters.' : kind === 'customers' ? 'Start with a customer. Their enquiries, quotes, and sales stay connected.' : kind === 'invoices' ? 'Choose Create invoice to enter items directly, or From quotation to convert accepted work.' : 'Create a customer and follow the workflow to get started.',create) + '</section>') + pagination(rows.length);
}
function salesChannel(invoice) { const q = model.records.quotes.find(q => q.id === invoice.quoteId); return model.records.leads.find(l => l.id === q?.leadId)?.channel || 'Unattributed'; }
function barChart(entries) {
  const max = Math.max(1,...entries.map(e => Math.abs(e[1]))), height = Math.max(100,entries.length*42+15);
  return '<svg class="report-chart" viewBox="0 0 480 ' + height + '" role="img" aria-label="Sales before tax by source channel">' + entries.map(([label,value],i) => '<text x="0" y="' + (i*42+20) + '">' + esc(label) + '</text><rect x="100" y="' + (i*42+6) + '" width="' + Math.max(0,Math.abs(value)/max*240) + '" height="22" rx="4" fill="#a9c47d"/><text x="350" y="' + (i*42+21) + '">' + esc(money(value)) + '</text>').join('') + '</svg>';
}
function reportData() {
  const invoices = model.records.invoices.filter(i => i.status !== 'cancelled' && i.currency===selectedCurrency() && inRange(i.issuedOn) && (!filters.channel || salesChannel(i) === filters.channel));
  const allowed = new Set(invoices.map(i => i.id));
  const paymentScope = active('payments').filter(p => p.currency===selectedCurrency() && inRange(p.paidOn) && (!filters.channel || salesChannel(model.records.invoices.find(i => i.id === p.invoiceId)) === filters.channel));
  const payments = paymentScope.reduce((s,p) => s + (p.direction === 'refund' ? -p.amount : p.amount),0);
  const receipts = paymentScope.filter(p => p.direction === 'receipt').reduce((s,p) => s+p.amount,0);
  const refunds = paymentScope.filter(p => p.direction === 'refund').reduce((s,p) => s+p.amount,0);
  const summaries = invoices.map(i => ({invoice:i,...Pulse.invoiceSummary(i,model.records.payments,model.records.expenses)}));
  const quotes = model.records.quotes.filter(q => q.currency===selectedCurrency() && inRange(q.issuedOn) && (!filters.channel || model.records.leads.find(l => l.id === q.leadId)?.channel === filters.channel));
  const decisions = quotes.filter(q => ['accepted','declined','expired'].includes(quoteStatus(q)));
  const channels = [...Pulse.channels,'Unattributed'].map(c => [c,summaries.filter(s => salesChannel(s.invoice) === c).reduce((s,r) => s+r.revenue,0)]).filter(e => e[1] !== 0);
  return {invoices,allowed,payments,receipts,refunds,summaries,quotes,decisions,channels};
}
function renderReports() {
  const r = reportData(), sum = field => r.summaries.reduce((s,row) => s+(row[field] ?? 0),0);
  const actuals = r.summaries.filter(s => s.actualProfit !== null);
  return heading('The numbers that move you.','Separate potential sales, invoiced work, collected money, and profit.',button('csv','↓ Export report','','','quiet')) + toolbar('',true) +
    '<div class="metrics">' + metric('Net payments collected',money(r.payments),'Payments dated in the selected period',true) + metric('Unpaid invoice balances',money(sum('balance')),'Invoices issued in the selected period') + metric('Net sales before tax',money(sum('revenue')),'Active invoices issued in the period') + metric('Estimated invoice profit',money(sum('profit')),'Quote costs and expected fees') + metric('Actual completed profit',money(sum('actualProfit')),actuals.length + ' completed orders with finalized costs') + metric('Quote acceptance',r.decisions.length ? (r.decisions.filter(q => q.status === 'accepted').length/r.decisions.length*100).toFixed(1)+'%' : '—','Accepted ÷ accepted, declined, expired') + '</div>' +
    '<div class="grid"><section class="card"><h2>Sales by source channel</h2>' + (r.channels.length ? barChart(r.channels) : empty('No invoiced sales yet.','Link quotes to enquiries to attribute their source.')) + '</section><section class="card"><h2>Cash & costs</h2>' +
    [['Receipts including tax',r.receipts],['Refunds including tax',r.refunds],['Actual costs recorded',sum('actualCost')],['Actual transaction fees',sum('paymentFees')],['Finalized estimated profit',actuals.reduce((s,a)=>s+a.profit,0)],['Finalized actual profit',sum('actualProfit')]].map(([label,value])=>'<div class="stat-line"><span>'+label+'</span><strong>'+money(value)+'</strong></div>').join('') + '</section></div>' +
    '<section class="card"><h2>Invoice detail</h2>' + (r.invoices.length ? invoiceTable(paginate(r.invoices))+pagination(r.invoices.length) : empty('No matching invoices.','Adjust the period or create your first invoice.')) + '</section><div class="report-definitions"><strong>How these numbers work.</strong> Monetary totals and quote acceptance use the selected currency. Exchange conversion is not applied.  Payment totals use payment dates and include tax; refunds subtract from receipts. Invoice sales and balances use invoice issue dates. Estimated profit excludes tax and uses entered costs plus expected fees. Actual profit excludes tax and appears only for completed orders with finalized costs; it uses recorded costs and actual payment fees. It is an order margin, not a cash balance. Quote acceptance uses recorded decisions. Archived quotes and invoices retain their financial history. Cancelled invoices are excluded from sales; archived payment and cost entries are excluded from calculations.</div>';
}
function renderView() {
  const renderer = currentView === 'admin' ? PlatformAdmin.render : currentView === 'overview' ? overview : currentView === 'reports' ? renderReports : currentView === 'settings' ? renderSettings : currentView === 'billing' ? renderBilling : () => renderList(currentView);
  $('content').innerHTML = renderer();
  bindToolbar();
  if(currentView==='billing'&&!demo&&model.user?.role==='owner')loadBilling();
  if(currentView==='settings'&&!demo&&model.user?.role==='owner')loadSafetyCopies();
  if(currentView==='admin')PlatformAdmin.mount();
  try{if(localStorage.getItem('profitpulse.migrated.'+model.business.id))$('legacyNotice').hidden=true;}catch{}
  if (demo) document.querySelectorAll('[data-action="new"],[data-action="edit"],[data-action="archive"],[data-action="restoreRecord"],[data-action="quoteFromLead"],[data-action="invoiceFromQuote"],[data-action="invoiceFromCustomer"],[data-action="draft"],[data-action="pdf"],[data-action="csv"]').forEach(b => b.disabled = true);
}
function bindToolbar() {
  for (const [id,key] of [['searchInput','query'],['statusFilter','status'],['channelFilter','channel'],['fromFilter','from'],['toFilter','to'],['sortFilter','sort'],['archiveFilter','archived'],['currencyFilter','currency']]) {
    if (!$(id)) continue;
    $(id).addEventListener(id === 'searchInput' ? 'input' : 'change', event => {
      filters[key] = key === 'archived' ? event.target.checked : event.target.value; page = 1;
      const caret = event.target.selectionStart; renderView();
      if (id === 'searchInput') { $(id).focus(); $(id).setSelectionRange(caret,caret); }
    });
  }
  if ($('settingsForm')) $('settingsForm').onsubmit = saveSettings;
  if ($('teamForm')) $('teamForm').onsubmit = addTeam;
  if ($('importFile')) $('importFile').onchange = event => previewImport(event.target.files[0]).catch(handleError);
  if ($('passwordForm')) $('passwordForm').onsubmit = changePassword;
}

function field(name,label,value = '',type = 'text',extra = '') { return '<label>' + label + '<input name="' + name + '" type="' + type + '" value="' + esc(value) + '" ' + extra + '></label>'; }
function area(name,label,value = '',max = 5000) { return '<label>' + label + '<textarea name="' + name + '" maxlength="' + max + '">' + esc(value) + '</textarea></label>'; }
function select(name,label,value,options,required = false) {
  return '<label>' + label + '<select name="' + name + '"' + (required ? ' required' : '') + '>' + options.map(o => { const v = typeof o === 'string' ? o : o.value, text = typeof o === 'string' ? cap(o) : o.label; return '<option value="' + esc(v) + '"' + (v === value ? ' selected' : '') + '>' + esc(text) + '</option>'; }).join('') + '</select></label>';
}
function customerOptions(selected) { return [{value:'',label:'Select a customer'},...model.records.customers.filter(c => !c.archived || c.id === selected).map(c => ({value:c.id,label:c.name + (c.company ? ' · ' + c.company : '')}))]; }
function invoiceOptions(selected) { return [{value:'',label:'Select an invoice'},...active('invoices').filter(i => i.status !== 'cancelled' || i.id === selected).map(i => ({value:i.id,label:i.number + ' · ' + customer(i.customerId).name}))]; }
function openDialog(title, html) {
  if ($('editor').open) $('editor').close();
  $('dialogTitle').textContent = title; $('dialogBody').innerHTML = html; formDirty = false; $('editor').showModal(); $('editor').scrollTop = 0;
}
function closeDialog() {
  if (formDirty && !confirm('Close this form without saving? Your entered changes will be discarded.')) return;
  $('editor').close(); formContext = null; formDirty = false;
}
function lineItem(item = {description:'',quantity:1,unitPrice:0,unitCost:0}) {
  return '<div class="line-item">' + field('description','Description',item.description,'text','required maxlength="300"') + field('quantity','Quantity',item.quantity,'number','required min="0.001" max="1000000" step="0.001"') + field('unitPrice','Unit price · currency',item.unitPrice,'number','required min="0" max="10000000" step="0.01"') + field('unitCost','Unit cost · currency',item.unitCost,'number','required min="0" max="10000000" step="0.01"') + button('removeLine','×','','','') + '</div>';
}
function defaultQuote(preset = {}) {
  return { currency:customer(preset.customerId).preferredCurrency || model.business.currency || 'USD', customerId:'',leadId:null,issuedOn:today(),expiresOn:plusDays(today(),14),status:'draft',
    items:[{description:'',quantity:1,unitPrice:0,unitCost:0}],labour:0,transport:0,overhead:0,discountPercent:0,taxPercent:0,feePercent:0,fixedFee:0,targetMargin:25,notes:'',terms:model.business.terms || '',...preset };
}
function defaultInvoice(preset = {}) {
  const source=model.records.quotes.find(q=>q.id===preset.quoteId);
  return {...defaultQuote(preset),quoteId:null,status:'open',dueOn:plusDays(today(),14),...preset,
    currency:source?.currency || preset.currency || customer(preset.customerId).preferredCurrency || model.business.currency,
    terms:source?.terms ?? preset.terms ?? model.business.terms ?? ''};
}
function pricingEditor(v) {
  return '<div class="form-section"><h3>Items & services</h3><div class="line-items" id="lineItems">'+v.items.map(lineItem).join('')+'</div>'+button('addLine','+ Add line item')+'</div>'+
    '<div class="form-section"><h3>Costs, adjustments & margin</h3><p class="small">Unit costs and margin are internal. PDFs show customer prices, tax, discounts, and payment terms.</p><div class="triple">'+
    [['labour','Labour · total currency'],['transport','Transport · total currency'],['overhead','Overhead · total currency'],['discountPercent','Discount · %'],['taxPercent','Tax · %'],['feePercent','Transaction fee · % of total'],['fixedFee','Fixed transaction fee · currency'],['targetMargin','Target margin · %']].map(([key,label])=>field(key,label,v[key],'number','required min="0" max="'+(key.includes('Percent')||key==='targetMargin'?(key==='discountPercent'?'99.9':'99'):'1000000000')+'" step="0.01"')).join('')+'</div></div><div class="calculation" id="quoteCalculation" aria-live="polite"></div>';
}
function invoiceSourcePreview(record) {
  if(!record)return '<p class="small">Select an accepted quotation to review the customer, currency, and invoice items.</p>';
  const pricing=record.quote || record,total=Pulse.calculateQuote(pricing);
  return '<p><strong>'+esc(customer(record.customerId).name)+'</strong> · Total including tax: <strong>'+money(total.total,total.currency)+'</strong></p>'+itemsTable(pricing);
}
function openForm(kind, previous = null, preset = {}) {
  ensureWritable();
  if (['leads','quotes','invoices'].includes(kind) && !active('customers').length && !previous) { go('customers'); showToast('Add a customer first, then create their enquiry, quotation, or invoice.'); return; }
  const v = previous || (kind === 'quotes' ? defaultQuote(preset) : kind === 'invoices' ? defaultInvoice(preset) : {...preset});
  const fromQuote=kind==='invoices' && Boolean(v.quoteId || preset.fromQuote);
  const editablePricing=kind==='quotes' || (kind==='invoices' && !previous && !fromQuote);
  const availableQuotes=active('quotes').filter(q=>q.status==='accepted' && !model.records.invoices.some(i=>i.quoteId===q.id && i.status!=='cancelled'));
  if(kind==='invoices' && fromQuote && !previous && !availableQuotes.length){go('quotes');showToast('Accept a quotation that has not already been invoiced, then create its invoice.');return;}
  v.currency=v.currency || model.records.invoices.find(i=>i.id===v.invoiceId)?.currency || customer(v.customerId).preferredCurrency || model.business.currency || 'USD';
  if(kind==='customers')v.preferredCurrency=v.preferredCurrency || model.business.currency || 'USD';
  formContext = {kind,previous,v,fromQuote,editablePricing};
  let html = '<form id="recordForm"><div id="formError" class="error" role="alert" tabindex="-1" hidden></div>';
  if (kind === 'customers') {
    html += '<div class="pair">' + field('name','Customer name',v.name,'text','required maxlength="100"') + field('company','Company',v.company,'text','maxlength="150"') + field('phone','Phone / WhatsApp',v.phone,'tel','maxlength="50"') + field('email','Email',v.email,'email','maxlength="254"') + '</div>' + select('preferredCurrency','Preferred currency',v.preferredCurrency,currencyOptions(),true)+area('address','Address',v.address,500) + area('notes','Customer notes',v.notes);
  } else if (kind === 'leads') {
    html += '<div class="pair">' + select('customerId','Customer',v.customerId || '',customerOptions(v.customerId),true) + select('channel','Channel',v.channel || 'WhatsApp',Pulse.channels,true) +
      select('status','Enquiry status',v.status || 'new',Pulse.leadStatuses,true) + select('assignedTo','Assigned to',v.assignedTo || '',[{value:'',label:'Unassigned'},...model.users.filter(u=>u.active).map(u=>({value:u.id,label:u.name}))]) + '</div>' +
      select('currency','Enquiry currency',v.currency,currencyOptions(),true)+area('message','Customer message',v.message) + '<div class="pair">' + field('receivedAt','Received at · device local time',localTime(v.receivedAt),'datetime-local','required') + field('nextActionAt','Next follow-up · device local time',v.nextActionAt ? localTime(v.nextActionAt) : '','datetime-local') +
      field('value','Potential sale value · currency',v.value ?? '','number','min="0" max="1000000000" step="0.01"') + select('priority','Priority',v.priority || 'auto',['auto','high','normal','low']) + '</div>' +
      (!previous ? '<label class="checkbox"><input type="checkbox" name="receivedNow" checked> Received now (uses the time when you save)</label>' : '') + area('notes','Notes / next action',v.notes) + area('lostReason','Reason if lost',v.lostReason,500);
  } else if (kind === 'quotes') {
    const leads = model.records.leads.filter(l => l.customerId === v.customerId && !l.archived);
    html += '<div class="pair">' + select('customerId','Customer',v.customerId,customerOptions(v.customerId),true) + select('leadId','Linked enquiry',v.leadId || '',[{value:'',label:'No linked enquiry'},...leads.map(l=>({value:l.id,label:l.channel+' · '+l.message.slice(0,60)}))]) +
      select('currency','Quote currency',v.currency,currencyOptions(),true)+field('issuedOn','Issue date',v.issuedOn,'date','required') + field('expiresOn','Valid until',v.expiresOn,'date','required') + select('status','Quote status',v.status,Pulse.quoteStatuses,true) + '</div>' + pricingEditor(v) +
      '<div class="form-section">' + area('notes','Quote notes (included in PDF)',v.notes) + area('terms','Payment & quotation terms (included in PDF)',v.terms,3000) + '</div>';
  } else if (kind === 'invoices') {
    html += '<div class="section-note">'+(previous?'Saved invoice amounts and customer are fixed. Update dates, terms, or order status here.':fromQuote?'The invoice inherits the accepted quotation’s customer, currency, and pricing.':'Build an invoice without a quotation. Review the items and totals before saving; saved amounts and customer are fixed.')+'</div><div class="pair">'+
      (!previous && fromQuote?select('quoteId','Accepted quotation',v.quoteId || '',[{value:'',label:'Select an accepted quote'},...availableQuotes.map(q=>({value:q.id,label:q.number+' · '+customer(q.customerId).name}))],true):!previous?select('customerId','Customer',v.customerId || '',customerOptions(v.customerId),true)+select('currency','Invoice currency',v.currency,currencyOptions(),true):'')+
      field('issuedOn','Issue date',v.issuedOn || today(),'date','required')+field('dueOn','Payment due date',v.dueOn || plusDays(today(),14),'date','required')+
      select('status','Order status',v.status || 'open',['open','completed','cancelled'],true)+'</div>'+
      (editablePricing?pricingEditor(v):'<div id="invoiceSourcePreview">'+invoiceSourcePreview(previous || model.records.quotes.find(q=>q.id===v.quoteId))+'</div>')+
      '<label class="checkbox"><input type="checkbox" name="costsFinalized"'+(v.costsFinalized?' checked':'')+'> All actual costs have been recorded</label><p class="small">Record payments and actual costs after saving. Finalize costs and mark the order completed to report actual profit.</p>'+area('notes','Invoice notes (included in PDF)',v.notes)+area('terms','Payment terms (included in PDF)',v.terms,3000);
  } else if (kind === 'payments') {
    html += '<div class="pair">' + select('invoiceId','Invoice',v.invoiceId || '',invoiceOptions(v.invoiceId),true) + select('direction','Type',v.direction || 'receipt',['receipt','refund'],true) +
      field('amount','Amount · currency',v.amount ?? '','number','required min="0.01" max="1000000000" step="0.01"') + field('fee','Actual transaction fee · currency',v.fee ?? 0,'number','required min="0" max="1000000000" step="0.01"') +
      select('method','Payment method',v.method || 'Bank',['Cash','M-Pesa','Bank','Card','Other'],true) + field('paidOn','Payment date',v.paidOn || today(),'date','required') + '</div>' +
      field('reference','Transaction / receipt reference',v.reference,'text','maxlength="150"') + area('notes','Payment notes',v.notes,1000) + '<p class="small">This records a payment you have already received or refunded. It does not transfer money.</p>';
  } else if (kind === 'expenses') {
    html += select('invoiceId','Invoice / order',v.invoiceId || '',invoiceOptions(v.invoiceId),true) + field('description','What was the cost?',v.description,'text','required maxlength="300"') + '<div class="pair">' +
      field('amount','Actual cost · currency',v.amount ?? '','number','required min="0.01" max="1000000000" step="0.01"') + select('category','Category',v.category || 'Materials',['Materials','Labour','Transport','Overhead','Other'],true) + field('incurredOn','Cost date',v.incurredOn || today(),'date','required') + '</div>';
  }
  html += '<div class="form-actions"><span class="small">Saved only after the server confirms.</span>' + button('cancelForm','Cancel') + '<button class="primary" type="submit">' + (kind==='invoices'&&!previous?'Create ':'Save ') + ({customers:'customer',leads:'enquiry',quotes:'quotation',invoices:'invoice',payments:'payment',expenses:'cost'}[kind]) + '</button></div></form>';
  openDialog((previous ? 'Edit ' : kind==='invoices' ? 'Create ' : 'Add ') + ({customers:'customer',leads:'enquiry',quotes:'quotation',invoices:'invoice',payments:'payment',expenses:'actual cost'}[kind]),html);
  $('recordForm').onsubmit = submitRecord;
  const form=$('recordForm');
  const setCashCurrency=()=>{
    const code=form.elements.currency?.value || model.records.invoices.find(i=>i.id===form.elements.invoiceId?.value)?.currency || v.currency;
    form.dataset.currency=code;
    form.querySelectorAll('input').forEach(input=>{if(['unitPrice','unitCost','labour','transport','overhead','fixedFee','amount','fee','value'].includes(input.name)){input.step=Pulse.moneyStep(code);if(input.name==='amount')input.min=Pulse.moneyStep(code);const label=input.closest('label');if(label?.firstChild?.nodeType===3)label.firstChild.textContent=label.firstChild.textContent.replace(/ · (?:total )?(?:currency|[A-Z]{3})/,' · '+code);}});
    if(editablePricing)updateCalculation();
  };
  if(form.elements.currency)form.elements.currency.onchange=()=>{form.dataset.currencyChosen='1';setCashCurrency();showToast('Currency changed. Review all entered amounts; values are not converted.');};
  if(form.elements.invoiceId)form.elements.invoiceId.onchange=setCashCurrency;
  setCashCurrency();
  $('recordForm').addEventListener('input', () => { formDirty = true; if (editablePricing) updateCalculation(); });
  if (editablePricing) {
    $('recordForm').elements.customerId.onchange = event => {
      const el = $('recordForm').elements.leadId;
      if(!previous&&form.elements.currency&&!form.dataset.currencyChosen&&[...form.querySelectorAll('[name=unitPrice],[name=unitCost],[name=labour],[name=transport],[name=overhead],[name=fixedFee]')].every(input=>!Number(input.value))){$('recordForm').elements.currency.value=customer(event.target.value).preferredCurrency || model.business.currency;setCashCurrency();}
      if(el)el.innerHTML = '<option value="">No linked enquiry</option>' + model.records.leads.filter(l => l.customerId === event.target.value && !l.archived).map(l=>'<option value="'+esc(l.id)+'">'+esc(l.channel+' · '+l.message.slice(0,60))+'</option>').join('');
    };
    updateCalculation();
  }
  if(kind==='invoices' && fromQuote && !previous){form.elements.quoteId.onchange=()=>{const source=model.records.quotes.find(q=>q.id===form.elements.quoteId.value);v.currency=source?.currency || model.business.currency;form.elements.terms.value=source?.terms || '';$('invoiceSourcePreview').innerHTML=invoiceSourcePreview(source);setCashCurrency();formDirty=true;};}
  if (kind === 'leads' && !previous) {
    const now = $('recordForm').elements.receivedNow, received = $('recordForm').elements.receivedAt;
    received.disabled = true; now.onchange = () => received.disabled = now.checked;
    $('recordForm').elements.message.required = true;
  }
  if (kind === 'leads') {form.elements.message.required = true;form.elements.customerId.onchange=event=>{if(!previous&&!form.dataset.currencyChosen&&!Number(form.elements.value.value)){form.elements.currency.value=customer(event.target.value).preferredCurrency || model.business.currency;setCashCurrency();}};}
}
function gatherForm() {
  const {kind,previous,v,editablePricing} = formContext, form = $('recordForm'), data = Object.fromEntries(new FormData(form));
  if(['payments','expenses','invoices'].includes(kind))data.currency=form.dataset.currency || previous?.currency || v.currency;
  const numberFields = editablePricing ? ['labour','transport','overhead','discountPercent','taxPercent','feePercent','fixedFee','targetMargin'] : kind === 'payments' ? ['amount','fee'] : kind === 'expenses' ? ['amount'] : [];
  for (const key of numberFields) data[key] = Number(data[key]);
  if (editablePricing) data.items = [...$('lineItems').querySelectorAll('.line-item')].map(row => Object.fromEntries(['description','quantity','unitPrice','unitCost'].map(k => [k,k==='description' ? row.querySelector('[name="'+k+'"]').value : Number(row.querySelector('[name="'+k+'"]').value)])));
  if (kind === 'leads') {
    data.receivedAt = data.receivedNow ? new Date().toISOString() : new Date(data.receivedAt).toISOString();
    data.nextActionAt = data.nextActionAt ? new Date(data.nextActionAt).toISOString() : null;
    data.value = data.value === '' ? null : Number(data.value); data.draft = previous?.draft || '';
  }
  if (kind === 'invoices') { data.costsFinalized = form.elements.costsFinalized.checked; if (previous) {data.quoteId = previous.quoteId;data.customerId=previous.customerId;data.quote=previous.quote;} else if(editablePricing){data.quoteId=null;data.quote=Pulse.pricing(data);} }
  data.archived = previous?.archived || false;
  return data;
}
function updateCalculation() {
  if (!$('quoteCalculation')) return;
  try {
    const data = gatherForm(), pricing=formContext.kind==='invoices'?data.quote:data, r = Pulse.calculateQuote(pricing);
    $('quoteCalculation').innerHTML = '<div class="totals"><div><small>Customer total incl. tax</small><strong>'+money(r.total,r.currency)+'</strong></div><div><small>Entered costs + expected fees</small><strong>'+money(r.cost,r.currency)+'</strong></div><div><small>Estimated profit ex. tax</small><strong class="'+(r.profit<0?'negative':'')+'">'+money(r.profit,r.currency)+'</strong></div><div><small>Estimated margin</small><strong>'+(r.margin===null?'—':r.margin.toFixed(1)+'%')+'</strong></div></div><p class="notice">' +
      (r.recommendedRevenue === null ? 'The target margin and fee structure are unachievable. Review them.' : 'Minimum net sales before tax for your target: '+money(r.recommendedRevenue,r.currency)+'. '+(r.margin !== null && r.margin+0.00001 >= pricing.targetMargin ? 'This '+(formContext.kind==='invoices'?'invoice':'quotation')+' meets your target.' : 'Adjust your prices to meet the target.')) +
      ' Tax is excluded from profit. Percentage transaction fees apply to the total including tax. Overhead is entered explicitly.</p>';
  } catch (error) { $('quoteCalculation').textContent = error.message; }
}
async function submitRecord(event) {
  event.preventDefault();
  const context = formContext, submit = event.target.querySelector('[type=submit]'); submit.disabled = true; $('formError').hidden = true;
  try {
    const data = gatherForm();
    if (context.kind !== 'invoices' || context.previous || !context.fromQuote) Pulse.validateRecord(context.kind,data);
    const record = await saveRecord(context.kind,data,context.previous);
    formDirty = false; $('editor').close(); formContext = null; openDraft = null;
    showToast(cap(context.kind === 'leads' ? 'enquiry' : context.kind.slice(0,-1)) + ' saved.');
    if (context.kind === 'invoices') { currentView='invoices';location.hash='invoices';renderShell();renderView();openDetail('invoices',record.id); }
  } catch (error) {
    $('formError').hidden = false; $('formError').textContent = error.message; $('formError').focus();
  } finally { submit.disabled = false; }
}
function itemsTable(q) { return '<div class="table-wrap"><table class="table"><thead><tr><th>Description</th><th>Qty</th><th>Unit price</th><th>Line total</th></tr></thead><tbody>'+q.items.map(i=>'<tr><td class="wrap">'+esc(i.description)+'</td><td>'+i.quantity+'</td><td>'+money(i.unitPrice,q.currency)+'</td><td>'+money(Pulse.round(i.quantity*i.unitPrice,q.currency),q.currency)+'</td></tr>').join('')+'</tbody></table></div>'; }
function detailsMetrics(r, actual = false) {
  return '<div class="metrics">'+metric('Total incl. tax',money(r.total,r.currency),'Net sales '+money(r.revenue,r.currency)) + (actual ? metric('Received / balance',money(r.received,r.currency),money(r.balance,r.currency)+' outstanding') + metric('Actual profit',r.actualProfit===null?'Pending':money(r.actualProfit,r.currency),'Actual costs '+money(r.actualCost,r.currency)+' · fees '+money(r.paymentFees,r.currency)) : metric('Estimated profit',money(r.profit,r.currency),'Entered costs + expected fees '+money(r.cost,r.currency)) + metric('Margin',r.margin===null?'—':r.margin.toFixed(1)+'%','Before tax')) + '</div>';
}
function ledgerTable(kind,rows) {
  if (!rows.length) return '<p class="small">No '+(kind==='payments'?'payments':'actual costs')+' recorded yet.</p>';
  return '<div class="table-wrap"><table class="table"><thead><tr><th>Date</th><th>Description</th><th>Amount</th><th>Actions</th></tr></thead><tbody>'+rows.map(r=>'<tr><td>'+esc(r.paidOn||r.incurredOn)+'</td><td class="wrap">'+esc(kind==='payments'?cap(r.direction)+' · '+r.method:r.description)+'<span class="row-sub">'+esc(r.reference||r.category||'')+(kind==='payments'?' · fee '+money(r.fee,r.currency):'')+'</span></td><td>'+money(r.amount,r.currency)+'</td><td><div class="actions">'+(r.archived?button('restoreRecord','Restore',r.id,kind):button('edit','Edit',r.id,kind)+button('archive','Archive',r.id,kind))+'</div></td></tr>').join('')+'</tbody></table></div>';
}
function openDetail(kind,id) {
  const r = model.records[kind]?.find(row=>row.id===id);
  if (!r) throw Error('Record unavailable. Refresh the workspace.');
  if (kind === 'leads') return openDetail('customers',r.customerId);
  if (['payments','expenses'].includes(kind)) return openDetail('invoices',r.invoiceId);
  let html;
  if (kind === 'customers') {
    const leads = model.records.leads.filter(l=>l.customerId===id), quotes = model.records.quotes.filter(q=>q.customerId===id), invoices=model.records.invoices.filter(i=>i.customerId===id);
    html = '<div class="pair"><div class="contact-detail"><strong>'+esc(r.company||r.name)+'</strong><p>'+[r.phone,r.email,r.address].filter(Boolean).map(esc).join('<br>')+'</p></div><div><p class="small">'+esc(r.notes||'No customer notes.')+'</p><div class="actions">'+button('edit','Edit customer',id,'customers')+button('leadFromCustomer','+ Enquiry',id)+button('quoteFromCustomer','+ Quote',id)+button('invoiceFromCustomer','+ Invoice',id)+'</div></div></div><div class="form-section"><h3>Enquiries ('+leads.length+')</h3>'+
      (leads.length?leads.map(l=>'<div class="timeline-row"><span class="timeline-dot"></span><div class="full"><strong>'+esc(l.channel)+' · '+esc(l.status)+'</strong><p class="small">'+esc(l.message)+'</p><small>'+when(l.receivedAt)+'</small></div>'+button('edit','Open',l.id,'leads')+'</div>').join(''):'<p class="small">No enquiries yet.</p>')+'</div><div class="form-section"><h3>Quotations</h3>'+ (quotes.length?quoteTable(quotes):'<p class="small">No quotations yet.</p>')+'</div><div class="form-section"><h3>Sales & payments</h3>'+ (invoices.length?invoiceTable(invoices):'<p class="small">No invoices yet.</p>')+'</div>';
  } else if (kind === 'quotes') {
    const totals = Pulse.calculateQuote(r), invoice = model.records.invoices.find(i=>i.quoteId===id&&i.status!=='cancelled');
    html = '<div class="card-head"><div>'+pill(r.status)+' <span class="small">Revision '+r.version+' · Valid until '+r.expiresOn+'</span></div><div class="actions">'+button('pdf','↓ Download PDF',id,'quotes')+button('duplicateQuote','Duplicate',id)+button('history','Revision history',id,'quotes')+'</div></div><p><strong>'+esc(customer(r.customerId).name)+'</strong></p>'+detailsMetrics(totals)+itemsTable(r)+
      '<div class="form-section"><p class="contact-detail small">'+esc(r.notes)+'</p><p class="contact-detail small">'+esc(r.terms)+'</p><div class="actions">'+button('edit','Edit quotation',id,'quotes')+(invoice?button('detail','Open '+esc(invoice.number),invoice.id,'invoices'):r.status==='accepted'?button('invoiceFromQuote','Create invoice / order',id,'','primary'):button('acceptQuote','Accept quotation',id,'','primary'))+'</div></div>';
  } else if (kind === 'invoices') {
    const totals = Pulse.invoiceSummary(r,model.records.payments,model.records.expenses);
    html = '<div class="card-head"><div>'+pill(r.status)+' '+pill(totals.paymentStatus)+' <span class="small">Due '+r.dueOn+'</span></div><div class="actions">'+button('pdf','↓ Download invoice PDF',id,'invoices','primary')+button('edit','Details / status',id,'invoices')+button('history','Change history',id,'invoices')+'</div></div><p><strong>'+esc(customer(r.customerId).name)+'</strong> · '+(r.quoteId?button('detail','Source quote',r.quoteId,'quotes'):'<span class="small">Direct invoice</span>')+'</p>'+detailsMetrics(totals,true)+
      '<div class="form-section"><div class="card-head"><h2>Payments & refunds</h2>'+button('payment','+ Record payment',id,'','primary')+'</div>'+ledgerTable('payments',active('payments').filter(p=>p.invoiceId===id))+'</div>' +
      '<div class="form-section"><div class="card-head"><h2>Actual costs</h2>'+button('expense','+ Record cost',id)+'</div>'+ledgerTable('expenses',active('expenses').filter(e=>e.invoiceId===id))+'</div>' +
      '<div class="form-section"><h3>Invoice items</h3>'+itemsTable(r.quote)+'</div><div class="form-section"><h3>Notes & payment terms</h3><p class="contact-detail small">'+esc(r.notes || 'No invoice notes.')+'</p><p class="contact-detail small">'+esc(r.terms || 'No payment terms.')+'</p></div><p class="small">Estimated profit: '+money(totals.profit,totals.currency)+'. '+(r.costsFinalized?'Actual costs finalized.':'Finalize costs and mark the order completed to report actual profit.')+'</p>'+button('archivedLedger','Archived payments & costs',id);
  }
  openDialog(kind==='customers'?r.name:r.number,html);
  if (demo) $('dialogBody').querySelectorAll('button').forEach(b=>{if(!['detail','history'].includes(b.dataset.action))b.disabled=true;});
}
function draftKey(id) { return 'profitpulse.draft.'+(model.user?.id||'guest')+'.'+id; }
function readDraft(lead) {
  try { const raw = localStorage.getItem(draftKey(lead.id)); const cached = raw ? JSON.parse(raw) : null; if(cached && typeof cached.text==='string' && Number.isInteger(cached.version)) return cached; }
  catch { notice('Draft recovery storage is unavailable. Save your reply to the server before leaving.'); }
  return {text:lead.draft||'Hi '+customer(lead.customerId).name+', thank you for your enquiry. We will review your request and confirm pricing and availability. Is there anything else we should know?',version:lead.version};
}
function prepareDraft(id) {
  ensureWritable();
  const lead = model.records.leads.find(l=>l.id===id), draft = readDraft(lead); openDraft=id;
  $('replyComposer').hidden = false;
  $('replyComposer').innerHTML='<div class="card-head"><h2>Reply to '+esc(customer(lead.customerId).name)+'</h2>'+button('closeDraft','×',id)+'</div><label>Review your reply<textarea id="replyText" maxlength="10000" rows="5"></textarea></label><div class="actions">'+button('saveDraft','Save draft',id,'','primary')+button('copyDraft','Copy reply',id)+button('downloadDraft','Download draft',id)+'</div><span class="draft-state" id="draftState">Nothing is sent automatically. Save to synchronize this draft.</span>';
  $('replyText').value=draft.text; $('replyText').dataset.version=draft.version;
  $('replyText').oninput=()=>{try{localStorage.setItem(draftKey(id),JSON.stringify({text:$('replyText').value,version:Number($('replyText').dataset.version)}));$('draftState').textContent='Unsaved changes kept on this device. Save to synchronize.';}catch{$('draftState').textContent='Device storage unavailable. Save now or download this draft.';}};
  $('replyText').focus();
}
async function saveDraft(id) {
  const lead=model.records.leads.find(l=>l.id===id), text=$('replyText').value, version=Number($('replyText').dataset.version);
  try {
    const result=await api('/records/leads/'+id,{method:'PUT',body:{record:{...lead,draft:text},version}});
    const index=model.records.leads.findIndex(l=>l.id===id);model.records.leads[index]=result;
    $('replyText').dataset.version=result.version;
    try{localStorage.removeItem(draftKey(id));}catch{}
    $('draftState').textContent='Draft saved on the server. Nothing has been sent.';
    showToast('Reply draft saved.');
  } catch(error) {$('draftState').textContent=error.message+' Download the draft before reloading the latest enquiry.';throw error;}
}
async function archiveRecord(kind,id,restore=false) {
  if(demo)throw Error('PDF downloads are available in your own workspace.');const r=model.records[kind].find(r=>r.id===id);
  const result=await saveRecord(kind,{...r,archived:!restore},r);
  if($('editor').open){formDirty=false;$('editor').close();}
  showToast(restore?'Record restored.':'Record archived. It can be restored from the archived list.',restore?null:async()=>{const restored=await saveRecord(kind,{...result,archived:false},result);showToast('Archive undone.');return restored;});
}

function renderBilling(){
  const sub=model.subscription;
  if(demo)return heading('A plan for your business.','Start a 14-day trial in your own workspace.')+'<section class="card"><a class="primary" href="/signup">Create your workspace</a></section>';
  if(model.user.role!=='owner')return heading('Subscription','Ask your business owner to manage the subscription.');
  return heading('A plan for your next chapter.','Manage your workspace subscription and billing details.')+'<section class="card"><div class="card-head"><h2>'+esc(sub.planName)+'</h2>'+pill(sub.status)+'</div><p>'+(sub.status==='trialing'?'Trial ends '+when(sub.trialEndsAt):sub.periodEndsAt?'Current period ends '+when(sub.periodEndsAt):'Choose a subscription to continue editing.')+'</p>'+(sub.cancelAtPeriodEnd?'<p class="notice">Your subscription is scheduled to cancel at the end of the current period.</p>':'')+'<p class="small">Team: '+sub.usage.seats+' / '+sub.limits.seats+' · Active customers: '+sub.usage.customers+' / '+sub.limits.customers+' · Active quotes & invoices: '+sub.usage.documents+' / '+sub.limits.documents+'</p><p class="small">Your billing currency and business record currencies are independent. Your data remains available to view and export when a subscription ends.</p>'+(sub.portalAvailable?button('portal','Manage subscription & payment details','','','primary'):'')+'</section><div id="billingPlans" aria-live="polite" class="plan-grid"><p>Loading subscription plans…</p></div><p class="small">Checkout and billing changes are handled securely by Stripe. A checkout return does not activate a plan until payment status is confirmed.</p>';
}
async function loadBilling(){
  try{const {catalog,subscription:sub,pendingCheckout}=await api('/billing');if(currentView!=='billing'||!$('billingPlans'))return;
    $('billingPlans').innerHTML=(!catalog.ready?'<div class="section-note">Paid subscriptions will be available when service pricing is configured. Contact the service operator for subscription availability.</div>':'')+catalog.plans.map(p=>'<section class="card"><span class="eyebrow">'+esc(p.name)+'</span><h2>'+esc(p.tagline)+'</h2><ul>'+p.features.map(f=>'<li>'+esc(f)+'</li>').join('')+'</ul>'+(catalog.ready?p.prices.map(price=>'<p><strong>'+esc(money(price.amount,price.currency))+'</strong> / '+esc(price.interval==='year'?'year':'month')+'</p>'+(sub.canSubscribe?button('checkout','Choose '+esc(p.name),p.id,price.currency,'primary').replace('data-action="checkout"','data-action="checkout" data-interval="'+price.interval+'"'):'')).join(''):'<p class="small">14-day trial · Paid prices available before launch</p>')+'</section>').join('')+(pendingCheckout?'<section class="card"><p>An unfinished checkout is saved. Choose the same plan to continue or cancel it before choosing another.</p>'+button('cancelCheckout','Cancel unfinished checkout')+'</section>':'');
  }catch(error){if($('billingPlans'))$('billingPlans').textContent=error.message;}
}
function renderSettings() {
  const b=model.business, owner=!demo&&model.user?.role==='owner';
  const cloudBackup=model.backupStatus?.mode==='cloudflare';
  const backupDescription=cloudBackup?'Records are stored in persistent Cloudflare SQLite storage. Export workspace backups regularly and keep a separate copy. Cloudflare database recovery is managed by the service operator.':'Records are stored on your server. Verified database snapshots run on startup and hourly, retaining 14 daily snapshots. Copy backups off this computer for protection from disk failure.';
  const backupMessage=model.backupStatus?.error?'Backup needs attention: '+model.backupStatus.error:cloudBackup?'Persistent cloud storage · Before-restore safety copies are saved with your workspace.':model.backupStatus?.lastSuccess?'Last verified backup: '+when(model.backupStatus.lastSuccess):'The first automatic backup is being prepared.';
  settingsRevision = b.revision;
  let html=heading('Your business, your workspace.','Manage business details, access, backups, and account security.');
  if(owner){
    html+='<div class="grid"><section class="card"><h2>Business & document details</h2><form id="settingsForm"><div id="settingsError" class="error" role="alert" hidden></div>'+field('name','Business name',b.name,'text','required maxlength="500"')+'<div class="pair">'+field('phone','Business phone',b.phone,'tel','maxlength="500"')+field('email','Business email',b.email,'email','maxlength="500"')+'</div>'+area('address','Business address',b.address,500)+field('taxId','Tax / registration ID',b.taxId,'text','maxlength="500"')+'<div class="pair">'+select('currency','Default currency',b.currency,currencyOptions(),true)+field('locale','Number & date locale',b.locale || 'en-US','text','required maxlength="50"')+field('timezone','Reporting timezone',b.timezone,'text','required maxlength="100"')+field('responseHours','Response target · hours',b.responseHours,'number','required min="1" max="720" step="1"')+'</div>'+area('terms','Default quotation terms',b.terms,3000)+'<button class="primary" type="submit">Save business settings</button></form></section>'+
    '<section class="card"><h2>Backups & recovery</h2><p class="small">'+esc(backupDescription)+'</p><div class="section-note">'+esc(backupMessage)+'</div><div class="actions">'+button('backup','↓ Export workspace backup','','','primary')+'</div><div class="form-section"><h3>Restore or migrate</h3><label>Choose a ProfitPulse JSON backup<input id="importFile" type="file" accept="application/json,.json"></label><p class="small">Version 2 or 3 restore replaces business records after a preview and confirmation. A safety copy is saved first. Version 1 imports append legacy records and omit synthetic examples. Maximum file size: '+esc(model.backupStatus?.maxImportMB || 50)+' MB. Changing the default currency affects new records only. Accounts, passwords, and subscription entitlements are never included in portable exports.</p></div><div class="form-section"><h3>Before-restore safety copies</h3><div id="safetyList" class="small">Loading recovery copies…</div></div></section></div>'+
    '<section class="card"><div class="card-head"><h2>Your team</h2><span class="small">Owners manage access & backups; staff manage business records.</span></div><div class="table-wrap"><table class="table"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Access</th><th>Actions</th></tr></thead><tbody>'+model.users.map(u=>'<tr><td>'+esc(u.name)+'</td><td>'+esc(u.email)+'</td><td>'+esc(u.role)+'</td><td>'+ (u.active?'Active':'Disabled')+'</td><td><div class="actions">'+button('toggleUser',u.active?'Disable access':'Enable access',u.id)+button('changeRole',u.role==='owner'?'Make staff':'Make owner',u.id)+'</div></td></tr>').join('')+'</tbody></table></div><div class="form-section"><h3>Add a team account</h3><form id="teamForm"><div id="teamError" class="error" role="alert" hidden></div><div class="pair">'+field('name','Name','','text','required maxlength="100"')+field('email','Email','','email','required maxlength="254"')+field('password','Initial password','','password','required minlength="12" maxlength="256" autocomplete="new-password"')+select('role','Permission','staff',['staff','owner'],true)+'</div><p class="small">Share the initial password privately. The team member can change it from their own account settings.</p><button class="primary" type="submit">Create team account</button></form></div></section>';
  }else html+='<section class="card"><h2>Business workspace</h2><p>'+esc(b.name)+'</p><p class="small">'+(demo?'Demo records are synthetic and read only.':'Ask an owner to update business settings, manage team access, or restore a backup.')+'</p></section>';
  if(!demo)html+='<section class="card"><h2>Your account</h2><p class="small">'+esc(model.user.name)+' · '+esc(model.user.email)+' · '+esc(model.user.role)+'</p><form id="passwordForm"><div id="passwordError" class="error" role="alert" hidden></div><div class="pair">'+field('currentPassword','Current password','','password','required autocomplete="current-password"')+field('newPassword','New password','','password','required minlength="12" maxlength="256" autocomplete="new-password"')+'</div><p class="small">Changing your password signs out your existing sessions.</p><button type="submit">Change password</button></form></section>';
  if(!demo)html+='<section class="card"><h2>Platform usage</h2><p class="small">The platform administrator can see your account profile, approximate active time, services used and application performance. Active time counts visible, focused use and stops after 60 seconds without interaction. Daily usage summaries are retained for 90 days. No passwords, session tokens or business-record contents are included in usage analytics.</p></section>';
  html+='<section class="card"><h2>Change history</h2>'+(model.activity.length?model.activity.slice(0,30).map(a=>'<div class="timeline-row"><span class="timeline-dot"></span><div>'+esc(a.userName)+' '+esc(a.action)+' '+esc(a.kind)+'<small>'+when(a.occurredAt)+'</small></div></div>').join(''):'<p class="small">Changes appear here as your team works.</p>')+'</section>';
  return html;
}
async function withForm(form,errorId,operation){
  const submit=form.querySelector('[type=submit]');submit.disabled=true;$(errorId).hidden=true;
  try{await operation(Object.fromEntries(new FormData(form)));}catch(error){$(errorId).textContent=error.message;$(errorId).hidden=false;}finally{submit.disabled=false;}
}
async function saveSettings(event){event.preventDefault();await withForm(event.target,'settingsError',async values=>{values.responseHours=Number(values.responseHours);await api('/settings',{method:'PUT',body:{settings:values,revision:settingsRevision}});inlineDirty=false;await refresh();showToast('Business settings saved.');});}
async function addTeam(event){event.preventDefault();await withForm(event.target,'teamError',async values=>{await api('/users',{method:'POST',body:values});inlineDirty=false;await refresh();showToast('Team account created.');});}
async function changePassword(event){event.preventDefault();await withForm(event.target,'passwordError',async values=>{await api('/account/password',{method:'POST',body:values});model={records:emptyRecords(),users:[],business:{timezone:'UTC',currency:'USD',locale:'en-US'}};showAuth(false);showToast('Password changed. Sign in with your new password.');});}
async function loadSafetyCopies(){
  if(!$('safetyList'))return;
  try{const result=await api('/backups');if($('safetyList'))$('safetyList').innerHTML=result.backups.length?result.backups.map(name=>'<p>'+esc(name)+' '+button('safetyBackup','↓ Download',name)+'</p>').join(''):'No restore has been performed. Safety copies will appear here.';}
  catch(error){if($('safetyList'))$('safetyList').textContent=error.message;}
}
async function previewImport(file,raw){
  ensureWritable();
  let backup;
  if(raw!==undefined){try{backup=JSON.parse(raw);}catch{throw Error('The original browser records are malformed. Download the original data before attempting recovery.');}}
  else{if(!file)return;const maxMB=model.backupStatus?.maxImportMB || 50;if(file.size>maxMB*1024*1024)throw Error('Choose a JSON backup smaller than '+maxMB+' MB.');try{backup=JSON.parse(await file.text());}catch{throw Error('This file is not valid JSON.');}}
  const legacy=![2,3].includes(backup.schemaVersion);
  const revision=model.business.revision;
  const result=await api(legacy?'/legacy/preview':'/restore/preview',{method:'POST',body:{backup}});
  importContext={backup,legacy,revision};
  const counts=Object.entries(result.counts).map(([key,n])=>'<div class="stat-line"><span>'+cap(key)+'</span><strong>'+n+'</strong></div>').join('');
  openDialog(legacy?'Preview legacy import':'Preview backup restore','<div class="section-note">'+(legacy?'Existing records will be kept. Imported records receive new identities. '+(result.skippedExamples||0)+' synthetic examples will be omitted.':'Current business records will be replaced. Team accounts are kept. A safety backup is created before any replacement.')+'</div>'+counts+'<div class="form-actions">'+button('cancelForm','Cancel')+button('confirmImport',legacy?'Import legacy records':'Replace workspace','','','primary')+'</div>');
}
async function confirmImport(){
  const context=importContext;if(!context)return;
  if(!context.legacy&&!confirm('Replace the current business records with this backup? A safety copy will be saved first.'))return;
  const result=await api(context.legacy?'/legacy':'/restore',{method:'POST',body:{backup:context.backup,revision:context.revision}});
  $('editor').close();importContext=null;formDirty=false;
  if(context.legacy){try{localStorage.setItem('profitpulse.migrated.'+model.business.id,'true');}catch{}}
  await refresh();showToast('Workspace records '+(context.legacy?'imported.':'restored. Safety copy available in Settings.'));
}
function exportReport(){
  const r=reportData(),rows=[['Invoice','Customer','Issued','Currency','Channel','Net sales before tax','Tax','Total','Collected less refunds','Balance','Estimated profit','Actual cost','Actual fees','Actual profit','Costs finalized']];
  for(const s of r.summaries)rows.push([s.invoice.number,customer(s.invoice.customerId).name,s.invoice.issuedOn,s.invoice.currency,salesChannel(s.invoice),s.revenue,s.tax,s.total,s.received,s.balance,s.profit,s.actualCost,s.paymentFees,s.actualProfit??'',s.invoice.costsFinalized]);
  const csv=rows.map(row=>row.map(value=>{let text=String(value);if(/^[=+\-@\t\r]/.test(text)&&typeof value!=='number')text="'"+text;return '"'+text.replace(/"/g,'""')+'"';}).join(',')).join('\r\n');
  download(csv,'profitpulse-report-'+today()+'.csv','text/csv;charset=utf-8');
}
let needsSetup=false,signedInModel=null;
function showAuth(setup,errorMessage=''){
  usageTracker?.stop();usageTracker=null;usageUserId=null;PlatformAdmin.clear();
  $('platformAdminNav')?.remove();
  if(currentView==='admin'){$('editor').close();$('dialogBody').replaceChildren();$('content').replaceChildren();currentView='overview';}
  inlineDirty=false;formDirty=false;openDraft=null;$('replyComposer').hidden=true;
  needsSetup=setup;$('workspace').hidden=true;$('auth').hidden=false;
  $('auth').innerHTML='<section class="auth-story"><div class="brand"><span class="brand-mark">◈</span> ProfitPulse</div><h1>Small decisions.<br>Stronger business.</h1><p>From the first enquiry to the final payment. Keep your customers close and your numbers clear.</p><div class="story-foot">CUSTOMERS · QUOTATIONS · PAYMENTS · PROFIT</div></section><section class="auth-panel"><span class="eyebrow">YOUR BUSINESS WORKSPACE</span><h2>'+(setup?'Let’s set up your business.':'Welcome back.')+'</h2><p>'+(setup?'Start your 14-day trial. No card required to create your workspace.':'Sign in to pick up where your business left off.')+'</p><form id="authForm"><div id="authError" class="error" role="alert"'+(errorMessage?'':' hidden')+'>'+esc(errorMessage)+'</div>'+(setup?field('businessName','Business name','','text','required maxlength="500"')+field('name','Your name','','text','required maxlength="100"')+select('currency','Default business currency','USD',currencyOptions(),true)+select('plan','Trial plan',new URLSearchParams(location.search).get('plan') || 'starter',['starter','growth','business'],true)+field('locale','Number & date locale',navigator.language || 'en-US','text','required maxlength="50"')+field('timezone','Business timezone',Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC','text','required maxlength="100"'):'')+field('email','Email address','','email','required autocomplete="username" maxlength="254"')+field('password',setup?'Create a ProfitPlus password':'ProfitPlus password','','password','required '+(setup?'minlength="12" autocomplete="new-password"':'autocomplete="current-password"')+' maxlength="256"')+(setup?'':'<p class="small">Use the password created for your ProfitPlus account. Google sign-in is not enabled.</p>')+'<button class="primary" type="submit">'+(setup?'Create business workspace':'Sign in')+'</button></form><button id="demoButton" class="demo-button">Explore the demo workspace →</button><p class="small">'+(setup?'Already have an account? <a href="/login">Sign in</a>. <a href="/">Back to home</a>.':'New here? <a href="/signup">Create your business workspace</a>. Team members sign in with the account their owner provides.')+'</p></section>';
  $('authForm').onsubmit=async event=>{event.preventDefault();await withForm(event.target,'authError',async values=>{const session=await api(needsSetup?'/register':'/login',{method:'POST',body:values});model.csrf=session.csrf;demo=false;history.replaceState(null,'','/app');await refresh();});};
  $('demoButton').onclick=startDemo;
}
function demoModel(){
  const stamp=new Date().toISOString(),day=today(),meta=id=>({id,version:1,createdAt:stamp,updatedAt:stamp,archived:false});
  const c1={...meta('demo-c1'),name:'Acacia Studio',company:'Acacia Creative',phone:'+254 700 000 001',email:'acacia@example.test',address:'Nairobi',notes:'Synthetic customer for the demo.'};
  const c2={...meta('demo-c2'),name:'Njeri Wanjiku',company:'',phone:'+254 700 000 002',email:'njeri@example.test',address:'Nairobi',notes:''};
  const c3={...meta('demo-c3'),name:'Kamau Events',company:'Kamau Events',phone:'',email:'kamau@example.test',address:'',notes:''};
  const lead=(id,customerId,message,status,hours,value,extra={})=>({...meta(id),currency:'USD',customerId,channel:'WhatsApp',message,status,receivedAt:new Date(Date.now()-hours*3600000).toISOString(),value,assignedTo:'demo-user',nextActionAt:null,priority:'auto',notes:'Synthetic demo record',lostReason:'',draft:'',...extra});
  const q1={...meta('demo-q1'),...defaultQuote({customerId:c1.id,leadId:'demo-l1',status:'accepted',items:[{description:'Premium printed brochures',quantity:50,unitPrice:200,unitCost:80}],labour:800,transport:250,overhead:150,discountPercent:5,taxPercent:16,feePercent:1}),number:'QUO-00001'};
  const q2={...meta('demo-q2'),...defaultQuote({customerId:c2.id,leadId:'demo-l2',status:'sent',items:[{description:'Custom tote bags',quantity:10,unitPrice:500,unitCost:200}],labour:300}),number:'QUO-00002'};
  const invoice={...meta('demo-i1'),currency:q1.currency,quoteId:q1.id,customerId:c1.id,quote:Pulse.pricing(q1),issuedOn:day,dueOn:plusDays(day,14),status:'completed',costsFinalized:true,notes:'',terms:'Demo invoice',number:'INV-00001'};
  return{user:{id:'demo-user',name:'Demo Visitor',email:'demo@example.test',role:'viewer'},users:[{id:'demo-user',name:'Amina',active:true,role:'staff'}],business:{id:'demo',name:'Acacia Business · Demo',terms:'Payment within 14 days.',timezone:'UTC',currency:'USD',locale:'en-US',responseHours:24},records:{customers:[c1,c2,c3],leads:[lead('demo-l1',c1.id,'Can you quote for 50 premium brochures?', 'won',48,11020),lead('demo-l2',c2.id,'Naomba bei ya mifuko 10. Nahitaji kesho.','quoted',26,5000,{nextActionAt:new Date(Date.now()-3600000).toISOString()}),lead('demo-l3',c3.id,'Could you send a quotation for our event today?','new',30,12000)],quotes:[q1,q2],invoices:[invoice],payments:[{...meta('demo-p1'),currency:invoice.currency,invoiceId:invoice.id,amount:11020,fee:110.2,direction:'receipt',method:'M-Pesa',paidOn:day,reference:'DEMO-RECEIPT',notes:'Synthetic payment'}],expenses:[{...meta('demo-e1'),currency:invoice.currency,invoiceId:invoice.id,description:'Materials and production',amount:5300,category:'Materials',incurredOn:day}]},activity:[{userName:'Amina',action:'recorded payment for',kind:'invoice',occurredAt:stamp},{userName:'Amina',action:'accepted',kind:'quotation',occurredAt:stamp}]};
}
function startDemo(){PlatformAdmin.clear();signedInModel=model.user?model:null;demo=true;model=demoModel();currentView='overview';renderShell();renderView();}
async function exitDemo(){demo=false;openDraft=null;if(signedInModel){model=signedInModel;signedInModel=null;await refresh();}else{model={records:emptyRecords(),users:[],business:{timezone:'UTC',currency:'USD',locale:'en-US'}};showAuth(location.pathname==='/signup');}}
async function signOut(){
  if(openDraft&&!confirm('Sign out? Unsaved reply drafts will remain on this device for your account.'))return;
  await api('/logout',{method:'POST'});openDraft=null;demo=false;model={records:emptyRecords(),users:[],business:{timezone:'UTC',currency:'USD',locale:'en-US'}};history.replaceState(null,'','/login');showAuth(false);
}
async function showHistory(kind,id){
  const rows=demo?[]:await api('/records/'+kind+'/'+id+'/history');
  openDialog('Revision history',rows.length?rows.map(row=>'<div class="history-version"><strong>'+esc(row.userName)+' · '+esc(row.action)+'</strong><p class="small">'+when(row.occurredAt)+'</p><details><summary>Saved revision details</summary><pre>'+esc(JSON.stringify(row.afterData,null,2))+'</pre></details></div>').join(''):'<p class="small">No revision history in this demo.</p>');
}
document.addEventListener('click',async event=>{
  const target=event.target.closest('button[data-action]');if(!target||target.disabled)return;
  const {action,id,kind}=target.dataset;target.disabled=true;
  try{
    if(action==='go')go(kind);
    else if(action==='new')openForm(kind);
    else if(action==='edit')openForm(kind,model.records[kind].find(r=>r.id===id));
    else if(action==='detail')openDetail(kind,id);
    else if(action==='cancelForm')closeDialog();
    else if(action==='addLine'){if($('lineItems').children.length>=100)throw Error('A document supports at most 100 items.');$('lineItems').insertAdjacentHTML('beforeend',lineItem().replaceAll('step="0.01"','step="'+Pulse.moneyStep($('recordForm').dataset.currency)+'"').replaceAll('· currency','· '+$('recordForm').dataset.currency));formDirty=true;updateCalculation();}
    else if(action==='removeLine'){if($('lineItems').children.length===1)throw Error('Keep at least one line item.');target.closest('.line-item').remove();formDirty=true;updateCalculation();}
    else if(action==='prev'){page=Math.max(1,page-1);renderView();}
    else if(action==='next'){page++;renderView();}
    else if(action==='quoteFromLead'){const l=model.records.leads.find(l=>l.id===id);openForm('quotes',null,{customerId:l.customerId,leadId:id,currency:l.currency});}
    else if(action==='quoteFromCustomer')openForm('quotes',null,{customerId:id});
    else if(action==='leadFromCustomer')openForm('leads',null,{customerId:id});
    else if(action==='duplicateQuote'){const q=model.records.quotes.find(q=>q.id===id);openForm('quotes',null,{...q,id:undefined,number:undefined,version:undefined,status:'draft',issuedOn:today(),expiresOn:plusDays(today(),14)});}
    else if(action==='acceptQuote'){const q=model.records.quotes.find(q=>q.id===id);await saveRecord('quotes',{...q,status:'accepted'},q);showToast('Quotation marked accepted.');openDetail('quotes',id);}
    else if(action==='invoiceFromQuote')openForm('invoices',null,{quoteId:id || null,fromQuote:true});
    else if(action==='invoiceFromCustomer')openForm('invoices',null,{customerId:id});
    else if(action==='payment')openForm('payments',null,{invoiceId:id});
    else if(action==='expense')openForm('expenses',null,{invoiceId:id});
    else if(action==='archivedLedger')openDialog('Archived payments & costs','<h3>Payments</h3>'+ledgerTable('payments',model.records.payments.filter(p=>p.invoiceId===id&&p.archived))+'<h3>Actual costs</h3>'+ledgerTable('expenses',model.records.expenses.filter(p=>p.invoiceId===id&&p.archived)));
    else if(action==='archive')await archiveRecord(kind,id);
    else if(action==='restoreRecord')await archiveRecord(kind,id,true);
    else if(action==='draft')prepareDraft(id);
    else if(action==='saveDraft')await saveDraft(id);
    else if(action==='copyDraft'){try{await navigator.clipboard.writeText($('replyText').value);showToast('Copied. Review and send through your chosen channel.');}catch{$('replyText').select();showToast('Select and copy the reply manually.');}}
    else if(action==='downloadDraft')download($('replyText').value,'reply-draft.txt','text/plain');
    else if(action==='closeDraft'){$('replyComposer').hidden=true;openDraft=null;}
    else if(action==='pdf'){if(demo)throw Error('PDF downloads are available in your own workspace.');const r=model.records[kind].find(r=>r.id===id);await downloadServer('/records/'+kind+'/'+id+'/pdf',r.number+'.pdf');}
    else if(action==='history')await showHistory(kind,id);
    else if(action==='checkout'){const result=await api('/billing/checkout',{method:'POST',body:{plan:id,currency:kind,interval:target.dataset.interval}});location.assign(result.url);}
    else if(action==='portal'){const result=await api('/billing/portal',{method:'POST',body:{}});location.assign(result.url);}
    else if(action==='cancelCheckout'){await api('/billing/cancel-checkout',{method:'POST',body:{}});await refresh();showToast('Unfinished checkout canceled.');}
    else if(action==='backup')await downloadServer('/backup','profitpulse-backup-'+today()+'.json');
    else if(action==='confirmImport')await confirmImport();
    else if(action==='safetyBackup')await downloadServer('/backups/'+id,id);
    else if(action==='csv')exportReport();
    else if(action==='toggleUser'||action==='changeRole'){const u=model.users.find(u=>u.id===id);if(!confirm('Change access for '+u.name+'? Their existing sessions will be signed out.'))return;await api('/users/'+id,{method:'PUT',body:action==='toggleUser'?{active:!u.active}:{role:u.role==='owner'?'staff':'owner'}});if(id===model.user.id){showAuth(false);showToast('Access updated. Sign in again.');}else{await refresh();showToast('Team access updated.');}}
  }catch(error){handleError(error);}finally{if(target.isConnected)target.disabled=false;}
});
document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>go(b.dataset.view));
$('closeDialog').onclick=closeDialog;
$('editor').addEventListener('cancel',event=>{event.preventDefault();closeDialog();});
$('syncButton').onclick=()=>{if(openDraft||inlineDirty){showToast('Save or close your current edit before refreshing.');return;}refresh(true,true).catch(handleError);};
$('exportButton').onclick=()=>downloadServer('/backup','profitpulse-backup-'+today()+'.json').catch(handleError);
$('logoutButton').onclick=()=>signOut().catch(handleError);
$('accountButton').onclick=()=>go('settings');
$('exitDemo').onclick=()=>exitDemo().catch(handleError);
$('legacyImportButton').onclick=()=>{try{previewImport(null,localStorage.getItem('profitpulse')).catch(handleError);}catch(error){handleError(error);}};
$('legacyExportButton').onclick=()=>{try{download(localStorage.getItem('profitpulse'),'profitpulse-original-browser-data.json');}catch(error){handleError(error);}};
document.addEventListener('input',event=>{if(event.target.closest('#settingsForm,#teamForm,#passwordForm'))inlineDirty=true;});
document.querySelector('.sidebar .brand').onclick=event=>{event.preventDefault();go('overview');};
window.addEventListener('hashchange',()=>{const view=location.hash.slice(1);if(['overview','customers','leads','quotes','invoices','reports','settings','billing','admin'].includes(view)&&view!==currentView)go(view);});
window.addEventListener('beforeunload',event=>{if(formDirty||inlineDirty){event.preventDefault();event.returnValue='';}});
setInterval(async()=>{
  if(demo||$('workspace').hidden)return;
  try{await refresh(!$('editor').open&&!openDraft&&!inlineDirty);}catch(error){if(error.status===401&&currentView==='admin'){showAuth(false,'Your session expired. Sign in again.');return;}$('connectionText').textContent='Offline · edits are not synchronized';notice(error.status===401?'Your session expired. Download any unsaved reply and sign in again.':'Connection lost. Existing records remain on the server; save actions will report a failure until you reconnect.');}
  if(currentView==='leads'){for(const l of active('leads')){const p=Pulse.priority(l,Date.now(),model.business.responseHours);const tag=document.querySelector('[data-priority="'+CSS.escape(l.id)+'"]'),reasons=document.querySelector('[data-reasons="'+CSS.escape(l.id)+'"]');if(tag)tag.innerHTML=p.high?pill('Needs attention','high'):'';if(reasons)reasons.textContent=p.reasons.join(' · ');}}
},30000);
for(const event of ['pointerdown','pointermove','keydown','wheel','touchstart'])document.addEventListener(event,()=>usageTracker?.activity(),{passive:true});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')usageTracker?.flush(true);});
window.addEventListener('pagehide',()=>usageTracker?.flush(true));
window.addEventListener('blur',()=>usageTracker?.flush(true));
setInterval(()=>usageTracker?.sample(),1000);
async function boot(){
  const requested=location.hash.slice(1);if(['overview','customers','leads','quotes','invoices','reports','settings','billing','admin'].includes(requested))currentView=requested;
  needsSetup=location.pathname==='/signup';
  if(new URLSearchParams(location.search).get('demo')==='1'){startDemo();return;}
  try{
    await refresh();
    if(location.pathname!=='/app')history.replaceState(null,'','/app'+location.hash);
  }catch(error){
    showAuth(needsSetup,error.status===401?'':error.status?'The workspace service is unavailable. Please try again shortly or contact the service operator.':'Unable to connect. Check your connection and try again.');
  }
}
boot();
