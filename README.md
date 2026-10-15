# ProfitPulse — SaaS business workspace

A server-backed small-business application connecting **customer → enquiry → quotation → invoice/order → payment → actual profit**. The interface remains plain HTML, CSS and JavaScript. The Node server stores validated records in SQLite; browser storage is used only for recovery of unsaved reply drafts and legacy migration.

## Start

Requires **Node.js 24 or newer** and npm. Dependencies are already installed in this working copy. On another machine:

~~~sh
npm ci
npm start
~~~

Open **http://127.0.0.1:8080** for the public landing page and plan comparison. **Start free trial** opens `/signup`; existing users sign in at `/login`. Every signup creates an independent business workspace with an owner and a 14-day trial. There are no default credentials. Owners add their team from Settings within the plan limits.

The sign-in screen also has a **read-only demo workspace**. Its synthetic data lives in memory and never enters the business database or reports.

The application now needs **npm start** for authentication, records and PDFs. The old static-server instructions no longer apply. Original source is preserved under review/v1/.

## Implemented functionality

- **SaaS:** public landing page, self-service business signup, isolated workspaces, Starter/Growth/Business plans, 14-day trials, server-enforced entitlements and quotas, Stripe Checkout and billing portal, signature-verified/deduplicated webhooks. Paid pricing stays unavailable until configured.
- **Multi-currency:** configurable default currency, customer currency preferences, currency per enquiry/quote, invoice-currency payments/costs, currency-specific precision, ISO currency labels in PDFs/tables/CSV and currency-separated reports.
- **Reliable records:** server-confirmed writes, SQLite transactions, record versions rejecting stale edits, validation on entry/import, recoverable archives, undo, audit history and safe backup previews.
- **Accounts and access:** salted scrypt passwords, expiring HttpOnly sessions, CSRF/origin checks, login throttling, business-scoped access, owner/staff permissions, account disabling, role changes and password changes revoking existing sessions.
- **Customers:** name, company, phone/WhatsApp, email, address, notes, duplicate-contact detection and linked enquiry/quotation/invoice history.
- **Enquiries:** editable messages, channel, owner assignment, status, value, next action, scheduled follow-ups, loss reasons, configurable response target and English/Swahili keyword triage with manual priority.
- **Replies:** editable drafts, server saving, per-account local recovery for unsaved text, a composer preserved while filtering, copy and text download. Refresh preserves active editors.
- **Quotations:** multiple line items, fractional quantities, unit costs/prices, labour/transport/overhead, percentage discounts, configured tax, percentage and fixed fees, target margin, sequential numbers, issue/expiry dates, terms/notes, revisions, copying, statuses and downloadable PDFs.
- **Sales:** invoices/orders created from accepted quotes, preserved pricing snapshots, due dates, deposits/final payments/refunds, actual payment fees, balances, categorized actual costs, cost finalization and completion/cancellation.
- **Reporting:** overdue follow-ups, open enquiries, quote acceptance, invoice sales before tax, payments including tax, unpaid balances, source-channel sales, expected versus actual profit, period/channel filters and CSV export.
- **Daily work:** customer/document/message search, status/date/channel filters, sorting, pagination, responsive navigation, keyboard-accessible backup/restore, archiving and restoration of all record types.

## Everyday workflow

1. Add a customer with usable contact details.
2. Add their enquiry, assign it and set a follow-up date.
3. Use **Create quote** on the enquiry. Enter items, expected costs, tax and terms.
4. Save as draft/sent, export the PDF and share it through your chosen channel.
5. Mark an accepted quote accepted and use **Create invoice / order**.
6. Record money already received, refunds and actual transaction fees.
7. Record actual fulfilment costs. Complete the order and confirm all costs are recorded.
8. Review balances, follow-ups and estimated versus actual profit in Overview and Reports.

Channels are manual categories. Reply copy/download and payment entry do not send messages or transfer money. External inbox connections, push/email notifications and live payment integrations require separate provider configuration. Reminders appear in the open application's overdue list and navigation badge.

## Financial definitions

