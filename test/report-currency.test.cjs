'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path'),D=require('../dist/logic');
test('the actual report and CSV functions isolate mixed-currency records and export ISO codes',()=>{
 const records=Object.fromEntries(D.kinds.map(k=>[k,[]]));
 for(const [currency,value]of[['USD',100],['JPY',10000],['KWD',10.123]]){
   const customer={id:'c-'+currency,name:currency+' Customer'},q={...D.validateRecord('quotes',{customerId:customer.id,currency,items:[{description:'Service',quantity:1,unitPrice:value,unitCost:0}],issuedOn:'2026-10-15',expiresOn:'2026-10-30',status:'accepted'}),id:'q-'+currency};
   const i={id:'i-'+currency,number:'INV-'+currency,currency,quoteId:q.id,quote:D.pricing(q),customerId:customer.id,issuedOn:'2026-10-15',dueOn:'2026-10-30',status:'completed',costsFinalized:true};records.customers.push(customer);records.quotes.push(q);records.invoices.push(i);records.payments.push({id:'p-'+currency,invoiceId:i.id,currency,amount:value,fee:0,paidOn:'2026-10-15',direction:'receipt'});
 }
 const source=fs.readFileSync(path.join(__dirname,'../dist/app.js'),'utf8'),context=vm.createContext({Pulse:D,Intl,Date,fixture:{records,users:[],business:{currency:'USD',locale:'en-US',timezone:'UTC'}},captured:null});
 vm.runInContext(source.slice(0,source.indexOf("document.addEventListener('click'")),context);
 vm.runInContext("model=fixture;filters={currency:'KWD',query:'',channel:'',from:'',to:''};download=(data,name,type)=>{captured={data,name,type};};exportReport();",context);
 const csv=context.captured.data;assert.match(csv,/"Issued","Currency","Channel"/);assert.match(csv,/"INV-KWD"/);assert.match(csv,/"KWD"/);assert.match(csv,/10\.123/);assert.doesNotMatch(csv,/INV-USD|INV-JPY/);assert.equal(csv.split('\r\n').length,2);
 const data=vm.runInContext('reportData()',context);assert.equal(data.payments,10.123);assert.equal(data.summaries.length,1);
});
