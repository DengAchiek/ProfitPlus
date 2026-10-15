# ProfitPulse: real-world functionality review

Historical review of the original application. The reviewed source is preserved in `review/v1/`; the current version implements the improvements described in [implementation notes](implementation-notes.md). The original reproduction script now runs against that preserved source.

Reviewed on 14 October 2026.

**Assessment: useful for demonstrating quote estimates and manual lead triage; not ready to be the sole system of record for a business.** The main blockers are data reliability, unfinished customer-to-sale workflows, and missing controls for shared use. The current README accurately describes most of the architectural limitations.

This review treats ProfitPulse as a small-business quoting and enquiry tool. Requirements for teams are distinguished from requirements for a single-person local pilot. Payments, inventory, and live inbox integrations should follow the business's actual needs rather than all becoming launch requirements.

## Scope and evidence

- Read every supplied application file: `dist/index.html`, `dist/style.css`, `dist/logic.js`, `dist/app.js`, and `README.md`. The application consists of four static files; no backend, package manifest, or existing automated tests were supplied.
- Opened the local preview in a browser. Verified quote output, normal save/reload persistence, example lead metrics, reply loss after filtering, invalid quantity output, and backup visibility at a 390 × 844 viewport.
- Ran 14 focused JavaScript observations against the actual application logic using an isolated VM and a minimal document/storage stub. These exercise storage failures, stale concurrent state, initialization, backup validation, numerical boundaries, and prioritization. They are not full browser tests and do not emulate browser-native form validation.
- Both JavaScript files passed `node --check`.
- No production deployment, external messaging account, real customer dataset, or payment provider was supplied or assessed. Hosting-level security, production capacity, and legal compliance are outside the verified findings.
- Application files were not changed. Only review artifacts and synthetic records in the local preview were created.

Source files are each stored on one line. References below therefore name the function or selector to locate the relevant behavior.

## What already works

The supplied default quote produces KSh 15,000 revenue, KSh 9,450 entered costs including fees, KSh 5,550 estimated profit, and a 37% margin. The target price formula correctly includes the percentage fee under its stated assumptions. A target plus fee of 100% is reported as unachievable.

Normal quote saving survives a reload in the tested browser. The application supports loading a quote as a copy, manual lead statuses, status filtering, editable reply templates, JSON export, and a confirmation before destructive restore. User-provided text is escaped when inserted into rendered HTML. The interface explicitly says that enquiry entry is manual, prioritization uses rules, and replies are copied by the operator.

These are useful foundations. None of them establishes reliable shared storage, delivery of messages, or realized sales/profit.

## Defects to fix before relying on business records

