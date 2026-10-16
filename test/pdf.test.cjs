const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs');
const {documentPdf}=require('../lib/pdf');
const D=require('../dist/logic');
const business={name:'Acacia Studio',address:'Nairobi, Kenya',email:'accounts@example.test',phone:'+254700123456'};
const customer={name:'Acacia Test Customer',company:'Acacia Studio',address:'Nairobi',email:'customer@example.test',phone:'+254700123456'};
const quote={number:'QUO-TEST',version:1,status:'accepted',issuedOn:'2026-10-14',expiresOn:'2026-10-28',items:[{description:'Premium brochures',quantity:100,unitPrice:150,unitCost:65},{description:'Layout and finishing',quantity:1,unitPrice:500,unitCost:100}],labour:2000,transport:500,overhead:300,discountPercent:5,taxPercent:16,feePercent:1,fixedFee:0,targetMargin:25,terms:'Payment within 14 days.',notes:'Naomba bei ya brochures. Prepared for Réne.'};
test('a standard quote is one page with an embedded font and no blank footer page',async()=>{
  const bytes=await documentPdf(business,customer,quote,'quotes');
  assert.equal((bytes.toString('latin1').match(/\/Type \/Page\b/g)||[]).length,1);
  assert.match(bytes.toString('latin1'),/\/FontFile2/);
  if(process.env.PDF_REVIEW_OUTPUT)fs.writeFileSync(process.env.PDF_REVIEW_OUTPUT,bytes);
});
test('large quotations paginate and remain valid PDFs',async()=>{
  const bytes=await documentPdf(business,customer,{...quote,items:Array.from({length:100},(_,i)=>({description:'Production service '+(i+1),quantity:2,unitPrice:100,unitCost:30}))},'quotes');
  assert.ok((bytes.toString('latin1').match(/\/Type \/Page\b/g)||[]).length>=4);
  assert.equal(bytes.subarray(0,5).toString(),'%PDF-');
});
test('direct invoice PDFs include the invoice balance and embedded fonts',async()=>{
  const invoice={number:'INV-00001',version:1,quoteId:null,currency:'KES',customerId:'synthetic-customer',status:'open',issuedOn:'2026-10-16',dueOn:'2026-10-30',
    quote:{...D.pricing({...quote,currency:'KES'}),currency:'KES'},notes:'Thank you for your business.',terms:'Pay by bank transfer using the invoice number as your reference.'};
  const bytes=await documentPdf(business,customer,invoice,'invoices',D.invoiceSummary(invoice));
  assert.equal(bytes.subarray(0,5).toString(),'%PDF-');assert.match(bytes.toString('latin1'),/\/FontFile2/);
  assert.equal((bytes.toString('latin1').match(/\/Type \/Page\b/g)||[]).length,1);
  if(process.env.INVOICE_REVIEW_OUTPUT)fs.writeFileSync(process.env.INVOICE_REVIEW_OUTPUT,bytes);
});
