# ProfitPulse SaaS business workspace

A server-backed small-business application connecting **customer → enquiry → quotation → invoice/order → payment → actual profit**. The interface remains plain HTML, CSS and JavaScript. The Node server stores validated records in SQLite; browser storage is used only for recovery of unsaved reply drafts and legacy migration.

## Start

Requires **Node.js 24 or newer** and npm. Dependencies are already installed in this working copy. On another machine:

~~~sh
npm ci
npm start
~~~

Open **http://127.0.0.1:8080** for the public landing page and plan comparison. **Start free trial** opens `/signup`; existing users sign in at `/login`. Every signup creates an independent business workspace with an owner and a 14-day trial. There are no default credentials. Owners add their team from Settings within the plan limits.

The sign-in screen also has a **read-only demo workspace**. Its synthetic data lives in memory and never enters the business database or reports.

For the Node deployment, the application needs **npm start** for authentication, records and PDFs. Cloudflare uses the Worker described below. Uploading only `dist/` does not run the authentication or database APIs. Original source is preserved under review/v1/.

## Cloudflare Workers deployment from GitHub

The repository includes `wrangler.jsonc` and `cloudflare/worker.mjs` for **profitplus.cj5v2tzbtr.workers.dev**. The Worker serves the public landing page at `/`, the signup form at `/signup`, sign-in at `/login`, and the workspace at `/app`. It runs the shared server routes and business rules against persistent, SQLite-backed Durable Object storage. The database binding and initial migration are declared in Wrangler; no D1 database ID or external Node server is required.

In the existing Cloudflare Worker’s **Settings → Builds**, connect this GitHub repository and production branch `main`, use the repository root, set the build command to `npm run build` and the deploy command to `npm run deploy`. Set build variable `NODE_VERSION=24`. The deployment must use the repository’s Wrangler configuration, including its `main`, asset binding, and database migration. A static-only deployment of `dist/` will show the login document at the root and return 404 for `/api/*`.

`PUBLIC_ORIGIN` is set to the existing HTTPS address in `wrangler.jsonc`. Update it if the primary domain changes. Add Stripe keys and price mappings as Cloudflare runtime secrets/variables only when billing is configured; trials and account access work without them. This deployment creates its own persistent database. It does not upload the private local `data/` directory. Existing local workspace records can be migrated using an owner export and restore after creating the corresponding cloud workspace; local account passwords and sessions are not copied.

For local Worker development and verification:

~~~sh
npm ci
npm run dev:cloudflare
npm run check
npm test
npm run test:cloudflare
npm run build
~~~

Open **http://127.0.0.1:8787** for the Worker preview. Cloudflare runtime tests use isolated temporary databases and synthetic accounts; they check routing, signup/login, tenant isolation, staff permissions, CSRF/origin checks, PDF generation, restore safety copies, and persistence across runtime restarts. `npm run build` bundles the Worker without publishing. `npm run deploy` publishes to the authenticated Cloudflare account; GitHub-connected Cloudflare Builds performs that step automatically after a production-branch update.

Cloudflare uses persistent storage and provider-managed database recovery rather than local hourly snapshot files. Owner exports and before-restore safety copies remain available. Portable cloud exports/imports are limited to **8 MB** to fit Worker memory limits; the Node deployment retains its 50 MB limit. Larger workspaces require operator-managed database recovery. Safety copies are stored in chunks to fit SQLite row limits. PDFKit is pinned to the compatible 0.17 series because 0.20’s module initialization assumes a filesystem-backed module URL.

## Implemented functionality

- **SaaS:** public landing page, self-service business signup, isolated workspaces, Starter/Growth/Business plans, 14-day trials, server-enforced entitlements and quotas, Stripe Checkout and billing portal, signature-verified/deduplicated webhooks. Paid pricing stays unavailable until configured.
- **Multi-currency:** configurable default currency, customer currency preferences, currency per enquiry/quote, invoice-currency payments/costs, currency-specific precision, ISO currency labels in PDFs/tables/CSV and currency-separated reports.
- **Reliable records:** server-confirmed writes, SQLite transactions, record versions rejecting stale edits, validation on entry/import, recoverable archives, undo, audit history and safe backup previews.
- **Accounts and access:** salted scrypt passwords, expiring HttpOnly sessions, CSRF/origin checks, login throttling, business-scoped access, owner/staff permissions, account disabling, role changes and password changes revoking existing sessions.
- **Platform administration:** separately authorized administrator, registered-user directory and profiles, active-time estimates, service usage, daily activity and API performance/error analysis with 7/30/90-day filters.

## Platform admin dashboard

