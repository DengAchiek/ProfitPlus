(function (root) {
  'use strict';
  const kinds = ['customers', 'leads', 'quotes', 'invoices', 'payments', 'expenses'];
  const leadStatuses = ['new', 'contacted', 'quoted', 'won', 'lost'];
  const quoteStatuses = ['draft', 'sent', 'accepted', 'declined', 'expired'];
  const channels = ['WhatsApp', 'Email', 'Instagram', 'Phone', 'Website', 'Other'];
  const currencies = [...Intl.supportedValuesOf('currency'),'CLF'].sort().filter(code => !['XXX','XTS','XAU','XAG','XPD','XPT'].includes(code));
  const currencySet = new Set(currencies), precisionCache = new Map();
  function currency(code = 'KES') {
    if (typeof code !== 'string' || !currencySet.has(code)) throw Error('Choose a supported ISO currency.');
    return code;
  }
  function digits(code = 'KES') {
    currency(code);
    if (!precisionCache.has(code)) precisionCache.set(code, new Intl.NumberFormat('en', {style:'currency', currency:code}).resolvedOptions().maximumFractionDigits);
    return precisionCache.get(code);
  }
  const factor = code => 10 ** digits(code);
  const cents = (n, code = 'KES') => Math.round((n + Number.EPSILON) * factor(code));
  const round = (n, code = 'KES') => cents(n, code) / factor(code);
  const moneyStep = code => 1 / factor(code);
  function formatMoney(value, code = 'USD', locale = 'en-US') {
    return new Intl.NumberFormat(locale, {style:'currency',currency:currency(code),currencyDisplay:'code'}).format(value===0?0:value);
  }
  function cash(value, name, code, min = 0, max = 1e9) {
    number(value, name, min, max);
    const rounded = round(value, code);
    if (Math.abs(value - rounded) > 1e-8) throw Error(name + ' must use ' + digits(code) + ' decimal places for ' + code + '.');
    return rounded;
  }
  function text(value, name, max = 5000, required = false) {
    if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim())) throw Error(name + ' is required and must be at most ' + max + ' characters.');
    return value.trim();
  }
  function number(value, name, min = 0, max = 1e9) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw Error(name + ' must be between ' + min + ' and ' + max + '.');
    return value;
  }
  function choice(value, options, name) {
    if (!options.includes(value)) throw Error('Choose a valid ' + name + '.');
    return value;
  }
  function date(value, name, optional = false) {
    if (optional && (value === null || value === '' || value === undefined)) return null;
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw Error(name + ' must be a valid date.');
    return new Date(value).toISOString();
  }
  function day(value, name) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value + 'T00:00:00Z')) || new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value) throw Error(name + ' must be a valid date.');
    return value;
  }
  function ref(value, name, optional = false) { return optional && !value ? null : text(value, name, 100, true); }
  function pricing(input) {
    if (!input || !Array.isArray(input.items) || !input.items.length || input.items.length > 100) throw Error('Add between 1 and 100 line items.');
    const code = currency(input.currency || 'KES');
    const items = input.items.map(item => ({
      description: text(item?.description, 'Item description', 300, true),
      quantity: number(item.quantity, 'Quantity', 0.001, 1e6),
      unitPrice: cash(item.unitPrice, 'Unit price', code, 0, 1e7),
      unitCost: cash(item.unitCost, 'Unit cost', code, 0, 1e7),
    }));
    const out = { items, currency: code };
    for (const key of ['labour', 'transport', 'overhead', 'fixedFee']) out[key] = cash(input[key] ?? 0, key, code);
    for (const key of ['discountPercent', 'taxPercent', 'feePercent', 'targetMargin']) out[key] = number(input[key] ?? 0, key, 0, key === 'discountPercent' ? 99.9 : 99);
    if (items.reduce((s, item) => s + item.quantity * Math.max(item.unitPrice, item.unitCost), 0) > 1e9) throw Error('Quote exceeds the supported amount of 1 billion currency units.');
    return out;
  }
  function calculateQuote(input) {
    const q = pricing(input), scale = factor(q.currency), minor = n => cents(n, q.currency);
    const raw = q.items.reduce((s, item) => s + minor(item.quantity * item.unitPrice), 0);
    const discount = Math.round(raw * q.discountPercent / 100), revenue = raw - discount;
    const tax = Math.round(revenue * q.taxPercent / 100), total = revenue + tax;
    const base = q.items.reduce((s, item) => s + minor(item.quantity * item.unitCost), 0) + minor(q.labour) + minor(q.transport) + minor(q.overhead);
    const fees = Math.round(total * q.feePercent / 100) + minor(q.fixedFee), profit = revenue - base - fees;
    const denominator = 1 - q.targetMargin / 100 - q.feePercent / 100 * (1 + q.taxPercent / 100);
    let recommended = denominator > 0 ? Math.ceil((base + minor(q.fixedFee)) / denominator) : null;
    if (recommended !== null && (!Number.isSafeInteger(recommended) || recommended > 1e9 * scale)) recommended = null;
    if (recommended !== null) {
      while (recommended - base - Math.round((recommended + Math.round(recommended * q.taxPercent / 100)) * q.feePercent / 100) - minor(q.fixedFee) + 1e-7 < recommended * q.targetMargin / 100) recommended++;
    }
    return { currency:q.currency, subtotal:raw/scale, discount:discount/scale, revenue:revenue/scale, tax:tax/scale, total:total/scale,
      baseCost:base/scale, fees:fees/scale, cost:(base+fees)/scale, profit:profit/scale, margin:revenue?profit/revenue*100:null,
      recommendedRevenue:recommended===null?null:recommended/scale };
  }
  function validateRecord(kind, input, now = Date.now()) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('A record must be an object.');
    const s = (key, max = 5000, required = false) => text(input[key] ?? '', key, max, required);
    let out;
    if (kind === 'customers') {
      out = { name: s('name', 100, true), company: s('company', 150), email: s('email', 254).toLowerCase(), phone: s('phone', 50), address: s('address', 500), notes: s('notes'), preferredCurrency: currency(input.preferredCurrency || 'KES') };
      if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) throw Error('Enter a valid customer email.');
    } else if (kind === 'leads') {
      const code = currency(input.currency || 'KES');
      const receivedAt = date(input.receivedAt, 'Received time');
      if (Date.parse(receivedAt) > now + 60000) throw Error('Received time cannot be in the future.');
      out = { currency:code, customerId: ref(input.customerId, 'Customer'), channel: choice(input.channel, channels, 'channel'), message: s('message', 5000, true),
        receivedAt, value: input.value === null || input.value === '' ? null : cash(input.value, 'Potential value', code),
        status: choice(input.status, leadStatuses, 'enquiry status'), assignedTo: ref(input.assignedTo, 'Assigned user', true),
        nextActionAt: date(input.nextActionAt, 'Next action', true), priority: choice(input.priority ?? 'auto', ['auto', 'high', 'normal', 'low'], 'priority'),
        notes: s('notes'), lostReason: s('lostReason', 500), draft: s('draft', 10000) };
      out.firstContactedAt = date(input.firstContactedAt, 'First response', true);
      if (out.firstContactedAt && (Date.parse(out.firstContactedAt) > now + 60000 || Date.parse(out.firstContactedAt) < Date.parse(receivedAt))) throw Error('First response must be after receipt and cannot be in the future.');
      if (out.status === 'lost' && !out.lostReason) throw Error('Add a reason for the lost enquiry.');
    } else if (kind === 'quotes') {
      out = { ...pricing(input), customerId: ref(input.customerId, 'Customer'), leadId: ref(input.leadId, 'Enquiry', true),
        issuedOn: day(input.issuedOn, 'Issue date'), expiresOn: day(input.expiresOn, 'Expiry date'),
        status: choice(input.status, quoteStatuses, 'quote status'), notes: s('notes'), terms: s('terms', 3000) };
      if (out.expiresOn < out.issuedOn) throw Error('Expiry must be on or after the issue date.');
    } else if (kind === 'invoices') {
      if(input.currency && input.quote?.currency && input.currency!==input.quote.currency)throw Error('Invoice and pricing snapshot currencies must match.');
      out = { currency:currency(input.currency || input.quote?.currency || 'KES'), quoteId: ref(input.quoteId, 'Quote', true), customerId: ref(input.customerId, 'Customer'), quote: pricing({...input.quote, currency:input.currency || input.quote?.currency || 'KES'}),
        issuedOn: day(input.issuedOn, 'Issue date'), dueOn: day(input.dueOn, 'Due date'),
        status: choice(input.status, ['open', 'completed', 'cancelled'], 'order status'), costsFinalized: input.costsFinalized === true,
        notes: s('notes'), terms: s('terms', 3000) };
      if (out.dueOn < out.issuedOn) throw Error('Due date must be on or after the issue date.');
    } else if (kind === 'payments') {
      const code = currency(input.currency || 'KES');
      out = { currency:code, invoiceId: ref(input.invoiceId, 'Invoice'), amount: cash(input.amount, 'Payment amount', code, moneyStep(code)),
        fee: cash(input.fee ?? 0, 'Payment fee', code), direction: choice(input.direction, ['receipt', 'refund'], 'payment direction'),
        method: choice(input.method, ['Cash', 'M-Pesa', 'Bank', 'Card', 'Other'], 'payment method'),
        paidOn: day(input.paidOn, 'Payment date'), reference: s('reference', 150), notes: s('notes', 1000) };
    } else if (kind === 'expenses') {
      const code = currency(input.currency || 'KES');
      out = { currency:code, invoiceId: ref(input.invoiceId, 'Invoice'), description: s('description', 300, true), amount: cash(input.amount, 'Actual cost', code, moneyStep(code)),
        category: choice(input.category, ['Materials', 'Labour', 'Transport', 'Overhead', 'Other'], 'cost category'), incurredOn: day(input.incurredOn, 'Cost date') };
    } else throw Error('Unknown record type.');
    out.archived = input.archived === true;
    return out;
  }
  function priority(lead, now = Date.now(), responseHours = 24) {
    const hours = Math.max(0, (now - Date.parse(lead.receivedAt || lead.received)) / 3600000);
    const message = (lead.message || '').toLowerCase();
    const negated = /\b(not interested|do not want|don't want|sitaki|sihitaji)\b/.test(message);
    const intent = !negated && /\b(price|quote|quotation|cost|buy|order|book|available|availability|purchase|bei|nunua|agiza|naomba|gharama)\b/.test(message);
    const urgent = !negated && /\b(today|urgent|asap|tomorrow|leo|kesho|haraka)\b/.test(message);
    const active = !lead.archived && !['won', 'lost'].includes(lead.status);
    const overdue = active && ((lead.status === 'new' && hours >= responseHours) || (lead.nextActionAt && Date.parse(lead.nextActionAt) <= now));
    const automatic = overdue ? 3 : urgent ? 2 : intent ? 1 : 0;
    const score = active ? ({ high: 3, normal: 1, low: 0 }[lead.priority] ?? automatic) : -1;
    return { hours, intent, urgent, overdue: !!overdue, high: score >= 2, score,
      reasons: [overdue && 'Follow-up overdue', urgent && 'Urgency detected', intent && 'Buying intent detected', lead.priority && lead.priority !== 'auto' && 'Manual priority'].filter(Boolean) };
  }
  function invoiceSummary(invoice, payments = [], expenses = []) {
    const code = currency(invoice.currency || invoice.quote?.currency || 'KES'), scale = factor(code), minor = n => cents(n, code);
    if (invoice.quote?.currency && invoice.quote.currency !== code) throw Error('Invoice and quote currencies must match.');
    const q = calculateQuote({...invoice.quote,currency:code});
    const ps = payments.filter(p => p.invoiceId === invoice.id && !p.archived);
    const es = expenses.filter(e => e.invoiceId === invoice.id && !e.archived);
    if ([...ps,...es].some(r => r.currency && r.currency !== code)) throw Error('Payments and costs must use the invoice currency.');
    const received = ps.reduce((s,p)=>s+(p.direction==='refund'?-minor(p.amount):minor(p.amount)),0)/scale;
    const paymentFees = ps.reduce((s,p)=>s+minor(p.fee),0)/scale;
    const actualCost = es.reduce((s,e)=>s+minor(e.amount),0)/scale;
    return {...q,received,balance:round(q.total-received,code),actualCost,paymentFees,
      actualProfit:invoice.status==='completed'&&invoice.costsFinalized?round(q.revenue-actualCost-paymentFees,code):null,
      paymentStatus:invoice.status==='cancelled'?'cancelled':received>=q.total?'paid':received>0?'partial':'unpaid'};
  }
  function quote(v) {
    const r = calculateQuote({ items: [{ description: 'Item', quantity: v.qty, unitPrice: v.price, unitCost: v.materials }],
      labour: v.labour, transport: v.transport, overhead: v.other, feePercent: v.fee, targetMargin: v.target });
    return { ...r, recommended: r.recommendedRevenue === null ? null : Math.ceil(r.recommendedRevenue / v.qty * factor(r.currency)) / factor(r.currency) };
  }
  const api = { currencies, currency, digits, factor, moneyStep, formatMoney, cash, kinds, leadStatuses, quoteStatuses, channels, round, cents, pricing, calculateQuote, validateRecord, priority, invoiceSummary, quote };
  root.Pulse = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
