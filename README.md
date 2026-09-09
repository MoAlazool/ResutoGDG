# Resuto

A runnable restaurant MVP: guest reservations and QR ordering, a manager floor workspace, a kitchen display, inventory, a simulated payment ledger and configurable Stripe/Paymob hosted checkout adapters. Built from the supplied master plan in an initially empty workspace.

## Experience upgrade

Guided setup: `/manager/setup`. Pricing: `/pricing`. Reservations: `/reserve`. Floor preview and the new template are inside `/manager/floor-editor`.

See [the implementation and verification report](docs/EXPERIENCE-VERIFICATION.md) for tested flows, screenshots and remaining launch requirements. The app is still one restaurant installation; merchant signup and subscription billing are not implemented.

## Run

Requires Node.js 24 or later.

```powershell
npm install
# On a fresh checkout, copy .env.example to .env and choose staff passwords.
npm start
```

- Resuto product page: http://localhost:3000
- The Olive Room guest website: http://localhost:3000/restaurant
- Manager: http://localhost:3000/manager
- Kitchen: http://localhost:3000/kitchen
- Floor studio (manager login): http://localhost:3000/manager/floor-editor

For this workspace, unique manager and kitchen passwords have already been generated in the ignored `.env` file. Open that file to retrieve them. Password changes in `.env` apply at server restart. Without configured passwords, the initial startup generates and prints them once. Staff sessions expire after eight hours; use separate browser profiles for manager and kitchen.

Deployment runs on Firebase: `npm run deploy` publishes Hosting and the Firestore rules in `firebase.json`. See [latest verification](MVP_VERIFICATION.md).

## What works

- Dedicated SVG floor studio with tables, walls, doors, windows, counters, labels and zones; drag, resize, rotate, multi-select, align, space evenly, duplicate, keyboard controls, zoom/pan and undo/redo. Save the full layout explicitly, or discard the draft. Drafts survive reload and failed saves; stale saves offer reload/export instead of overwriting another manager. Stable table QR downloads and the print sheet remain available.
- Distinct Resuto SaaS landing page and The Olive Room guest website, with actual product screenshots, generated restaurant imagery and current menu highlights. The restaurant identity carries into guest reservations and ordering.
- Cairo-time reservations, capacity and overlap checks, five-minute holds, explicit simulated deposit confirmation, staff check-in and one-time credit.
- Staff-created walk-ins, immediate PIN-free table-QR menu access, guest bearer credentials, cart, menu notes, stock validation and immutable order prices.
- Shared kitchen for dine-in, pickup and delivery with guarded order transitions and foreground polling every two seconds.
- Waiter and bill requests, partial simulated payments, idempotent retries, overpayment prevention, settlement locks, close-and-clean workflow, unused deposit test refunds.
- Manager CSV import with editable review and version checks; optional Gemini PDF/photo/text extraction; CSV/JSON business-data exports.
- Whole-bill, equal-share, family/group and custom-amount payment controls.
- Menu creation and editing, categories, stations, allergens, vegetarian flags, availability, prices and portions. Unavailable items retain their historical order references.
- Restaurant name, branch, reservation duration/buffer, test deposit, delivery enablement/fee settings; measured station queues and audit history.
- Menu recommendations in explicitly labeled demo rules mode. Optional server-side Gemini adapter validates proposals before returning them, with a visibly labeled fallback on provider failure. Recommendations require cart review and separate order confirmation.

SQLite stores state in `data/resuto.sqlite`. A single synchronous write transaction protects each mutation, including stock and balances. This small single-process implementation keeps a serialized domain state document in SQLite; it is not a relational multi-tenant production schema. Firebase deployments keep the same domain rules, with each restaurant's state in its own Firestore document guarded by a conditional write. See `firebase.json` for setup and data transfer.

## Rehearse

1. Sign in as manager and seat T1.
2. Scan T1’s QR or open its guest link in a separate browser. The menu opens immediately; no PIN is required.
3. Add food and confirm the order.
4. Sign into the kitchen in another browser profile; advance the order through preparing, ready and served.
5. In two guest browsers using that table QR, open the bill and pay separate test shares.
6. Close the visit in the manager workspace and mark the table clean.
7. Create a reservation, confirm its test deposit, and check it in from 15 minutes before to 30 minutes after its start.
8. Try pickup and delivery, then restart the server to check persistence.