- Line totals use the currency’s minor-unit precision (for example JPY 0, USD/KES 2, KWD 3, CLF 4 decimals). Discounts reduce sales before tax.
- Tax applies to discounted net sales. Businesses configure their own rates; live records assume no tax rate.
- Expected percentage transaction fees apply to the payable amount **including tax**, plus any fixed fee.
- Estimated profit = discounted sales **excluding tax** − entered costs − expected fees.
- The recommendation is minimum **net sales before tax**, rounded upward and checked against rounded tax/fee amounts. Margin is profit divided by sales, rather than markup.
- Payments less refunds determine the balance. Overpayments, excess refunds and duplicate references on one invoice are rejected.
- A refund reopens the receivable balance. Refund receipts before cancelling a paid invoice.
- Actual profit is an **order margin**: invoice net sales excluding tax − actual costs − actual payment fees. It appears only for completed orders with finalized costs and remains separate from cash collected.
- Financial reports retain archived quotes and invoices, and exclude cancelled invoices. Archived payment and cost entries are excluded from calculations. Payment reporting uses payment dates; sales/balances use invoice issue dates. Metric definitions appear in the interface.

Currency is stored on every financial record. The default for new workspaces is USD; owners choose another during signup or in Settings. Customer preferences apply to new enquiries and quotes. Changing a default or selecting another currency never converts or relabels existing amounts. Payments and costs must match their invoice currency. Overview and Reports select one currency at a time; there is no assumed FX conversion or combined multi-currency total. PDFs embed an open-source Latin font suitable for English and Swahili. Configure PDF_FONT_REGULAR and PDF_FONT_BOLD with broader-coverage fonts for other writing systems.

## Backup, migration and recovery

