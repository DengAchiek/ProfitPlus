const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {Store}=require('../lib/store');
const D=require('../dist/logic');
function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'profitpulse-test-'));
  const store=new Store(dir);
  const user=store.createBusiness({businessName:'Acacia',name:'Owner',email:'owner@example.test',password:'safe-test-password-123'});
  t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
  const customer=store.saveRecord(user,'customers',{name:'Njeri',email:'njeri@example.test'});
  const lead=store.saveRecord(user,'leads',{customerId:customer.id,channel:'WhatsApp',message:'Naomba bei leo',receivedAt:new Date().toISOString(),value:2000,status:'new',priority:'auto'});
  const quote=overrides=>store.saveRecord(user,'quotes',{customerId:customer.id,leadId:lead.id,items:[{description:'Brochures',quantity:10,unitPrice:200,unitCost:80}],labour:100,transport:20,overhead:30,fixedFee:0,feePercent:1,targetMargin:25,taxPercent:16,discountPercent:0,issuedOn:'2026-10-14',expiresOn:'2026-10-28',status:'accepted',terms:'Pay in 14 days',...overrides});
  const invoice=q=>store.saveRecord(user,'invoices',{quoteId:q.id,issuedOn:'2026-10-14',dueOn:'2026-10-28',status:'open',costsFinalized:false});
  const payment=(i,overrides={})=>store.saveRecord(user,'payments',{invoiceId:i.id,amount:1000,fee:10,direction:'receipt',method:'M-Pesa',paidOn:'2026-10-14',reference:'TEST',...overrides});
  return{store,user,customer,lead,quote,invoice,payment,dir};
}
function directInvoice(f, overrides={}) {
  return f.store.saveRecord(f.user,'invoices',{customerId:f.customer.id,currency:'KES',
    quote:{currency:'KES',items:[{description:'Design service',quantity:2,unitPrice:100,unitCost:30}],labour:10,discountPercent:10,taxPercent:16,feePercent:1,fixedFee:1},
    issuedOn:'2026-10-16',dueOn:'2026-10-30',status:'open',notes:'Thank you for your business.',...overrides});
}
test('direct invoices have their own pricing and numbering, with the same payment and profit ledger',t=>{
  const f=fixture(t),invoice=directInvoice(f);
  assert.equal(invoice.quoteId,null);assert.equal(invoice.number,'INV-00001');assert.equal(f.store.list(f.user,'quotes').length,0);
  assert.equal(f.store.subscription(f.user).usage.documents,1);
  let totals=D.invoiceSummary(invoice);assert.equal(totals.revenue,180);assert.equal(totals.tax,28.8);assert.equal(totals.total,208.8);assert.equal(totals.profit,106.91);
  assert.throws(()=>f.payment(invoice,{amount:208.81}),e=>e.status===422);
  f.payment(invoice,{amount:208.8,fee:2});
  f.store.saveRecord(f.user,'expenses',{invoiceId:invoice.id,description:'Actual fulfilment',amount:70,category:'Labour',incurredOn:'2026-10-16'});
  const done=f.store.saveRecord(f.user,'invoices',{...invoice,status:'completed',costsFinalized:true},invoice.id,invoice.version);
  totals=D.invoiceSummary(done,f.store.list(f.user,'payments'),f.store.list(f.user,'expenses'));
  assert.equal(totals.balance,0);assert.equal(totals.actualProfit,108);
  assert.equal(f.invoice(f.quote()).number,'INV-00002');
});
test('direct invoices validate customer scope, pricing, dates and currency precision',t=>{
  const f=fixture(t);
  for(const input of [null,{}, {customerId:f.customer.id,quote:{}}, {customerId:f.customer.id,quoteId:{}}])assert.throws(()=>f.store.saveRecord(f.user,'invoices',input),e=>e.status===422);
  assert.throws(()=>directInvoice(f,{customerId:'missing'}),e=>e.status===422);
  assert.throws(()=>directInvoice(f,{dueOn:'2026-10-01'}),e=>e.status===422);
  assert.throws(()=>directInvoice(f,{quote:{currency:'USD',items:[{description:'Wrong currency',quantity:1,unitPrice:1,unitCost:0}]}}),e=>e.status===422);
  assert.throws(()=>directInvoice(f,{quote:{currency:'KES',items:[{description:'Too precise',quantity:1,unitPrice:1.001,unitCost:0}]}}),e=>e.status===422);
  const other=f.store.createBusiness({businessName:'Other',name:'Other',email:'invoice-other@example.test',password:'synthetic-other-password'});
  assert.throws(()=>f.store.saveRecord(other,'invoices',{customerId:f.customer.id,currency:'KES',quote:{currency:'KES',items:[{description:'Foreign customer',quantity:1,unitPrice:1,unitCost:0}]},issuedOn:'2026-10-16',dueOn:'2026-10-30',status:'open'}),e=>e.status===422);
  const archived=f.store.saveRecord(f.user,'customers',{name:'Archived customer'});
  f.store.saveRecord(f.user,'customers',{...archived,archived:true},archived.id,archived.version);
  assert.throws(()=>directInvoice(f,{customerId:archived.id}),e=>e.status===422);
  assert.equal(f.store.list(f.user,'invoices').length,0);
  const kwd=f.store.saveRecord(f.user,'customers',{name:'KWD customer',preferredCurrency:'KWD'});
  const invoice=f.store.saveRecord(f.user,'invoices',{customerId:kwd.id,quote:{items:[{description:'Precise amount',quantity:1,unitPrice:10.123,unitCost:0}]},issuedOn:'2026-10-16',dueOn:'2026-10-30',status:'open'});
  assert.equal(invoice.currency,'KWD');assert.equal(D.invoiceSummary(invoice).total,10.123);
});
test('saved direct invoices preserve their financial snapshot while dates and terms can be updated',t=>{
  const f=fixture(t),invoice=directInvoice(f),another=f.store.saveRecord(f.user,'customers',{name:'Another customer'});
  const changed=f.store.saveRecord(f.user,'invoices',{...invoice,customerId:another.id,currency:'USD',quote:{...invoice.quote,items:[{description:'Changed',quantity:1,unitPrice:1,unitCost:0}]},dueOn:'2026-11-01',terms:'Updated payment instructions'},invoice.id,invoice.version);
  assert.equal(changed.customerId,invoice.customerId);assert.equal(changed.currency,'KES');assert.deepEqual(changed.quote,invoice.quote);
  assert.equal(changed.dueOn,'2026-11-01');assert.equal(changed.terms,'Updated payment instructions');
  assert.throws(()=>f.store.saveRecord(f.user,'invoices',invoice,invoice.id,invoice.version),e=>e.status===409);
});
test('multiple direct invoices and quote conversions can be exported and restored together',t=>{
  const f=fixture(t),first=directInvoice(f),second=directInvoice(f),converted=f.invoice(f.quote());
  const backup=f.store.export(f.user),revision=f.store.business(f.user).revision;
  assert.equal(f.store.restore(f.user,backup,revision,true).counts.invoices,3);
  f.store.restore(f.user,backup,revision);
  assert.equal(f.store.get(f.user,'invoices',first.id).quoteId,null);assert.equal(f.store.get(f.user,'invoices',second.id).quoteId,null);
  assert.equal(f.store.get(f.user,'invoices',converted.id).quoteId,converted.quoteId);
  const duplicate=f.store.export(f.user),copy={...duplicate.records.invoices.find(i=>i.quoteId),id:'duplicate-invoice',number:'INV-00999'};
  duplicate.records.invoices.push(copy);
  assert.throws(()=>f.store.restore(f.user,duplicate,f.store.business(f.user).revision,true),e=>e.status===422);
});
test('connected customer → enquiry → quotation → invoice → payment → profit',t=>{
  const f=fixture(t),q=f.quote(),i=f.invoice(q);
  assert.equal(f.store.get(f.user,'leads',f.lead.id).status,'won');
  assert.equal(i.customerId,f.customer.id);
  f.payment(i,{amount:2320,fee:23.2});
  f.store.saveRecord(f.user,'expenses',{invoiceId:i.id,description:'Production',amount:1000,category:'Materials',incurredOn:'2026-10-14'});
  const done=f.store.saveRecord(f.user,'invoices',{...i,status:'completed',costsFinalized:true},i.id,i.version);
  const r=D.invoiceSummary(done,f.store.list(f.user,'payments'),f.store.list(f.user,'expenses'));
  assert.equal(r.balance,0);assert.equal(r.actualProfit,976.8);assert.equal(r.paymentStatus,'paid');
  assert.ok(f.store.activity(f.user).length>=8);
});
test('stale edits fail without losing either current data or newer unrelated records',t=>{
  const f=fixture(t),old=f.customer;
  const edited=f.store.saveRecord(f.user,'customers',{...old,notes:'First tab'},old.id,old.version);
  f.store.saveRecord(f.user,'customers',{name:'Second customer'});
  assert.throws(()=>f.store.saveRecord(f.user,'customers',{...old,notes:'Stale tab'},old.id,old.version),e=>e.status===409);
  assert.equal(f.store.get(f.user,'customers',old.id).notes,'First tab');
  assert.equal(f.store.list(f.user,'customers').length,2);assert.equal(edited.version,2);
});
test('server-side validation rejects whitespace, future received times and missing links',t=>{
  const f=fixture(t);
  assert.throws(()=>f.store.saveRecord(f.user,'customers',{name:' '}),e=>e.status===422);
  assert.throws(()=>f.store.saveRecord(f.user,'leads',{...f.lead,receivedAt:'2099-01-01T00:00:00Z'}),e=>e.status===422);
  assert.throws(()=>f.store.saveRecord(f.user,'quotes',{...f.quote(),customerId:'missing'}),e=>e.status===422);
});
test('customer contacts detect duplicates without merging unrelated records',t=>{
  const f=fixture(t);
  assert.throws(()=>f.store.saveRecord(f.user,'customers',{name:'Duplicate',email:'NJERI@example.test'}),e=>e.status===409);
});
test('records and references are isolated by business',t=>{
  const f=fixture(t),other=f.store.createBusiness({businessName:'Other',name:'Other',email:'other@example.test',password:'other-test-password-123'});
  assert.throws(()=>f.store.get(other,'customers',f.customer.id),e=>e.status===404);
  assert.throws(()=>f.store.saveRecord(other,'leads',{...f.lead,customerId:f.customer.id}),e=>e.status===422);
  assert.equal(f.store.list(other,'customers').length,0);
});
test('staff can manage records but cannot manage access, settings, or backups',t=>{
  const f=fixture(t),publicStaff=f.store.addUser(f.user,{name:'Staff',email:'staff@example.test',password:'staff-test-password-123',role:'staff'});
  const staff=f.store.authenticate(publicStaff.email,'staff-test-password-123');
  assert.ok(f.store.saveRecord(staff,'customers',{name:'Staff customer'}));
  assert.throws(()=>f.store.export(staff),e=>e.status===403);
  assert.throws(()=>f.store.saveSettings(staff,f.store.business(staff),f.store.business(staff).revision),e=>e.status===403);
  assert.throws(()=>f.store.addUser(staff,{}),e=>e.status===403);
});
test('sessions use hashed passwords, revoke on logout, and cannot disable last owner',t=>{
  const f=fixture(t),session=f.store.session(f.user);
  assert.notEqual(f.user.password,'safe-test-password-123');assert.ok(f.store.findSession(session.token));
  f.store.logout(session.token);assert.equal(f.store.findSession(session.token),undefined);
  assert.throws(()=>f.store.updateUser(f.user,f.user.id,{active:false}),e=>e.status===422);
});
test('payments enforce balances and refunds, rolling back invalid writes',t=>{
  const f=fixture(t),q=f.quote(),i=f.invoice(q);
  assert.throws(()=>f.payment(i,{direction:'refund',amount:10}),e=>e.status===422);
  assert.throws(()=>f.payment(i,{amount:2320.01}),e=>e.status===422);
  assert.equal(f.store.list(f.user,'payments').length,0);
  f.payment(i,{amount:2320});
  f.payment(i,{direction:'refund',amount:100});
  assert.equal(D.invoiceSummary(i,f.store.list(f.user,'payments')).balance,100);
});
test('paid invoices cannot be cancelled until money is refunded',t=>{
  const f=fixture(t),i=f.invoice(f.quote());f.payment(i);
  assert.throws(()=>f.store.saveRecord(f.user,'invoices',{...i,status:'cancelled'},i.id,i.version),e=>e.status===422);
  f.payment(i,{amount:1000,direction:'refund'});
  assert.equal(f.store.saveRecord(f.user,'invoices',{...i,status:'cancelled'},i.id,i.version).status,'cancelled');
});
test('invoiced quote pricing is immutable and duplicate invoicing is rejected',t=>{
  const f=fixture(t),q=f.quote();f.invoice(q);
  assert.throws(()=>f.invoice(q),e=>e.status===409);
  assert.throws(()=>f.store.saveRecord(f.user,'quotes',{...q,labour:200},q.id,q.version),e=>e.status===422);
  assert.equal(f.store.get(f.user,'quotes',q.id).labour,100);
});
test('soft archive is reversible and revisions retain history',t=>{
  const f=fixture(t),a=f.store.saveRecord(f.user,'leads',{...f.lead,archived:true},f.lead.id,f.lead.version);
  assert.equal(a.archived,true);
  const restored=f.store.saveRecord(f.user,'leads',{...a,archived:false},a.id,a.version);
  assert.equal(restored.archived,false);assert.equal(f.store.revisions(f.user,'leads',a.id).length,3);
});
test('reply drafts survive reads and subsequent edits',t=>{
  const f=fixture(t),saved=f.store.saveRecord(f.user,'leads',{...f.lead,draft:'Reviewed reply'},f.lead.id,f.lead.version);
  assert.equal(f.store.get(f.user,'leads',saved.id).draft,'Reviewed reply');
  assert.equal(f.store.saveRecord(f.user,'leads',{...saved,notes:'Follow up'},saved.id,saved.version).draft,'Reviewed reply');
});
test('portable exports exclude credentials and validate versions, duplicate ids and references',t=>{
  const f=fixture(t),b=f.store.export(f.user);
  assert.equal(b.schemaVersion,3);assert.equal(JSON.stringify(b).includes(f.user.password),false);assert.equal(b.users,undefined);
  assert.throws(()=>f.store.restore(f.user,{...b,schemaVersion:999},0,true),e=>e.status===422);
  const duplicate=structuredClone(b);duplicate.records.customers.push(duplicate.records.customers[0]);
  assert.throws(()=>f.store.restore(f.user,duplicate,0,true),e=>e.status===422);
  const broken=structuredClone(b);broken.records.leads[0].customerId='missing';
  assert.throws(()=>f.store.restore(f.user,broken,0,true),e=>e.status===422);
});
test('restore creates a safety copy, invalidates stale versions, and preserves counters',t=>{
  const f=fixture(t);f.quote();const b=f.store.export(f.user),revision=f.store.business(f.user).revision,old=f.customer;
  const result=f.store.restore(f.user,b,revision);
  assert.ok(fs.existsSync(path.join(f.dir,'backups',result.safetyFile)));
  assert.throws(()=>f.store.saveRecord(f.user,'customers',{...old,notes:'Stale before restore'},old.id,old.version),e=>e.status===409);
  assert.equal(f.quote().number,'QUO-00002');
});
test('restore rejects stale workspace revisions without modifying records',t=>{
  const f=fixture(t),b=f.store.export(f.user),revision=f.store.business(f.user).revision;
  f.store.saveRecord(f.user,'customers',{name:'New customer'});
  assert.throws(()=>f.store.restore(f.user,b,revision),e=>e.status===409);
  assert.equal(f.store.list(f.user,'customers').length,2);
});
test('legacy migration keeps existing records and excludes examples',t=>{
  const f=fixture(t),input={version:1,quotes:[],leads:[{customer:'Real contact',channel:'WhatsApp',received:new Date().toISOString(),message:'Quote please',value:300,status:'new'},{demo:true}]};
  assert.equal(f.store.legacy(f.user,input,true).skippedExamples,1);
  const b=f.store.legacy(f.user,input).backup;
  f.store.restore(f.user,b,f.store.business(f.user).revision);
  assert.equal(f.store.list(f.user,'customers').length,2);assert.equal(f.store.list(f.user,'leads').length,2);
});
test('automatic SQLite backup is verified and refreshed after later writes',async t=>{
  const f=fixture(t);await f.store.automaticBackup();assert.equal(f.store.backupStatus.error,null);
  f.store.saveRecord(f.user,'customers',{name:'After first backup'});await f.store.automaticBackup();
  const file=fs.readdirSync(path.join(f.dir,'backups')).find(n=>n.endsWith('.sqlite'));
  const db=new DatabaseSync(path.join(f.dir,'backups',file),{readOnly:true});try{assert.equal(db.prepare('SELECT COUNT(*) AS n FROM records WHERE kind=?').get('customers').n,2);assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');}finally{db.close();}
});
test('settled invoices can be archived without deleting payment history',t=>{
  const f=fixture(t),i=f.invoice(f.quote());
  assert.throws(()=>f.store.saveRecord(f.user,'invoices',{...i,archived:true},i.id,i.version),e=>e.status===422);
  f.payment(i,{amount:2320});
  const archived=f.store.saveRecord(f.user,'invoices',{...i,archived:true},i.id,i.version);
  assert.equal(archived.archived,true);
  assert.equal(f.store.list(f.user,'payments').length,1);
  assert.equal(D.invoiceSummary(archived,f.store.list(f.user,'payments')).received,2320);
});
test('linked enquiries and invoiced quotes cannot be moved to different customers',t=>{
  const f=fixture(t),q=f.quote(),i=f.invoice(q),other=f.store.saveRecord(f.user,'customers',{name:'Another customer'});
  const lead=f.store.get(f.user,'leads',f.lead.id);
  assert.throws(()=>f.store.saveRecord(f.user,'leads',{...lead,customerId:other.id},lead.id,lead.version),e=>e.status===422);
  f.store.saveRecord(f.user,'invoices',{...i,status:'cancelled'},i.id,i.version);
  assert.throws(()=>f.store.saveRecord(f.user,'quotes',{...q,customerId:other.id,leadId:null},q.id,q.version),e=>e.status===422);
  assert.ok(f.store.restore(f.user,f.store.export(f.user),null,true));
});
test('clock-skew grace does not create an unrestorable response timestamp',t=>{
  const f=fixture(t);
  let l=f.store.saveRecord(f.user,'leads',{...f.lead,receivedAt:new Date(Date.now()+30000).toISOString()});
  l=f.store.saveRecord(f.user,'leads',{...l,status:'contacted'},l.id,l.version);
  assert.ok(Date.parse(l.firstContactedAt)>=Date.parse(l.receivedAt));
  assert.ok(f.store.restore(f.user,f.store.export(f.user),null,true));
});