| Priority | Finding and reproduction | Practical impact | Required correction |
| --- | --- | --- | --- |
| P1 | **Failed writes still report success.** Make `localStorage.setItem` throw, then submit a quote: the final toast is `Quote saved`, while persistent storage has no record. `save()` catches the failure, but its caller immediately shows success. The same pattern affects enquiry entry and restore. | An operator can believe a record is safe and lose it on reload. | Make persistence return a result or reject. Show success only after a confirmed write; keep a durable, visible unsaved-data warning and export option. |
| P1 | **Open tabs overwrite each other's changes.** Boot two instances from the same storage, save quote A in the first, then quote B in the second. Only B remains in storage. Each tab retains a stale `state` and writes the complete snapshot. | Ordinary multitasking can silently erase records. | For a local pilot, detect storage revisions and resolve stale writes. For shared use, use transactional server writes and record versions. A storage-event listener alone does not eliminate write races. |
| P1 | **Reply drafts disappear.** Prepare a reply, edit it, then change the enquiry filter: the textarea is removed. `setInterval(renderLeads,60000)` performs the same full inbox replacement every minute. Status changes and other rerenders also trigger it. | A reply can vanish while the operator is writing it. | Store drafts by enquiry ID, preserve focus/edit state, and update priority indicators without replacing active editors. |
| P1 | **Mobile users lose backup and restore access.** At widths up to 650px, `aside p,.foot{display:none}` hides the entire footer containing both controls. Browser testing confirmed both controls are invisible at 390px. | The application's only backup/recovery mechanism is unavailable through the mobile UI. | Keep an accessible backup/settings entry in the mobile navigation. |
| P1 | **Malformed stored data can break startup.** Stored JSON shaped as `{quotes:[null],leads:[]}` passes the initial array-only check, then `renderQuotes()` throws while reading `qty`. | The app can become unusable without manually editing browser storage. | Validate and migrate storage before rendering. Quarantine invalid records and offer recovery/export rather than crashing. |
| P2 | **Examples contaminate business metrics.** Loading the three examples adds three unanswered leads, one overdue lead, and KSh 14,500 potential sales. Although records contain `demo:true`, neither the list nor metrics distinguish them. | Synthetic data looks like business activity and inflates the user's totals. | Use a separate demo workspace or exclude clearly labelled examples from operational metrics and exports intended as business records. |
| P2 | **Backup validation is incomplete.** `valid()` accepts duplicate IDs, an unknown `version:999`, and future enquiry timestamps. It does not enforce the UI's text limits or nonempty trimmed values. | Duplicate IDs can make record actions ambiguous; incompatible backups can be silently accepted. Future timestamps bypass the entry form's rule. | Validate a versioned schema, unique IDs, dates, bounded text/numbers, and required content. Preview imports, support migrations, and protect the pre-restore snapshot. |
| P2 | **A suggested price can miss the target after rounding.** With quantity 1, materials 1, other costs and fees 0, and target 25%, the exact suggestion is 1.333333…; displayed price 1.33 produces a 24.812% margin. | Following the displayed minimum price can undershoot the promised margin. | Define money precision explicitly and round a minimum target price upward to the permitted monetary increment. Recheck the resulting margin. |
| P2 | **Invalid live inputs produce financial-looking output.** Enter quantity 0: the browser shows `KSh ∞` for the suggested price. Native form constraints prevent a normal invalid save, but `calc()` still renders invalid intermediate values. | The calculation panel becomes misleading during editing. | Validate finite values and domain limits before calculating; show field errors and withhold estimates until inputs are valid. |
| P2 | **Whitespace-only required text becomes empty.** Submit spaces for a job, customer, or message. HTML `required` accepts the spaces; handlers trim them to empty strings and save them. | Blank records are difficult to identify and contact. | Validate trimmed values before mutating state, with specific inline errors. Apply the same schema at import and storage boundaries. |
| P2 | **The received-time default becomes stale.** It is initialized once at page load and is not refreshed after adding an enquiry. | A user leaving the page open can record a new enquiry with an earlier time, skewing response-age flags. | Distinguish “received now” from historical entry; refresh the default unless the operator deliberately selected a timestamp. |

P1 means fix before trusting important business data. P2 means fix before routine daily use; exact ordering depends on the pilot's workflows.

## Missing functionality for everyday use

| Area | Present implementation | Gap and minimum useful behavior |
| --- | --- | --- |
| Durable records | One `localStorage` key and manual JSON backups | Authenticated persistent storage, automated backups, tested recovery, record migrations, and synchronization if users need multiple devices. A local-only pilot still needs honest save status and a reliable recovery path. |
| Accounts and shared access | No application login, business workspace, or roles | Before shared deployment: business/user separation, ownership checks on every record operation, sessions, owner/staff permissions, and an audit history. Someone with access to the current browser profile can use its stored records. |
| Customer directory | A customer/job name string; channel category only | Phone/email/contact destination, company/contact records, notes, duplicate handling, and history. A reply draft currently has no saved destination or link back to the original conversation. |
| Enquiry capture | Manual message paste | Capture source identifiers and timestamps. If integrations are required, implement provider authorization, webhook verification, duplicate-event handling, retries, and attachment/thread handling. Keep manual capture usable. |
| Sales follow-up | `new`, `replied`, `won`, `lost` | Editable enquiry details, owner, notes, next action/due date, follow-up reminders, loss reason, and a status/timestamp history. `replied` leads never become overdue under the current rule, even if the sale needs further attention. |
| Quote documents | A one-item calculator saved under a free-text job name | Multiple line items, customer details, quote number, issue/expiry dates, business branding, terms, discounts, configured taxes, and a printable/shareable document. Add draft/sent/accepted/declined/expired states and revisions. |
| Enquiry-to-quote flow | Independent arrays with no relationship | Create a quote from an enquiry, retain the customer/source relationship, and show quote status and history on that enquiry. Presently users must reconcile them manually. |
| Sale completion | Manually selecting `won` | Record accepted amounts, invoices/orders where needed, deposits, balances, payments, refunds/cancellations, and completion. A live payment integration is optional; reliable manual payment records can be the first step. |
| Profit accuracy | Estimates from one material rate, aggregate costs, and one percentage fee | Preserve estimate versus actual costs, distinguish margin from cash received, and support the business's actual fee/discount/tax structure. If fixed/minimum/tiered fees apply, a percentage-only field is insufficient. Make overhead allocation explicit. |
| Operational reporting | Unanswered count, 24-hour count, and manually entered potential value | Search, date filters, response times, follow-ups due, conversion, accepted quote value, collected payments, and estimated versus actual profit. Add source/channel views only where data supports them. |
| Usability at volume | Render every quote and every matching lead; one status filter | Search by customer/job, date/value filters, pagination or virtualization, archive, undo/soft deletion, useful sorting, and bulk import/export. Current synchronous whole-state writes and whole-list renders have no demonstrated production capacity. |
| Keyboard and accessibility | Labels for many inputs, a status toast, responsive layout | The restore control is a label over a `display:none` file input, with no keyboard-focusable trigger. Add keyboard-operable restore, clear active-tab semantics, inline error announcements, and verify screen-reader/focus behavior during list updates. |
| Operational maintenance | Four single-line files; no supplied release checks or monitoring | Readable maintained source, regression tests for calculations/persistence/import, browser workflow tests, release checks, client/server error reporting appropriate to the deployment, and a recovery/support process. A build framework is optional. |