The default **data/** directory, ignored by Git, contains SQLite and private backups. Use persistent storage.

- Automatic backups run on startup and hourly, pass SQLite integrity checks and atomically replace that day's snapshot. The last **14 daily snapshots** are retained.
- Owners export portable version 3 JSON on desktop or mobile. Exports include settings and all business records including archives; accounts, password hashes, sessions, billing customer/subscription identifiers, entitlements and revision/audit logs are excluded. Full database snapshots retain the complete server history.
- Restore validates schema, dates, unique identifiers/numbers, financial ledgers and links; previews counts; asks for confirmation; and rejects stale previews.
- A downloadable pre-restore safety copy is saved first. Accounts and subscriptions remain intact; importing JSON cannot grant a paid plan. Restores must fit the current plan’s limits.
- Version 2 databases automatically migrate to version 3 after a verified `pre-saas-v2-*.sqlite` snapshot. Existing Kenyan records explicitly retain KES, including invoice pricing snapshots. Portable version 2 exports are also accepted.
- Portable import is limited to **50 MB and 50,000 records**. Oversized exports are refused with guidance to use the server snapshot, rather than producing an unrestorable file.
- Version 1 imports append legacy records, omit synthetic examples and preserve original browser data. Owners see an import banner when original browser data is available.
- Snapshots are on the same server. Copy the backup directory to separate storage through your hosting operations.

Recover a SQLite snapshot into a **new directory**, preserving existing data:

~~~sh
node scripts/recover.cjs /absolute/path/to/daily-backup.sqlite /absolute/path/to/recovered-data
~~~

The command verifies the source, refuses an existing destination database and invalidates restored login sessions. Stop the application, set DATA_DIR to the recovered directory, restart and sign in.

## Configuration and shared deployment

See .env.example. Supply variables through a process manager or Node's env-file option:

~~~sh
node --env-file=.env server.js
~~~

| Variable | Default / purpose |
| --- | --- |
| PORT | 8080 |
| BIND_HOST | 127.0.0.1; configure an appropriate address behind your reverse proxy |
| DATA_DIR | ./data; use persistent storage |
| NODE_ENV | production enables secure cookies and HSTS |
| PUBLIC_ORIGIN | Required in production: exact HTTPS origin, without a trailing slash |
| PDF_FONT_REGULAR / PDF_FONT_BOLD | Optional absolute paths to TTF/OTF fonts |

For other devices, run one shared service behind HTTPS. Users sign into their own client workspace; a business owner adds team accounts to that workspace. Production startup requires an HTTPS PUBLIC_ORIGIN. Preserve the request host at the reverse proxy and forward to the private Node port.

The implementation uses one SQLite service with business-scoped data and independent subscriptions. Functional workflows, recovery, conflicts and permissions are tested. Public hosting, offsite backup operations and production load testing remain deployment work.

## Configure Stripe before launch

Prices are intentionally unset. Trials work without Stripe keys. When the trial or subscription expires, business writes return HTTP 402; records, PDF downloads, account security, and owner exports remain available. Staff cannot manage billing.

1. In your Stripe account, create **Starter**, **Growth**, and **Business** products with fixed recurring monthly and/or annual prices. Choose your actual amounts and supported billing currencies. Each configured price ID belongs to exactly one plan/currency/interval. Plan limits are defined in `lib/plans.js`.
2. Copy `.env.example` to a private `.env` and set `STRIPE_SECRET_KEY`, `PUBLIC_ORIGIN` and `STRIPE_PRICES_JSON`. The nested format is `plan → ISO currency → month/year → Stripe price ID`. Configure only active fixed recurring prices. Amounts displayed in the landing page and billing screen come from Stripe; no amounts are trusted from the browser.
3. Add the HTTPS webhook endpoint **`/api/billing/webhook`** in Stripe and store its signing secret as `STRIPE_WEBHOOK_SECRET`. Subscribe to `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, and `invoice.payment_failed`. Use the API version associated with your installed Stripe SDK (23.x) and test event payloads before switching to live mode.
4. Configure the Stripe customer portal for payment method updates, invoice history, cancellation and plan changes. Allow only your configured products/prices and require immediate payment for upgrades; avoid unpaid upgrades granting higher limits. Plan reductions keep existing records; additional creation/reactivation must fit the reduced limits.
5. Restart using `node --env-file=.env server.js`. Test Checkout, remaining trial, subscription changes, failed renewal, cancellation and portal return using Stripe test mode. For local webhooks, use the official Stripe CLI to forward to `http://127.0.0.1:8080/api/billing/webhook` and use its test signing secret. Production requires HTTPS and live-mode keys/prices/webhook secret.

The application creates a persistent Stripe customer per business, uses an idempotent checkout attempt and reuses an open checkout on retries. Owners can cancel an unfinished checkout before changing plan. Existing subscriptions are managed through the portal. Checkout carries only the **remaining** local trial when more than 48 hours remain; after that, Checkout requires payment and the remaining local trial still expires on its original date. A hosted checkout never restarts the 14-day trial.

Only a signed webhook with a recognized price and matching customer/workspace metadata updates entitlements. The handler retrieves current subscription state to tolerate out-of-order deliveries and stores processed event IDs. Browser success URLs cannot grant access. `past_due`, `unpaid`, canceled and expired subscriptions become read only. Billing currency is independent from business record currencies; Stripe’s special ISK/UGX API amount units are handled when displaying prices.

Configuration guidance: [Stripe Checkout subscriptions](https://docs.stripe.com/billing/subscriptions/build-subscriptions), [webhook endpoints](https://docs.stripe.com/webhooks), [customer portal](https://docs.stripe.com/customer-management/integrate-customer-portal), [currency units](https://docs.stripe.com/currencies). Live merchant configuration and a real Stripe test-mode smoke test require your account credentials; the automated suite uses synthetic SDK responses and real webhook signature verification without making charges.

## Verify

~~~sh
npm run check
npm test
~~~

Tests cover calculations, currency boundaries, English/Swahili triage, the sales workflow, stale writes, permissions, record isolation, sessions, validation, payments/refunds, archive/recovery, backups, legacy migration, HTTP failures, CSRF/origin checks and single/multiple-page PDFs.

HTTP tests start an ephemeral localhost server and need local port-binding permission in restricted environments. All test accounts and records use isolated temporary databases.

## Source map

- server.js: HTTP routes, authentication enforcement, security headers and local server.
- lib/store.js: SQLite schema, transactions, permissions, audit, import, backups and ledger constraints.
- lib/plans.js, lib/billing.js: plan quotas, configured Stripe pricing, Checkout/portal and webhook synchronization.
- dist/landing.html, dist/landing.css, dist/landing.js: public landing and pricing page.
- lib/pdf.js: branded quotation and invoice PDFs.
- dist/logic.js: shared validation, pricing, priority and invoice calculations.
- dist/app.js, dist/index.html, dist/style.css: interface and interactions.
- scripts/recover.cjs: verified recovery into a fresh data directory.
- test/: calculation, persistence, HTTP/security, workflow and PDF tests.
- review/: original audit, preserved version 1 source and implementation evidence.

PDF rendering uses [PDFKit](https://pdfkit.org/docs/text.html) and the OFL-licensed [Noto Sans font package](https://www.npmjs.com/package/@fontsource/noto-sans). SQLite uses the [Node.js SQLite module](https://nodejs.org/api/sqlite.html).
