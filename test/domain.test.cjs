const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../dist/logic');
const pricing = overrides => ({items:[{description:'Brochures',quantity:100,unitPrice:150,unitCost:65}],labour:2000,transport:500,overhead:300,feePercent:1,targetMargin:25,...overrides});
test('quote arithmetic retains the original correct calculation',()=>{
  const q=D.calculateQuote(pricing());
  assert.equal(q.revenue,15000);assert.equal(q.cost,9450);assert.equal(q.profit,5550);assert.equal(q.margin,37);
});
test('discount, tax, percentage fees and fixed fees are calculated separately',()=>{
  const q=D.calculateQuote(pricing({discountPercent:10,taxPercent:16,fixedFee:20}));
  assert.equal(q.revenue,13500);assert.equal(q.tax,2160);assert.equal(q.total,15660);assert.equal(q.fees,176.6);assert.equal(q.profit,4023.4);
});
test('target net sales are rounded upward and actually attain the target',()=>{
  const q=D.calculateQuote(pricing({items:[{description:'One item',quantity:1,unitPrice:1.34,unitCost:1}],labour:0,transport:0,overhead:0,feePercent:0}));
  assert.equal(q.recommendedRevenue,1.34);assert.ok(q.margin>=25);
});
test('target accounts for fees charged on the tax-inclusive total',()=>{
  const input=pricing({taxPercent:16,fixedFee:12});
  const r=D.calculateQuote(input);
  const atTarget=D.calculateQuote({...input,items:[{description:'All items',quantity:1,unitPrice:r.recommendedRevenue,unitCost:6500}],labour:2000,transport:500,overhead:300});
  assert.ok(atTarget.margin>=25-1e-8);
});
test('invalid quantities, missing text, excessive values, and non-finite inputs are rejected',()=>{
  for(const quantity of [0,-1,Infinity,NaN])assert.throws(()=>D.calculateQuote(pricing({items:[{description:'x',quantity,unitPrice:1,unitCost:1}]})));
  assert.throws(()=>D.calculateQuote(pricing({items:[{description:' ',quantity:1,unitPrice:1,unitCost:1}]})));
  assert.throws(()=>D.calculateQuote(pricing({labour:Infinity})));
  assert.throws(()=>D.calculateQuote(pricing({items:[{description:'x',quantity:1e6,unitPrice:1e7,unitCost:1}]})));
});
test('unachievable fee and margin targets return no recommendation',()=>{
  assert.equal(D.calculateQuote(pricing({feePercent:10,targetMargin:90})).recommendedRevenue,null);
});
test('English negation suppresses buying intent and urgency',()=>{
  const p=D.priority({message:'I do not want to buy today',status:'new',receivedAt:new Date().toISOString()});
  assert.equal(p.intent,false);assert.equal(p.urgent,false);assert.equal(p.high,false);
});
test('Swahili enquiries are recognized and manual priority works',()=>{
  const l={message:'Naomba bei ya viti 20 kesho',status:'new',receivedAt:new Date().toISOString()};
  assert.equal(D.priority(l).urgent,true);assert.equal(D.priority(l).intent,true);
  assert.equal(D.priority({...l,priority:'low'}).score,0);
});
test('contacted enquiries can become overdue on a scheduled follow-up',()=>{
  const p=D.priority({message:'Thanks',status:'contacted',receivedAt:new Date().toISOString(),nextActionAt:new Date(Date.now()-1000).toISOString()});
  assert.equal(p.overdue,true);
  assert.equal(D.priority({message:'Thanks',status:'won',nextActionAt:new Date(0).toISOString(),receivedAt:new Date(0).toISOString()}).overdue,false);
});
test('actual profit requires completion and finalized costs and excludes tax',()=>{
  const invoice={id:'i',quote:pricing({taxPercent:16}),status:'open',costsFinalized:false};
  const payments=[{invoiceId:'i',amount:1000,fee:10,direction:'receipt'},{invoiceId:'i',amount:100,fee:1,direction:'refund'}];
  const costs=[{invoiceId:'i',amount:9500}];
  assert.equal(D.invoiceSummary(invoice,payments,costs).actualProfit,null);
  const r=D.invoiceSummary({...invoice,status:'completed',costsFinalized:true},payments,costs);
  assert.equal(r.received,900);assert.equal(r.actualProfit,5489);assert.equal(r.balance,16500);
});
