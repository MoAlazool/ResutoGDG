# Browser end-to-end suite (Playwright)

Real browsers (Chromium, Playwright 1.56.1) against the **real API and the built web
app**. The `real-*` and `scenario-*` specs (Agent H) never intercept Resuto API requests;
they seed data through the public/staff APIs (helpers in `tests/e2e/fixtures.ts`) and read
the e2e database only to check server-side effects. F's `floor.spec.ts` still drives
Floor Studio against its in-browser §8 double (`floor-api-mock.ts`);
`real-floor.spec.ts` covers the same UI against B1's real floor API.

Defects found are listed in [`BROWSER_DEFECTS.md`](./BROWSER_DEFECTS.md). Specs covering a
defect assert the correct behaviour and are marked `test.fail()` (`// DEFECT: H-<n>`).

## Running

```bash
pnpm install
pnpm --filter @resuto/contracts build && pnpm --filter @resuto/integrations build
# Defaults: API :4109, web :3109, database resuto_e2e_f. Any of them can be overridden:
E2E_API_PORT=4110 E2E_WEB_PORT=3110 \
E2E_DATABASE_URL=postgres://postgres@127.0.0.1:54329/resuto_e2e_h \
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers pnpm e2e
```

Playwright's `webServer` entries (`tests/e2e/playwright.config.ts`) recreate and migrate the
database, build and start the API **and the outbox worker** (`start-api.mjs`; set
`E2E_WORKER=0` to skip the worker), then `next build` + `next start` the web app.
`E2E_REUSE_SERVERS=1` reuses servers you already started on those ports.

