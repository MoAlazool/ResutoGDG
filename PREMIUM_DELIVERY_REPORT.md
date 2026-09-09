# Resuto premium MVP delivery — 6 September 2026

## 1. Implemented

- A substantially redesigned SaaS landing page at `/`: interactive workflow, real saved floor geometry, illustrated AI recommendations, QR ordering, kitchen, shared payments, manager insights and Native/Connect sections. No invented customer numbers, testimonials, pricing or partnerships.
- A distinct Olive Room restaurant site at `/restaurant`, menu-first `/menu`, reservation map at `/reserve`, and PIN-free table URLs at `/t/:qr`.
- Original food imagery, local English/Arabic fonts and persistent EN/AR direction switching. Arabic uses real medium body, semibold control and bold heading fonts. Foodics, Odoo, Paymob, Stripe and WhatsApp logos replace the landing section's initials.
- Product details, search, categories, stock, allergens, optional/required extras and a cart sheet. Fulfillment is selected at checkout. Branches constrain pickup, delivery areas and payment methods; the server validates quantities, modifiers and prices.
- Server-side Gemini guest recommendations with structured output and validation against catalog IDs, stock, budget and explicitly supplied dietary constraints. Recommendations require acceptance before entering the cart. Manager AI uses measured operational facts.
- Named bill shares with separate secret invitation links, no participant account, individual payment status and owner progress. Integer minor-unit accounting prevents rounding loss and duplicate settlement.
- Post-payment ratings, optional food/service/speed/value scores and manager aggregates; visual order timelines and kitchen fulfillment.
- Dedicated floor editor with zones, table geometry, structures, chairs/plants, background controls, draft recovery, undo/redo, alignment, spacing, revision conflict recovery, validation and protected table archival. Table reservation tags and reservable controls are persisted.
- Manager overview, inventory metadata/options, customers, payments, ratings, branches and integrations. CSV import/export, reviewed extraction, and connector draft handoff into the import review screen.

## 2. Main files

Backend: `server.js`, `platform-domain.js`, `ai-service.js`, `integrations.js`, `payments.js`, `floor-domain.js`, `postgres-store.js`, `data-tools.js`.

Frontend: `public/entry.js`, `guest.js`, `marketing.js`, `manager-platform.js`, `platform.css`, `brand-refinements.css`, `company-logos.js`, `i18n.js`, `locales/*`, plus retained staff/editor/data modules. Local assets and license files are under `public/assets` and `public/fonts`. See `ASSET_SOURCES.md` for provenance.

Checks: `tests/*.test.js`, `scripts/premium_smoke.py`, `scripts/editor_smoke.py`, `scripts/check-source.mjs`, `scripts/package-netlify.mjs`. Historical `browser_smoke.py` and `data_guest_smoke.py` target the former guest UI and are not the current acceptance suite.

## 3. Schema and preservation

The application keeps its existing state document in SQLite locally and transactional Postgres JSONB on Netlify. Platform version 2 adds branches, menu metadata/modifiers, splits, shares, ratings, integrations and an event revision. The versioned floor document retains geometry and background configuration. New metadata is supplied during migration without replacing existing operational associations.

Existing table/QR identities are preserved by the migration and covered by tests. Floor saves alter geometry atomically and do not overwrite occupancy, payments, orders or cleaning. Tests use temporary databases rather than the user's restaurant database.

## 4. Environment

See `.env.example`: `PORT`, `APP_ORIGIN`, `MANAGER_PASSWORD`, `KITCHEN_PASSWORD`, `PAYMENT_MODE`, `DATABASE_URL` or Netlify-provided `NETLIFY_DB_URL`; optional `GEMINI_API_KEY`, `GEMINI_MODEL`; Stripe and Paymob credentials; Foodics token; Odoo HTTPS URL, API key, database and verified currency.

Secrets remain server-side. Do not upload `.env`, the local database or generated test artifacts to a public source repository.

## 5. Provider readiness