Sign in as the configured administrator and choose **Platform admin**, or open `/app#admin`. The production Worker configuration grants this access only to the approved account, identified by its normalized email SHA-256 digest in `PLATFORM_ADMIN_EMAIL_SHA256`. The digest identifies an account; it is not a login credential. Ordinary business owners, staff and demo visitors never receive this navigation item; every `/api/admin/*` request also checks the server-side configuration. Promoting a team member to owner does not grant platform access. The dashboard is read only.

For a separate Node installation, set `PLATFORM_ADMIN_EMAILS` privately to a comma-separated list of administrator addresses, then restart. Alternatively, use `PLATFORM_ADMIN_EMAIL_SHA256` with comma-separated SHA-256 digests of lowercase, trimmed administrator email addresses. Empty settings disable platform administration. Configured addresses are reserved against normal signup and team-account creation. An existing account can sign in immediately; an unregistered address requires the private invitation described below. The email on an existing account cannot be edited by team owners. Never let a browser, signup, workspace backup or team-role field set platform administrator privileges.

An operator can provision an **unregistered** reserved administrator at `/admin/setup` using a single-use, expiring invitation. Generate a cryptographically random 32-byte hex code and configure `PLATFORM_ADMIN_SETUP_TOKEN_SHA256` with its SHA-256 digest, `PLATFORM_ADMIN_SETUP_EMAIL_SHA256` with the approved normalized email digest, and `PLATFORM_ADMIN_SETUP_EXPIRES_AT` with an absolute UTC ISO timestamp. The email must also be in the platform-admin allowlist. Share `/admin/setup#code=RAW_CODE` privately with the intended administrator, who enters their email, name and a new ProfitPlus password. The code fragment is removed from browser history on page load and is sent only in the setup POST body. Never commit the raw code or an account password. The setup endpoint enforces origin checks, limits guesses, rejects wrong-email claims and records consumption in persistent storage. The default `PLATFORM_ADMIN_SETUP_MODE=create` refuses to reset existing accounts. To recover an existing approved administrator, the operator must rotate the invitation to a fresh random code and explicitly set `PLATFORM_ADMIN_SETUP_MODE=recover`. Recovery sets the chosen name and new password, restores sign-in access, revokes all previous sessions for that user, and preserves the user ID, business, role, records, subscription and registration date. Credential changes, session revocation, invitation consumption and the recovery audit are transactional. Request bodies cannot enable recovery, and the invitation remains restricted to its configured email. Concurrent claims cannot create duplicate accounts or reuse a recovery invitation. The resulting session opens the admin dashboard. Google passwords and Google OAuth are not used by this login.

The dashboard includes searchable, paginated user profiles (name, email, workspace, role, enabled state, plan and business contact details), registration/sign-in/activity timestamps where recorded, usage by service, daily active users and new registrations. Service actions count successful record saves, PDF downloads, backups/restores and billing actions recorded by the backend. Reports and other read-only screens contribute module visits and active time.

Active time is an **estimate**: one-second browser samples are batched into heartbeats, counting only visible, focused application time within 60 seconds of interaction. Hidden tabs, idle time and suspended timers are excluded. The server validates samples, associates them with the authenticated user, deduplicates retries and caps time across all tabs/sessions. Browser measurements can be blocked or tampered with and are not suitable for billing or attendance enforcement. Demo and admin-dashboard activity are excluded.

