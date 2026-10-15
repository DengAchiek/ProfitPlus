# ProfitPulse 2 implementation

All eight suggested improvement areas now have working application functionality. The original source is retained in `review/v1/`. No real customer records were used during development or browser verification.

| Area | Delivered |
| --- | --- |
| Dependable saving | Server acknowledgements, validated SQLite transactions, conflict rejection, active-editor preservation, recoverable archives, safety previews and tested backups |
| Accounts and storage | Owner/staff accounts, hashed passwords, expiring sessions, CSRF/origin checks, business isolation, account controls and persistent server records |
| Customer profiles | Contacts, company, notes, duplicate detection and linked customer history |
| Professional quotes | Multiple items, costs, discounts, configurable tax, fees, target margin, numbering, expiry, terms, statuses, revisions and PDFs |
| Follow-up | Assigned staff, next-action dates, overdue reminders in the app, configurable response targets, English/Swahili rules, manual priority and saved reply drafts |
| Sales and payments | Quote-to-invoice conversion, deposits, final payments, refunds, balances, actual fees/costs, cost finalization and actual order margins |
| Daily usability | Search, filters, sorting, pagination, mobile navigation and backups, archiving, undo and restoration |
| Reporting | Overdue work, acceptance, net sales, collections, unpaid balances, channel attribution, estimated/actual profit and CSV exports |

## Verification

- `npm run check` passed.
- **40 automated tests passed**, covering calculations, records, conflicts, permissions, sessions, validation, ledgers, archive recovery, import, physical backups, HTTP routes/security/failures, PDFs, linked-customer consistency and timestamp clock skew.
- Browser-tested customer creation → enquiry → two-item accepted quotation → invoice → deposit → final payment → actual cost → completed order with finalized costs → reports.
- The browser test produced KSh 17,081.00 total payments, KSh 14,725.00 sales before tax, KSh 9,500.00 actual costs and KSh 170.81 actual fees, yielding KSh 5,054.19 actual order profit. These figures are synthetic test data in an isolated temporary database.
- A saved reply survived reload. An unsaved reply remained visible while filtering. The active composer is outside the rendered enquiry list.
- At 390 × 844, both the backup action and the restore file control remained accessible. Desktop and mobile evidence is included in this folder.
- Quotation PDF text and layout were checked with PDF extraction and page rendering. A blank footer page was corrected. Automated tests also cover a 100-item quotation.
- No browser console errors were observed during the tested workflows.

## Operating boundaries

Start with `npm start` and create the first owner account. The README explains persistent storage, legacy import, restore, full database recovery, and HTTPS hosting for shared access.

The demo is read only and separate from business data. Enquiries and payments are entered manually; copied replies are sent by the operator. Live messaging/payment services, external notifications, public hosting, offsite backup operations and capacity testing require deployment/provider setup. The implementation does not claim those external services are connected.

Financial reports retain archived quotations/invoices. Archiving a payment or cost removes that entry from calculations while preserving it for restoration and audit. Cancelled invoices are excluded from sales. Actual profit is an order margin excluding tax and is separate from money collected.

Portable JSON exports contain business settings and records. Full server database snapshots also preserve accounts and revision/audit history. Recovery restores to a fresh directory and invalidates sessions.