## Prioritization needs improvement, not necessarily machine learning

`Pulse.priority()` recognizes a small English keyword list and a fixed 24-hour threshold. “I do not want to buy today” is flagged for buying intent and urgency. “Naomba bei ya viti 20” is not recognized as a price enquiry. All attention reasons collapse into one Boolean; lead value does not affect ordering. Older leads sort before newer leads within the same priority group.

For a first real pilot, add configurable working hours/response targets, follow-up due dates, explicit reasons, manual priority overrides, and vocabulary suitable for the actual customers. Measure missed and incorrect flags against reviewed real examples. A trained model is not a prerequisite for a useful tool.

Likewise, the current reply is a fixed acknowledgement template. It asks for details even when those details may already be in the enquiry. Add reusable templates and enquiry/quote context before considering generative replies. Any connected sending flow needs a clear review step, delivery/failure status, retry handling, and conversation history.

## Recommended delivery sequence

1. **Make the existing local pilot trustworthy.** Fix false save success, stale-tab overwrite, draft loss, malformed-storage recovery, mobile backup access, example isolation, import validation, and money/input boundaries. Add a recovery-focused regression suite.
2. **Complete one end-to-end business flow.** Customer/contact → enquiry → quote with line items → shareable quote → accepted/lost outcome → payment record. Link the records and retain timestamps/history. Include editing, search, and follow-up reminders.
3. **Support secure shared use.** Add authenticated persistent storage, business/user authorization, conflict handling, automatic backups, recovery verification, audit events, and error reporting. This step moves earlier if the first pilot requires teams or multiple devices.
4. **Connect the most valuable channel.** Choose based on the actual users' inbox. Implement authorization, webhook/event reliability, message context, and operator-reviewed sending. Add additional channels and payment automation only when justified.
5. **Improve reporting and triage using observed data.** Report actual conversion/payment/cost measures and tune priority rules against reviewed enquiries. Keep synthetic examples separate.

## Acceptance checks for a credible pilot

- A failed write never shows a saved/restored success state, and entered data remains recoverable.
- Edits made in two tabs cannot silently remove each other.
- A draft survives time refreshes, filtering, status changes, and reloads according to a clear persistence policy.
- Backup and restore work with keyboard and on mobile. A real export can be restored, invalid records cannot crash startup, and unsupported schemas receive a useful error.
- Demo data never enters business totals. Business records have usable identities and validated fields.
- Displayed target prices meet the target at the allowed currency precision. Invalid inputs cannot produce Infinity/NaN estimates.
- An operator can move one customer enquiry through a quote and recorded sale without re-entering disconnected records.
- For shared deployment, another user/business cannot read or change records they do not own or have permission to access.

## Reproduction artifacts

- [Runtime observations](runtime-observations.json)
- [Repeatable dependency-free check script](runtime-checks.cjs)
- [Desktop enquiry screenshot](enquiries-desktop.png)
- [Mobile enquiry screenshot](enquiries-mobile.png)

Run the observations with `node review/runtime-checks.cjs` from the project directory. The script uses isolated synthetic state and does not edit application code or browser data.

Relevant implementation locations: `app.js` — `save`, `calc`, quote/enquiry submit handlers, `renderLeads`, `valid`, restore handler, initialization; `logic.js` — `quote` and `priority`; `style.css` — the 650px media query; `index.html` — quote/enquiry forms and backup footer.
