'use strict';
const Stripe = require('stripe');
const { AppError } = require('./store');
const { PLANS, TRIAL_DAYS } = require('./plans');
const D = require('../dist/logic');
class Billing {
  constructor(store, options={}) {
    this.store=store;
    this.origin=options.publicOrigin || process.env.PUBLIC_ORIGIN;
    this.secret=options.webhookSecret || process.env.STRIPE_WEBHOOK_SECRET;
    this.stripe=options.stripe || (process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY,{maxNetworkRetries:2,timeout:20000}) : null);
    this.prices=options.prices || JSON.parse(process.env.STRIPE_PRICES_JSON || '{}');
    this.mapping=new Map(); this.cache=null;
    for(const [plan,currencies] of Object.entries(this.prices)) {
      if(!PLANS[plan])throw Error('Unknown Stripe plan: '+plan);
      for(const [currency,intervals] of Object.entries(currencies)) {
        D.currency(currency);
        for(const [interval,id] of Object.entries(intervals)) {
          if(!['month','year'].includes(interval)||typeof id!=='string'||!/^price_[A-Za-z0-9_]+$/.test(id)||this.mapping.has(id))throw Error('Invalid or duplicate Stripe price mapping.');
          this.mapping.set(id,{plan,currency,interval,priceId:id});
        }
      }
    }
  }
  ready() {return !!(this.stripe&&this.secret&&this.origin&&this.mapping.size);}
  requireReady(){if(!this.ready())throw new AppError(503,'Subscriptions are not available yet. Please contact the service operator before your trial ends.');}
  async catalog(){
    const base={trialDays:TRIAL_DAYS,ready:this.ready(),plans:Object.values(PLANS).map(p=>({...p,prices:[]}))};
    if(!base.ready)return base;
    if(this.cache&&this.cache.expires>Date.now())return this.cache.value;
    for(const choice of this.mapping.values()) {
      const price=await this.stripe.prices.retrieve(choice.priceId);
      if(!price.active||price.type!=='recurring'||price.recurring?.interval!==choice.interval||price.recurring?.interval_count!==1||price.currency?.toUpperCase()!==choice.currency||!Number.isInteger(price.unit_amount)||price.unit_amount<=0||price.billing_scheme!=='per_unit'||price.transform_quantity)throw new AppError(503,'Subscription pricing is temporarily unavailable. Please contact the service operator.');
      base.plans.find(p=>p.id===choice.plan).prices.push({...choice,amount:price.unit_amount/10**(['ISK','UGX'].includes(choice.currency)?2:D.digits(choice.currency))});
    }
    this.cache={value:base,expires:Date.now()+60000}; return base;
  }
  trustedURL(value,host){const url=new URL(value);if(url.protocol!=='https:'||url.hostname!==host)throw Error('Unexpected billing redirect.');return url.href;}
  async checkout(user,input){
    this.store.owner(user);this.requireReady();
    const catalog=await this.catalog(), choice=catalog.plans.find(p=>p.id===input.plan)?.prices.find(p=>p.currency===input.currency&&p.interval===input.interval);
    if(!choice)throw new AppError(422,'Choose an available subscription plan, currency and billing interval.');
    const current=this.store.subscriptionRow(user);
    if(current.subscription_id&&!['canceled','incomplete_expired'].includes(current.status))throw new AppError(409,'Manage your existing subscription through the billing portal.');
    const row=this.store.claimCheckout(user,choice);
    try {
      let customer=row.customer_id;
      if(!customer){const result=await this.stripe.customers.create({metadata:{businessId:user.business_id}},{idempotencyKey:'customer-'+user.business_id});customer=result.id;this.store.setBillingCustomer(user,customer);}
      if(row.checkout_session_id){const existing=await this.stripe.checkout.sessions.retrieve(row.checkout_session_id);if(existing.status==='open'&&existing.url){this.store.releaseCheckout(user);return{url:this.trustedURL(existing.url,'checkout.stripe.com')};}if(existing.status==='complete')throw new AppError(409,'Checkout completed. Your subscription is being synchronized; refresh shortly.');throw new AppError(409,'This checkout expired. Cancel the unfinished checkout, then try again.');}
      const session=await this.stripe.checkout.sessions.create({mode:'subscription',customer,line_items:[{price:choice.priceId,quantity:1}],client_reference_id:user.business_id,metadata:{businessId:user.business_id},subscription_data:{metadata:{businessId:user.business_id},...(row.checkout_trial_end?{trial_end:row.checkout_trial_end}:{})},success_url:this.origin+'/app?checkout=success#billing',cancel_url:this.origin+'/app?checkout=canceled#billing',expires_at:Math.floor(row.checkout_expires/1000)}, {idempotencyKey:'checkout-'+row.checkout_key});
      const url=this.trustedURL(session.url,'checkout.stripe.com');this.store.completeCheckout(user,session);return {url};
    } catch(error){this.store.releaseCheckout(user);throw error;}
  }
  async portal(user){this.store.owner(user);this.requireReady();const row=this.store.subscriptionRow(user);if(!row.customer_id)throw new AppError(422,'Choose a subscription plan first.');const session=await this.stripe.billingPortal.sessions.create({customer:row.customer_id,return_url:this.origin+'/app#billing'});return {url:this.trustedURL(session.url,'billing.stripe.com')};}
  async cancelCheckout(user){this.store.owner(user);this.requireReady();const row=this.store.subscriptionRow(user);if(row.checkout_lock_until>Date.now())throw new AppError(409,'Checkout is being prepared. Try again shortly.');if(row.checkout_session_id){const session=await this.stripe.checkout.sessions.retrieve(row.checkout_session_id);if(session.status==='complete')throw new AppError(409,'Checkout completed. Refresh and manage your subscription through the billing portal.');if(session.status==='open')await this.stripe.checkout.sessions.expire(session.id);}this.store.clearCheckout(user);return{ok:true};}
  async webhook(raw,signature){
    this.requireReady();let event;
    try{event=this.stripe.webhooks.constructEvent(raw,signature,this.secret);}catch{throw new AppError(400,'Invalid webhook signature.');}
    if(this.store.db.prepare('SELECT event_id FROM billing_events WHERE event_id=?').get(event.id))return{duplicate:true};
    const object=event.data.object;let id;
    if(event.type.startsWith('customer.subscription.'))id=object.id;
    else if(event.type==='checkout.session.completed'&&object.mode==='subscription')id=object.subscription;
    else if(['invoice.paid','invoice.payment_failed'].includes(event.type))id=object.subscription || object.parent?.subscription_details?.subscription;
    if(typeof id==='object')id=id.id;if(!id)return{ignored:true};
    // Fetch the current provider state so an old delivered event cannot rewind a subscription.
    const subscription=await this.stripe.subscriptions.retrieve(id);
    const items=subscription.items?.data || [], choice=items.length===1&&this.mapping.get(items[0].price.id);
    if(!choice || items[0].quantity!==1)return{ignored:true};
    const customer=typeof subscription.customer==='string'?subscription.customer:subscription.customer?.id;
    const local=this.store.db.prepare('SELECT business_id FROM subscriptions WHERE customer_id=?').get(customer);
    if(!local||subscription.metadata?.businessId!==local.business_id)return{ignored:true};
    return this.store.applyBillingEvent(event,subscription,choice.plan);
  }
}
module.exports={Billing};
