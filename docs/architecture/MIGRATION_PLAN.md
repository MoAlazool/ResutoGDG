# Migration plan — ResutoGDG 1.x → Resuto 2.0

Parallel, incremental migration. The legacy application stays runnable in
`legacy/` (and deployed from `main`) until 2.0 passes the regression and data
migration gates below. Nothing in this branch touches production.

## Stages

| Stage | Content | Exit gate |
|---|---|---|
| A — Snapshot & audit | Legacy moved to `legacy/` unchanged; `CURRENT_STATE.md`, `FEATURE_INVENTORY.md`, `docs/ui/UI_INVENTORY.md`, design tokens, 31 baseline screenshots | Legacy `npm test`: 76 pass / 1 skipped (Firebase emulator) — same as before the move |
| B — Foundation | Monorepo, schema + RLS, API core, kernel, web shell | `pnpm db:test` and API tests green |
| C — Core migration | Menu, floor (geometry preserved), QR ordering, visits, kitchen, reservations, payments, inventory | Functional + regression against legacy behaviours listed in CURRENT_STATE.md |
| D — Ecosystem MVP | Connect, Marketing, Driver, Studio, Finance, Compliance, Billing, Integrations, Admin | Module acceptance tests (docs/MODULE_STATUS.md) |
| E — AI & MCP | Baselines, inference API, insights, assistant, MCP server | Reproducible evaluation reports; MCP security tests |
| F — End-to-end | Scenarios 1–10 (tests/e2e) | All scenarios pass |
| G — QA & staging | Visual regression vs baseline, security review, load smoke, staging deploy | DEPLOYMENT_READINESS checklist |

## Data migration (SQLite / Firestore → PostgreSQL)

Tool: `tools/legacy-migration` (Agent A).

1. **Extract**: read the legacy state document (SQLite `state.json` row, or a Firestore
   export of `restaurants/{id}/private/state`). Never connect to production directly;
   migrate from an exported, access-controlled copy.
2. **Map deterministically**: new UUIDs are UUIDv5(`resuto-legacy:<restaurantId>:<entity>:<legacyId>`)
   so re-runs produce the same ids; every mapping is written to `legacy_id_map`.
3. **Preserve identifiers verbatim**: table `qr` → `dining_tables.qr_token` (printed QR
   codes keep working), order numbers, payment provider references
   (`payments.provider_payment_id`), reservation codes, menu ids (`products.legacy_id`),
   slugs, branch ids (`branches.legacy_id`).
4. **Transform**: integer EGP piastres stay integers; statuses via
   `LEGACY_ORDER_STATUS` in contracts; floor schema v2 geometry copied 1:1 into
   `floor_layouts` + `dining_tables`; audit/history into `order_events`.
5. **Load** in one transaction per tenant with checkpoints (per entity type),
   resumable by entity.
6. **Reconcile**: report counts and sums (orders, order totals, payments, reservation
   counts, menu items, tables, QR tokens, **media**, **venue QR tokens**) legacy vs. new; any
   mismatch fails the run (nothing is committed).
   - **Media (CR-13)**: every legacy menu photo is copied into tenant storage — uploads from the
     exported legacy media store (`--media-dir`, `imageMediaKey` / `/media/<key>`), files from the
     legacy `public/` folder (`--assets-dir`, `assets/…`, including the Smash & Co storefront photos
     the legacy `burger.js` showed for burger-branch items) and inline `data:` URLs. Types are read
     from the bytes; files go to local storage (`--storage-dir`) or Supabase Storage (`SUPABASE_URL`
     + `SUPABASE_SERVICE_ROLE_KEY`, bucket `tenant-media`) and are recorded in `media_assets` and
     `products.image_media_id`. A photo that cannot be found or stored fails the reconciliation.
   - **Venue QR (CR-13)**: the legacy venue token (`settings.venueQr`, printed as `<origin>/t/<token>`
     for counter service) is mapped to the main branch in `legacy_id_map`; `GET /v1/public/venue/:token`
     resolves it and the web app's `/t/<token>` redirects to the FT-07 venue route
     (`/order/<slug>?branch=<code>`). A token already mapped to another restaurant aborts the run.
   - Demo and rehearsal loads can re-time the document (`retimeTo`) and import in-progress work older
     than N hours as closed history (`closeStaleAfterHours`); every change is reported as a warning and
     the reconciliation still compares against the untouched document.
7. **Rollback**: delete the tenant's migrated rows via `legacy_id_map` (organization
   cascade) — legacy data is never modified.

Rehearse on the sanitized demo datasets before any real tenant: The Olive Room (table service,
`fixtures/olive-room.legacy-state.json`) and Smash & Co (counter service with a venue QR, a media-store
upload, `public/` photos and a `data:` URL; `fixtures/smash-and-co.legacy-state.json`, built by
`build-smash-fixture.mjs`). Both reconcile cleanly including media and venue QR tokens
(`node --test tools/legacy-migration/test/*.test.mjs`). Production cutover requires explicit owner approval and a maintenance window
(see DEPLOYMENT_READINESS.md).

## Behaviour parity checklist (from the audit)

- Server re-prices every line; client price mismatch → 409 (`price_changed`). ✅ kernel
- Idempotency key reuse with different payload → 409. ✅ IdempotencyService
- Orders: received→preparing→ready→served/picked_up/delivered; cancel restores stock. ✅ kernel (2.0 adds `accepted`, `awaiting_payment`)
- Visit auto-open on QR scan, 60 s undo, auto-close after paid + served + quiet 10 min. → B1
- Reservation hold 5 min, deposit confirm, check-in window −15/+30 min, deposit → visit credit, unused credit refunded on close. → B1 + D1
- Split: full / equal (2–20) / custom (exact) / by item (each unit once), largest-remainder. → D1 (`splitEvenly` in contracts)
- Receipts only for confirmed payments. → D1/D2
- Floor: 1200×800 canvas, revision check, archive blocked by open visit/future reservation, server-issued ids/QR. → B1/F
- Stripe HMAC-SHA256 (300 s tolerance), Paymob HMAC-SHA512 (20 fields), amount+currency match. → D1
- **Fix, do not migrate**: public exposure of table QR tokens; simulated payments in production; shared role passwords.