API diagnostics show request count, average/maximum application handling time, slow requests (at least one second), HTTP 5xx error rate and rejected HTTP 4xx requests, with route and daily breakdowns. The dashboard excludes admin queries and heartbeats to avoid measuring its own refresh traffic. It does not measure public-page traffic, network latency, CPU, memory, uptime, or infrastructure failures before the application starts; use [Cloudflare's infrastructure metrics](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/) for those provider-level measurements.

Tracking begins at deployment. Existing accounts have **unknown historical registration dates**, and historical usage is not reconstructed. UTC daily usage and request aggregates are retained for 90 days; profile timestamps persist. These tables contain no passwords, session tokens, IP addresses, raw URLs, or business-record contents, and are excluded from portable workspace exports/restores. Full database recovery retains them. No external analytics service is used. The usage notice is visible in account settings and the public page.
- **Customers:** name, company, phone/WhatsApp, email, address, notes, duplicate-contact detection and linked enquiry/quotation/invoice history.
- **Enquiries:** automatic collection from connected Instagram/Facebook messaging, Twilio business calls and hosted website forms, immutable source/message metadata, customer matching, owner assignment, status, value, scheduled follow-ups, loss reasons and English/Swahili keyword triage. Manual enquiry creation is disabled at the interface and HTTP API. Historical records remain available.
- **Replies:** editable drafts, server saving, per-account local recovery for unsaved text, a composer preserved while filtering, copy and text download. Refresh preserves active editors.
- **Quotations:** multiple line items, fractional quantities, unit costs/prices, labour/transport/overhead, percentage discounts, configured tax, percentage and fixed fees, target margin, sequential numbers, issue/expiry dates, terms/notes, revisions, copying, statuses and downloadable PDFs.
- **Invoice generator:** create invoices directly or convert accepted quotations, with automatic invoice numbers, multiple line items, per-invoice currency, tax, discounts, due dates, payment terms, PDF downloads, and preserved pricing snapshots. Payments, refunds, balances, actual costs, and profit tracking use the same ledger for both invoice types.
- **Reporting:** overdue follow-ups, open enquiries, quote acceptance, invoice sales before tax, payments including tax, unpaid balances, source-channel sales, expected versus actual profit, period/channel filters and CSV export.
- **Daily work:** customer/document/message search, status/date/channel filters, sorting, pagination, responsive navigation, keyboard-accessible backup/restore, archiving and restoration of all record types.

## Everyday workflow

1. Open **Connections** as a business owner and connect your customer channels.
2. Incoming interactions automatically create or match a customer and collect an enquiry. Assign it and set a follow-up date. Customers can also be added separately for direct invoices.
3. Use **Create quote** on the enquiry. Enter items, expected costs, tax and terms.
4. Save as draft/sent, export the PDF and share it through your chosen channel.
5. Mark an accepted quote accepted and use **Create invoice / order**, or open **Invoices & payments → Create invoice** to invoice a customer directly.
6. Record money already received, refunds and actual transaction fees.
7. Record actual fulfilment costs. Complete the order and confirm all costs are recorded.
8. Review balances, follow-ups and estimated versus actual profit in Overview and Reports.

Connected channels collect incoming interactions after provider authorization. Reply copy/download and payment entry do not send messages or transfer money. Push/email notifications and live payment integrations require separate provider configuration. Reminders appear in the open application's overdue list and navigation badge.

## Customer channel connections

Only workspace owners can connect/disconnect channels; platform-admin status is a separate permission used to configure the shared Meta app. Connection management requires an active subscription, except disconnecting remains available after expiry. Staff can view captured enquiries and manage follow-ups. Every connection, pending interaction, profile lookup, customer mapping and record is scoped to its workspace. A connected external account/number/website origin cannot be claimed by a different workspace.

**Website:** open Connections, enter the exact website origin (for example `https://example.com`), and optionally enable anonymous visits. Install the supplied iframe and script on the website contact page, or share the hosted enquiry form. The form collects name, message and email or phone, creating an enquiry with the original platform, contact details, received time and website context. Embedding is restricted to the configured origin. The helper strips query strings from page/referrer URLs and records only the optional `utm_campaign` value. Visit counters are aggregate page loads, not unique visitors; they do not identify visitors or turn browsing into an enquiry. An existing external contact form is not automatically monitored: use the supplied form. Capture uses a signed expiring form nonce, origin checks, a honeypot, request-size and rate limits. Website origins must include the correct `www` subdomain where applicable.

**Twilio:** connect an existing business number with its Account SID, Auth Token and Incoming Phone Number SID. ProfitPlus verifies number ownership through Twilio before configuring the number's call-completion status callback; its voice routing is preserved. Existing status callbacks are replaced, so use a dedicated number or coordinate with existing callback consumers. On disconnect the previous callback URL/method is restored if the current callback still points to ProfitPlus. Inbound calls appear after they end, with the caller number/name when supplied, status, and duration when supplied. A withheld number stays unknown. No recordings or transcripts are collected. All callback fields and the exact public URL are validated with Twilio's SDK before intake. Ordinary mobile calls are outside this integration. See [Twilio incoming number settings](https://www.twilio.com/docs/phone-numbers/api/incomingphonenumber-resource) and [webhook signature validation](https://www.twilio.com/docs/usage/webhooks/webhooks-security).

**Instagram and Facebook:** the platform operator must first configure a Meta developer app. Sign in as the platform admin and open Connections. Until app credentials are configured, a setup guide appears first and **Set up social connections** points to the credential form. Create the platform Meta app under the business’s Facebook account, then save its App ID, App Secret and Graph API version (default `v24.0`). These are Meta developer app credentials, not a Facebook or Google password. The screen supplies the exact OAuth redirect URL, webhook callback and verification token. Configure Facebook Login plus Page/Instagram messaging webhooks, subscribe to `messages` and `messaging_postbacks`, and obtain Meta approval/Advanced Access for the requested permissions before onboarding client accounts outside the app's test roles. Facebook permissions: `pages_show_list`, `pages_read_engagement`, `pages_manage_metadata`, `pages_messaging`. Instagram uses Facebook Login with `pages_show_list`, `pages_read_engagement`, `pages_manage_metadata`, `pages_messaging`, `instagram_basic`, `instagram_manage_messages`; a professional Instagram account linked to a Facebook Page is required. Enable access to messages in the Instagram account settings. Business owners then choose Connect Instagram/Facebook, authorize their managed accounts, and select **Collect enquiries** for an authorized account. Discovery and Page tokens remain on the server. Facebook Login subscriptions attach to the linked Page; disconnecting one channel keeps that Page subscription while its other channel remains connected. OAuth state is expiring, single-use and bound to the signed-in owner/workspace. Meta webhook bodies require `X-Hub-Signature-256`; echoes/outbound messages and unrelated recipients are ignored. Cancelled authorization, expired connection attempts, no shared accounts, subscription restrictions and provider failures display separate guidance; redirect URLs never include OAuth codes, tokens, secrets or raw provider errors. Changing app credentials requires clients to reconnect. Optional server `META_APP_ID`, `META_APP_SECRET`, `META_API_VERSION` variables can supply initial configuration; saved admin configuration takes precedence. See [Meta's official platform examples](https://github.com/fbsamples/messenger-platform-samples) and [Instagram messaging documentation](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/messaging-api/).

Social sender IDs are always retained. Names/Instagram handles are added when the provider permits profile lookup; unavailable profiles show an unknown name and sender ID rather than fabricated details. Social APIs do not automatically supply a sender's private email/phone. Attachment-only messages get a factual placeholder; view attachments in the original inbox. This release collects new messaging notifications, not historic inbox backfill, comments, advertising lead forms, SMS or replies sent from ProfitPlus. Provider credentials, account permissions and successful real-account smoke tests are required before claiming a channel is live.

Incoming notifications are deduplicated by connection and provider event ID (Twilio Call SID, Meta message ID, or website submission ID). Progressive call callbacks update the same enquiry without resetting follow-up status/notes. Matching uses a saved platform sender mapping, exact email, or normalized phone. Contradictory matches wait for an owner to select a customer in Connections. Subscription/quota/storage problems keep the original interaction in a persistent pending queue; processing customer + enquiry + mapping is transactional. Opening the app/Connections processes up to 10 pending interactions per request; owners can retry individually. Queue limits: 1,000 pending interactions per workspace, 10,000 new events/day/workspace; full queues return a retryable error instead of acknowledging data loss. Provider retries are still subject to provider retention policies.

Provider credentials are encrypted with AES-256-GCM using a server-generated key persisted in the private database. APIs and portable workspace exports omit credentials, OAuth tokens, connection configuration and verification secrets. The full private database contains the encryption key and must be protected as a credential-bearing backup. Full database recovery preserves connections; portable workspace restores preserve enquiry provenance but require reconnecting channels on another deployment. Processed event payload copies are cleared after 30 days while deduplication IDs and saved enquiries remain; pending payloads remain until processed. Anonymous website visit aggregates retain 90 days and display the last 30 UTC days. Rate-limit keys hash IP addresses and expire; no browser tracking cookies or persistent visitor IDs are used. Existing records without provenance are labelled historical.

## Invoice generator

Sign in and open **Invoices & payments**. Add a customer first if your workspace is empty. Business contact details and default payment terms are configured in **Settings & backups** and appear on generated PDFs.

1. Choose **Create invoice** to select a customer and currency, enter line items, issue/due dates, tax, discounts, notes, and payment terms. The editor shows the total and estimated margin before saving. Internal unit costs and margin calculations are excluded from the customer PDF.
2. Choose **From quotation** to select an accepted quotation that has not already been invoiced. Review its customer, currency, items, and total, then set the invoice dates, notes, and terms. Quotation details also retain their **Create invoice / order** shortcut.
3. Save the invoice to receive a server-generated `INV-` number, then choose **Download invoice PDF**. Record receipts, refunds, and actual fulfilment costs from the invoice detail panel. Payment entries record money already received; they do not transfer funds.

Saved invoice amounts, currency, customer, and quotation link are fixed. Dates, notes, payment terms, and order status remain editable, with an audit history and stale-edit checks. To replace incorrect amounts, cancel an unpaid invoice and create a corrected one; received payments must be refunded before cancellation. Standalone invoices appear as **Direct invoice** and use **Unattributed** for source-channel reporting.

Both paths use the existing authenticated record API, plan document quotas, currency calculations, PDF renderer, and persistent database. A direct invoice has a null `quoteId` and its own validated pricing snapshot; quotation-based invoices copy trusted pricing from the stored accepted quote. Backup restore supports multiple direct invoices while still rejecting duplicate active invoices for one quotation. Existing records require no schema migration.

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