Harness changes made by H (env-overridable, F's defaults unchanged):
- `start-api.mjs` derives the second CORS origin from `E2E_WEB_ORIGIN` (was a fixed `127.0.0.1:3109`)
  and starts `dist/worker.js` beside the API, so outbox handlers (delivery jobs, WhatsApp
  confirmations, fiscal documents) run during browser scenarios.
- `landing.spec.ts` checks the canonical URL against `WEB_URL` instead of a hard-coded `:3109`.
- `fixtures.ts` gained append-only helpers: `apiAs`, `apiSeedMenu` (menu API), `apiSaveFloor` /
  `apiQrSheet` (floor API), `apiInvite` / `apiAddMember`, `newContext` (signed-in / 390 px /
  locale), `collectApiFailures`, `eventually`, `paySandboxInBrowser`, `TINY_PNG`, `MOBILE`.

## Result of the final run

Full suite, servers started by Playwright (fresh migrated `resuto_e2e_h`, ports 4110/3110),
2026-10-17: **60 tests — 53 passed, 7 expected failures (known defects), 0 unexpected
failures, 0 flaky, 0 skipped** (Playwright prints "60 passed" because expected failures
count as passing). Runtime 6.3 min after the build.

| Spec | Tests | Passed | Expected fail |
|---|---|---|---|
| `floor.spec.ts` (F, §8 double) | 5 | 5 | 0 |
| `landing.spec.ts` (F) | 10 | 10 | 0 |
| `onboarding.spec.ts` (F) | 1 | 1 | 0 |
| `studio.spec.ts` (F) | 6 | 6 | 0 |
| `real-floor.spec.ts` (H) | 7 | 5 | 2 (H-1, H-2) |
| `scenario-dine-in.spec.ts` (H) | 3 | 1 | 2 (H-3, H-4) |
| `scenario-whatsapp.spec.ts` (H) | 3 | 2 | 1 (H-5) |
| `scenario-driver.spec.ts` (H) | 2 | 1 | 1 (H-6) |
| `scenario-owner.spec.ts` (H) | 23 | 22 | 1 (H-7) |
| **Total** | **60** | **53** | **7** |

## What each H spec covers

### `real-floor.spec.ts` — Floor Studio, QR sheet and live floor on B1's floor API
- Fresh branch: add the first table and save — **expected fail, H-1** (`zone: null` → 400).
- Add a round table, move it (keyboard), rotate it (↻ 15° ×3), save, reload: revision 2 on the
  server with `cx`, `rotation: 45`, `zone`, server-issued id; inspector shows the same values. ✓
- Two managers (two browser contexts) on revision 1: A saves; B's save gets
  `409 stale_layout { currentRevision: 2 }`, the conflict banner, *Export draft* downloads the
  draft JSON (baseRevision 1), *Reload saved floor* loads A's layout; B's change never lands. ✓
- Removing a table with an open visit: `409 table_in_use { tableId }`, the Studio message names
  the table, nothing archived, revision unchanged. ✓
- QR sheet tab: one card per table with a real server-rendered QR SVG, *Print* button, URLs
  `${APP_ORIGIN}/t/<token>`, print media hides the controls. ✓
- Live floor: select T1, seat a walk-in (party 3), a guest orders through the table QR, the
  panel shows "Ordered" and the balance; *Close table* → `409 visit_not_settled` → "Close with an
  open balance?" → *Close anyway* → visit closed. ✓
- After closing, the table needs cleaning and *Mark clean* returns it to Available —
  **expected fail, H-2**.
- The real API's differences from F's §8 double are tabulated at the end of `BROWSER_DEFECTS.md`.

### `scenario-dine-in.spec.ts` — Scenario 2 in the browser
Menu (modifiers) and floor seeded through the API; QR URL from the staff print sheet.
- One test, three browser contexts (guest A and guest B at 390 px, staff at 1280 px): guest A
  scans `/t/<qr>`, picks *Smash burger* → required *Size: Large* (+EGP 30) → *Send to kitchen*;
  the KDS (`/kitchen/<org>`) shows the ticket with "Large" and "Table T1", *Start preparing* →
  *Ready* → *Served*; guest A sees "Served" and the bill (EGP 215); splits equally
  (2 × EGP 107.50) on `/t/<qr>/pay/split`; guest B joins from the QR; each guest opens a share
  (`/s/<token>`) → hosted checkout `/pay/<token>` → Card (sandbox) → `/pay/<token>/sandbox` →
  *Simulate successful payment* → "Payment successful"; the bill shows "All shares are paid."
  (order `paid`, 21500 minor); staff close the visit from the live floor without a force
  prompt. No console errors or failed API calls for the guests. ✓
- Reloading the guest page after the visit was closed shows "session ended" — **expected fail, H-3**.
- The order-tracking sheet polls at its 2.5 s cadence and stays closed — **expected fail, H-4**.

### `scenario-whatsapp.spec.ts` — Scenario 3 hosted ordering page
The conversation is driven through the staff sandbox simulator
(`POST /connect/sandbox/inbound`: "order" → *Pickup* → name) and the bot's `cta_url` link is opened.
- English and Arabic runs at 390 px: Large burger (modifier sheet) + Fries, *Review order*
  (EGP 260), *Pay online* → *Pay now* → hosted checkout → sandbox success; the order is
  `whatsapp`/`paid`/`placed`, is in `GET /kitchen/:branchId` and on the KDS, and the
  conversation receives the confirmation (worker). Arabic run: `dir="rtl"`, `lang="ar"`, no
  horizontal overflow on the ordering, review and payment pages. ✓ ✓
- Opening the link with `resuto_locale=ar` starts in Arabic — **expected fail, H-5** (the Arabic
  run switches with the page's own language toggle).

### `scenario-driver.spec.ts` — Scenario 4 delivery
- A driver invited by the owner accepts on `/invite/<token>` (390 px, geolocation granted) and
  goes Online; a COD delivery order is placed through the website ordering API; the worker
  creates the job; the dispatcher assigns the driver on `/dashboard/<org>/delivery`; the driver
  accepts, sees "Waiting for the kitchen…" with pickup disabled; the KDS readies the order; the
  driver confirms pickup, starts the delivery, uploads a PNG proof photo (`201`), collects the
  prefilled cash and confirms delivery; the dispatcher sees it under "Closed in the last 12
  hours" with the proof photo; the order is `delivered`/`paid` (paid = total), the job
  `delivered`/`collected`, and the driver's cash on hand equals the COD amount. ✓
- The KDS "Out for delivery" button must not close a driver-dispatched order — **expected fail, H-6**.

### `scenario-owner.spec.ts` — owner journey
- 21 dashboard pages (overview, orders, menu, reservations, inventory, customers, analytics,
  inbox, marketing, payments, finance, compliance, intelligence, mcp, website, billing, team,
  settings, audit, integrations, delivery) × {en, ar} × {1280, 390 px} for a `pro` owner with a
  menu, floor, an open dine-in order and a sandbox WhatsApp channel. Each load must render the
  shell and an `h1`, set `dir` correctly, show no error notice or upgrade prompt, log no
  console errors, make no failed API call (status ≥ 400 or network error) and have no
  horizontal overflow. All 21 pass. Screenshots: `tests/e2e/__screenshots__/owner/<page>-en-1280.webp`
  and `<page>-ar-390.webp` (42 WebP files, 6–47 KB each; regenerated on every run, so they
  change with the clock on the overview/audit pages).
- A `free`-plan owner gets `402` from the marketing API and sees "This module is not in your
  plan" with an *Upgrade* link to billing (and the 🔒 in the sidebar) on marketing, delivery and
  finance, in English and Arabic. ✓
- Gated pages make no module API calls and log no errors — **expected fail, H-7**.

## Notes and limits
- One worker, sequential (`workers: 1`), as in F's config; each test creates its own tenant.
- Payments use the sandbox provider only (`PAYMENT_MODE=sandbox`); no real provider is contacted.
- The owner journey checks page loads, not every interaction on every page; deeper per-module
  flows are covered by the module API tests and by G's API scenarios (`apps/api/test/scenarios/`).
