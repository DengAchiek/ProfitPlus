'use strict';
// Limits are enforced by the server. Prices are read from configured Stripe Prices.
const PLANS = Object.freeze({
  starter: { id:'starter', name:'Starter', tagline:'A clear start for a small business.', seats:2, customers:1000, documents:500, features:['2 team members','1,000 active customers','500 active quotes & invoices','All supported business currencies','PDFs, follow-ups, backups & reports'] },
  growth: { id:'growth', name:'Growth', tagline:'Room for a growing team.', seats:5, customers:10000, documents:10000, features:['5 team members','10,000 active customers','10,000 active quotes & invoices','All supported business currencies','Everything in Starter'] },
  business: { id:'business', name:'Business', tagline:'Keep more of your business connected.', seats:20, customers:50000, documents:50000, features:['20 team members','50,000 active customers','50,000 active quotes & invoices','All supported business currencies','Everything in Growth'] },
});
const TRIAL_DAYS = 14;
module.exports = { PLANS, TRIAL_DAYS };