| Provider | Implemented | External verification |
|---|---|---|
| Demo | Local recommendations and simulated ledger/deposit/share payments | Exercised end to end |
| Gemini | Structured guest suggestions, manager insights, menu extraction | Mocked response validation tested; live key not supplied |
| Stripe | Hosted checkout and signed completion/expiry handling, including assigned shares | Adapter/callback tests pass; merchant sandbox and live charges not performed |
| Paymob | Hosted intention and signed payment confirmation | Adapter tests pass; merchant sandbox and live charges not performed |
| Foodics | Products-to-review-draft adapter | Credentials/account scope and real response still need acceptance; no order push |
| Odoo | Odoo 19 JSON-2 product draft adapter | Credentials, plan and currency need acceptance; no order push |
| WhatsApp | User-initiated share link | Automated messages are explicitly coming soon |

POS menu pulls are limited to the returned page/300 records. They do not constitute complete POS synchronization. Enabling a configured integration is a local setting; a successful sync is separate evidence that its credentials work.

## 6. Demo boundaries

The example restaurant does not claim real opening hours, reviews or contact details. Preview payment amounts and AI examples are labeled illustrative. Test payments move only the internal demo ledger. QR browsing requires no PIN; ordering joins a table only after staff open a visit.

## 7. Remaining limits

- Netlify hosting has not been performed. Deployment configuration and function packaging are verified locally.
- Real gateway acceptance, refunds, chargebacks, abandoned Paymob reconciliation and live reservation deposits remain outstanding. Keep test mode for the complete reservation demo.
- This remains one restaurant account with one reservation floor. Additional branches support fulfillment; separate branch floor plans, merchant signup and subscriptions are not implemented.
- External POS order push, automated messaging and courier dispatch remain unconnected.
- Updates use two-second revision polling, not persistent WebSockets. Physical-phone testing and a complete assistive-technology audit remain separate.
- EN/AR is verified on the principal guest, manager and editor screens. User-entered restaurant/catalog content requires its own Arabic copy; free-text errors from external services are not guaranteed to be translated.
- The current port-3000 server was left running after automatic approval review rejected a restart. Static landing/logo/font changes are visible on refresh. Restart the existing app process to load the final backend changes; isolated test servers ran the current source.

## 8. Verification

- `npm test`: **53 passed**, including stock/price transactions, idempotency, permissions, reservations, archival, migration, stale revisions, signed payments, named shares, ratings, branch restrictions and Arabic modifier persistence.
- `npm run build`: all JavaScript sources pass syntax checks.
- `npm run package:netlify`: `artifacts/netlify-functions/api.zip` produced successfully. Automated Postgres/cold-start/Lambda checks pass.
- `npm run test:editor`: Chromium passed creation, dragging, resizing, rotation, duplication, multi-selection, alignment, spacing, keyboard movement, undo/redo, discard, save/reload, conflict export/reload, failed save recovery, background controls and responsive panels.
- Premium Chromium: menu-first AI demo request, pickup test payment, ratings, next-day window-tagged reservation, PIN-free QR ordering, four independently named share payments and owner updates. Kitchen fulfillment, close and cleaning exercised. English/Arabic landing/menu tested at 375, 430, 768, 1024 and 1440 pixels; screenshots retained under `artifacts`.
- Logos were individually decoded in Chromium; Arabic heading computed weight is 700 using Plex Arabic.

## 9. Run and deploy

```powershell
npm install
npm start
npm test
npm run build
npm run test:browser
npm run test:editor
npm run package:netlify
```

Run from the project directory using Node 24; browser checks require Python Playwright with Chromium installed. Use the passwords in your private `.env` for staff login. Follow `NETLIFY_DEPLOYMENT.md` for Netlify Database, origin, function environment and secure data transfer. Uploading only the public folder is insufficient.

## 10. Requested scenario checklist

| Scenario | Result |
|---|---|
| A: Arabic group request → pickup → payment → kitchen | Pass with explicitly labeled demo AI and test payment; real Gemini still unverified |
| B: Tomorrow 21:00, four guests, window table | Pass using a fixture table tagged Window side and a simulated deposit |
| C: Table QR → menu without PIN → dine-in order | Pass with fixture T1; migration/API tests preserve QR identities for all labels, including existing T7 |
| D: EGP 1,200 / four people | API verifies exact EGP 300 shares; browser exercises four links and settlement using its ordered catalog item |
| E: Detailed rating reaches manager | Pass |
| F: Arabic/RTL across principal pages | Pass at five guest widths and desktop manager/editor; not a claim of physical-device testing |
