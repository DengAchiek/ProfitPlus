# ProfitPulse — Quotes & Leads
An editable, dependency-free first version in HTML, CSS and JavaScript.

Open dist/index.html in a browser, or serve dist with `python3 -m http.server 8080 --directory dist`. Deploy dist to any static host. No build step is required.

## Quote checker
Enter quantity, unit price, materials per unit, total labour, transport, other costs, transaction fee percentage and target margin. The suggested price is base costs / (quantity × (1 - target margin - fee rate)). Tax is excluded. Margin is profit/revenue, not markup. Allocate overhead in other costs. Save and reopen quotes as copies.

## Enquiry tracker
Manually paste enquiries, optional estimated value and received time. Keyword rules flag intent and urgency; unanswered enquiries older than 24 hours are flagged. Set statuses and prepare editable reply drafts. Nothing is sent automatically. Potential sales is the sum of entered values for unanswered enquiries, not realised revenue or a probability-weighted forecast.

## Data
Records are saved in browser localStorage only. They do not sync across devices and may be cleared by browser settings. Export JSON backups regularly; restore replaces existing data after confirmation. Example records are explicitly synthetic. Use a dedicated browser profile for business data. There are no email/WhatsApp connections, shared accounts, backend or trained ML model in this version.

## Files
- dist/index.html: interface
- dist/style.css: responsive design
- dist/logic.js: calculation and priority rules
- dist/app.js: persistence and interactions

Next production steps: authenticated server storage, consent-based inbox integration, and priority validation against labelled real enquiries.