## Validation

```powershell
npm run build
npm test
```

All 48 automated tests pass, including Postgres migration/concurrency, QR access, data imports/exports and signed payment callback fixtures. Coverage includes floor migration, atomic geometry updates, manager authorization, concurrent layout saves, QR preservation, archival protection, and the original reservation/order/payment protections.

The real Chromium browser smoke test passed twice consecutively with isolated manager, kitchen and two guest browser contexts, including 390-pixel mobile viewports. It verifies lost-response order/payment retries, live kitchen updates, split payments, cleaning, reservations and deposit credit, pickup/delivery, floor dragging, and restart persistence. Guest updates were observed in approximately 0.8–2.3 seconds. A table QR was independently decoded with OpenCV from the browser screenshot. Real iPhone/Safari and Android device testing remains unperformed. An optional feature-detected WebMCP read-menu tool is included but has not been verified in a supporting browser.

Run the reproducible browser test with `npm run test:browser`. It needs Python Playwright and Chromium (`pip install playwright`, then `python -m playwright install chromium`). It uses a temporary database on port 3100 and fictional guests; it does not modify the normal demo database or call Gemini. See `BROWSER_VERIFICATION.md` for the verification boundary.

Run `npm run test:editor` for the public pages and dedicated editor rehearsal. It uses port 3101 and another isolated temporary database. It verifies desktop/mobile page rendering, actual editor gestures, property changes, draft isolation, undo/redo, two-manager conflicts, export/reload, structural objects, background controls, network retry and draft recovery.

## Floor data and recovery

The startup migration introduces a versioned 1200 × 800 layout-unit canvas while retaining existing table IDs, QR identifiers, reservations and visits. Manager `GET /api/floor` reads the current layout; `POST /api/floor` atomically saves `{baseRevision, key, layout}`. Guest maps read sanitized saved geometry through `/api/public`. Existing table/background writes also advance the layout revision.

The floor editor stores its unsaved draft in session storage in the current browser tab. A successful save or explicit discard clears it. Background uploads remain PNG/JPEG under 700 KB. Layout units are illustrative, not building measurements. Deleting a table from a saved layout archives it and is blocked when an active visit or future reservation needs it. Operational occupancy and cleaning state are merged from the database, never from the submitted draft.

Before this upgrade, the local database and its SQLite sidecar files were copied to the ignored `data/before-floor-upgrade/` directory with the server stopped. Keep this backup private. The normal application continues to use `data/resuto.sqlite`.

## Optional live AI

Set `GEMINI_API_KEY` and optionally `GEMINI_MODEL` in `.env`, then restart. Live Gemini has not been integration-tested here because no provider credentials were supplied. Demo rules apply structured budget, vegetarian and excluded-allergen controls; free-text preference understanding requires the live provider. Listed allergens never establish allergy safety or cross-contact safety.

## Phone access and deployment

The server listens on all interfaces. For trusted LAN testing, set `APP_ORIGIN` to the laptop's phone-reachable address (for example `http://192.168.1.10:3000`) and open that same origin on every device. QR content uses this configured origin. Existing QR identifiers survive origin changes. Use HTTPS, strong staff passwords, persistent disk and suitable network access controls for a hosted deployment. The included Hosted deployments use Firestore instead of SQLite. See `NETLIFY_DEPLOYMENT.md`; deploy the full Git project, not just the static public folder.

## Boundaries

Payments default to simulation. Stripe and Paymob checkout adapters and verified webhook handling are implemented but have not been tested against real merchant accounts. Real refunds, fiscal receipts, online reservation deposits and automatic Paymob abandoned-checkout reconciliation remain unimplemented. No WhatsApp, courier API, live delivery tracking, employee identities, multi-branch tenancy or production onboarding. Floor geometry is illustrative, not an architectural or safety plan. Opening hours, product photography, modifiers, per-person dietary allocation, ingredient-level stock, Arabic UI, and full offline recovery are future work. Holds should be confirmed before navigating away; reservations and payment ledgers persist on the server, but an abandoned guest hold confirmation is not recovered automatically.

No real guest data is seeded. Preserve `.env` and `data/` privately; both are ignored by Git. Back up the database with the server stopped (or SQLite's backup API), including its WAL files if copying a running instance. For a clean rehearsal, stop the server and move the `data` directory to a backup location before restarting.
