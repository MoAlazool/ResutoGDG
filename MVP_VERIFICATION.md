# MVP verification — 6 September 2026

## Delivered

- Table QR scans immediately show the menu. An unopened table supports browsing and cart preparation; opening the visit as staff automatically enables ordering. Two phones share the current visit without a PIN. Existing table/QR identities remain intact.
- Landing page now explicitly describes AI menu help, equal/family/custom bill splitting, provider checkout configuration and menu import/business-data export.
- Manager Import & export workspace: CSV preview, editable item fields, atomic version-checked import, PDF/photo/text extraction adapter with review, and CSV/JSON exports for menu/orders/reservations/payments. Extraction needs a configured Gemini key; it never silently publishes model output.
- Guest bill: full remaining bill, equal share, family/group share and custom amount; simulated payment by default; configurable Stripe and Paymob hosted checkout with signed webhook confirmation.
- Netlify function, SPA/API/QR routing, persistent Postgres adapter, repeatable SQL migration, safe local-to-empty-Postgres transfer script, deployment documentation and packaged function.

## Checks performed

| Check | Result |
|---|---|
| Syntax build | Passed |
| Automated suite | 48 passed |
| Netlify local Postgres emulator | Migration repeatability, cold-start identity preservation, two application instances, concurrent stock protection and transaction rollback passed |
| Packaged Netlify ESM function | Built, unpacked and invoked through rewritten API path against emulator; public data returned successfully |
| Stripe fixtures | Server amount, duplicate checkout, pending balance lock, simulated-payment rejection in live mode, invalid signature, amount mismatch and duplicate successful callback passed |
| Paymob fixtures | Intention payload, provider order mapping, HMAC validation and tamper rejection passed |
| Original service journey in real Chromium | PIN-free shared QR, lost order/payment response retries, kitchen progression, split payments, cleaning, reservation/check-in/deposit credit, pickup/delivery and restart persistence passed |
| Public pages and floor editor in real Chromium | Desktop/mobile pages, draft editing, drag/resize/rotation, multi-selection/alignment/spacing, undo/discard/save, conflict export/reload, backgrounds and failed-save recovery passed |
| New data and guest flow in real Chromium | Unopened-table menu preview, automatic staff activation, reviewed CSV import/export, missing extraction configuration message, assistant, family payment amount and desktop/mobile landing passed |
| npm dependency audit | No known vulnerabilities after updating the TOML transitive dependency override |

Reproducible commands: `npm run build`, `npm test`, `npm run test:browser`, `npm run test:editor`, `npm run test:data`, `npm run package:netlify`. Browser scripts use isolated temporary SQLite files, fictional people and separate browser contexts; they do not mutate the normal restaurant database. Automated extraction and provider tests use fixtures, not external services.

## Screenshots

- [Updated desktop landing](artifacts/saas-updated-1440.png)
- [Updated mobile landing](artifacts/saas-updated-390.png)
- [Import/export workspace](artifacts/data-workspace.png)
- [Mobile family split](artifacts/family-split-mobile.png)
- [Desktop floor editor](artifacts/floor-editor-desktop.png)
- [Mobile floor editor](artifacts/floor-editor-mobile.png)

## Remaining external and live-service work

No Netlify account deployment, gateway sandbox/live transaction, actual phone-device testing or live Gemini request was performed. The app and package are ready for a configured Netlify **demo deployment**, not an unqualified real-money restaurant launch. Configure credentials privately using `.env.example` and `NETLIFY_DEPLOYMENT.md`.

Online reservation deposits, automatic refunds/chargebacks and automatic Paymob abandoned/uncertain-attempt reconciliation are not implemented. In live mode simulated payments/deposits are blocked; a pending Paymob attempt intentionally retains its balance reservation until operator reconciliation. Hosted payment callback acceptance and these remaining live-service paths must be resolved before taking real customer money. This is one restaurant, not a merchant onboarding/subscription/multi-tenant platform.

Existing QR identifiers survive deployment; already printed localhost URLs must be regenerated with the final public origin. The source bundle excludes `.env`, local databases, dependencies and private artifacts.
