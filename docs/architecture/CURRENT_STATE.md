# Resuto legacy: current state audit

Audit date: 2026-10-17. Subject: the legacy app as moved, unchanged, into `legacy/`.
Baseline: `cd legacy && npm test` runs 77 tests (76 pass, 1 skipped). The skipped one is `tests/firebase-tenancy.test.js`, which needs the Firebase emulators (`npm run test:firebase`).
Everything below comes from reading the source. Where something was checked at runtime, the text says so.

---

## 1. Shape of the system

| Layer | Implementation | Files |
|---|---|---|
| HTTP | One `node:http` server with no framework. A single `handleRequest` function holds every route as a chain of `if (p === ...)` checks. | `legacy/server.js` (240 lines, some lines are about 1,300 characters long) |
| Domain | Plain functions that change a whole-state JSON object inside `tx()`. | `platform-domain.js`, `floor-domain.js`, `restaurant-experience.js`, `receipts.js`, `data-tools.js` |
| Providers | Gemini, Stripe, Paymob, Foodics, Odoo and a media store, each in its own module. | `gemini-provider.js`, `ai-imports.js`, `ai-service.js`, `suggestions.js`, `payments.js`, `integrations.js`, `media-store.js` |
| Persistence | Local mode keeps the whole restaurant in one SQLite row. Firebase mode keeps one Firestore document per tenant. | `server.js` L33-43, `firebase-platform.js` |
| Frontend | Vanilla ES modules. HTML is built as template strings and assigned to `innerHTML`. No build step except the Firebase client bundle. | `public/*.js`, `public/*.css`, `public/locales/*` |
| SEO shell | The server rewrites `index.html` per route: title, meta, hreflang and JSON-LD. | `seo.js` |
| Runtime | `package.json` asks for Node `>=24`, while `render.yaml` pins `NODE_VERSION=22`. It uses `node:sqlite` (`DatabaseSync`) and `--env-file-if-exists`. Tests also pass on Node 22.22. | `package.json`, `render.yaml` |

Dependencies: `firebase`, `firebase-admin`, `qrcode`, plus the dev dependency `esbuild`. There is no web framework, ORM, validation library or test framework beyond `node:test`.

---

## 2. HTTP architecture (`legacy/server.js`)

**Request pipeline:**
1. `handler` (L236). In Firebase tenant mode, `identityProvider.resolve(req)` picks the tenant and identity, then `storage.withTenant()` (AsyncLocalStorage) runs the request.
2. `handleRequest` (L82) sets the security headers: CSP (`script-src 'self' https://apis.google.com`, `style-src 'unsafe-inline'`, `frame-ancestors 'none'`), `nosniff`, `Referrer-Policy: same-origin` and COOP.
3. **Non-API GET.** `/qr/*` returns an SVG QR code. `/media/*` reads from the media store. `/robots.txt`, `/sitemap.xml` and `/llms.txt` come from `seoDocument`. Static assets are allow-listed by regex. Every other path gets the SPA shell `index.html` passed through `renderShell()`. ETag is size+mtime (+ `shellKey`). Fonts and images are cached as immutable; JS, CSS and HTML use `no-cache`.
4. **POST body handling.** The `Origin` header must equal `APP_ORIGIN` (webhooks are exempt), the content type must be `application/json`, and the body is capped at 1.1 MB (13 MB for `menu-extract`/`floor-extract`).
5. **Writes** go through `tx(fn)` (L43). It opens a SQLite `BEGIN IMMEDIATE` or a Firestore conditional update, then expires held reservations, runs `sweepVisits` (auto-close), runs `fn`, re-runs `migrateFloor`/`migratePlatform`, and bumps `s.revision`.
6. **Errors** go out as `{error}` with `e.status`. Errors without a status become 500 with a generic message.

### Route table

**Page routes.** Every non-asset GET is served the SPA shell. Client routing happens in `public/entry.js` and `public/app.js`.

| Path | Client module | Audience |
|---|---|---|
| `/` | `landing.js` (+ `landing-*.js`) | Marketing |
| `/pricing` | `pricing.js`, `plan-comparison.js` | Marketing |
| `/account` | `account.js` + `firebase-client.js` | Firebase owner sign-up/sign-in, restaurant bootstrap, staff invite |
| `/reserve` | `reservations.js` | Guest booking on the floor map |
| `/burger`, `/burger/*` | `burger.js` | Second demo storefront, "Smash & Co" (branch `burger`) |
| `/restaurant`, `/menu`, `/order`, `/t/:qr`, `/s/:shareToken` | `guest.js` | Guest web app: restaurant page, menu-first ordering, table QR, share payment |
| `/manager`, `/manager/floor-editor`, `/manager/setup` | `app.js` (+ `manager-platform.js`, `floor-editor.js`, `setup.js`) | Manager |
| `/kitchen` | `app.js` (role `kitchen`, `kitchen-dnd.js`) | Kitchen display |
| `/host` | `app.js` → `host.js` | Front desk |
| `/qr/:tableQr`, `/qr/venue` | server | SVG QR for a table, or for the venue/counter (or `settings.publicPath`) |
| `/media/:key` | server | Menu images |
| `/robots.txt`, `/sitemap.xml`, `/llms.txt` | `seo.js` | SEO and answer engines |

**Public API (no auth):**

| Method/Path | Purpose |
|---|---|
| GET `/api/public` | Settings, payment config, brand, branches, menu (without `internalNotes`), public floor, active tables with availability. **Returns each table's `qr`** (see §15). |
| GET `/api/plans` | `plans` (Starter 799, Growth 1499, Pro 2999 EGP/month, Business on quote). `billingEnabled:false`. |
| GET `/api/integration-capabilities` | Connector and payment method availability |
| GET `/api/events` | `{revision}`. Used as a poll cursor; also triggers the auto-close sweep. Render health check. |
| GET `/api/availability` | Table IDs and per-table state for `start`/`party`/`branchId` |
| POST `/api/table-recommend` | Rules or Gemini table pick from free text (EN/AR) |
| GET `/api/reservation?token=` | Reservation view by guest token |
| POST `/api/reserve` | Create a 5-minute **held** reservation (idempotent `key`) |
| POST `/api/deposit` | **Simulated** deposit → `confirmed` (refused in live mode) |
| POST `/api/reservation-change` | Guest cancel or modify of a future confirmed reservation |
| POST `/api/table-session` | Scan table QR: rejoin the open visit (read-only fast path) or auto-open one; counter QR opens a counter visit |
| POST `/api/join` | Join a visit with QR + 6-digit PIN (rate-limited 20/min/IP) |
| POST `/api/offsite` | Legacy pickup/delivery visit |
| POST `/api/online-order` | Menu-first pickup/delivery order + payment (`platform-domain.placeOnline`) |
| POST `/api/recommend` | AI meal recommendation (budget, party, diet, allergens) |
| POST `/api/sales-inquiry` | Business-plan lead (rate-limited 5/min/IP, stored in `s.salesInquiries`) |
| GET `/api/share?token=`, GET `/api/share-qr?token=` | Split-share participant view and its QR |
| POST `/api/share-pay` | Simulated payment of one share |
| POST `/api/checkout` | Create a Stripe/Paymob hosted checkout for a bill or a share |
| POST `/api/webhooks/:provider` | Stripe/Paymob signed callbacks |
| POST `/api/login`, `/api/logout` | Staff password sessions |

**Guest API (Bearer visit token from `sessionStorage['resuto-token']`):** GET `/api/visit`, GET `/api/receipts`, GET `/api/receipt?payment|checkout|share|reservation`, POST `/api/order`, `/api/pay` (simulated), `/api/request` (`waiter`|`bill`), `/api/split`, `/api/rating`, `/api/suggest`.

**Staff API (cookie `session`, or Firebase ID token):**

| Role(s) | Endpoints |
|---|---|
| manager, kitchen, host | GET `/api/staff` (projection depends on role), POST `/api/transition`, `/api/resolve` |
| manager, host | POST `/api/seat`, `/api/clean`, `/api/close`, `/api/undo-auto-open` |
| manager only | GET `/api/setup`, `/api/floor`, `/api/export`, `/api/ai-capabilities`, `/api/integrations`; POST `/api/setup`, `/api/branch`, `/api/integrations`, `/api/integration-sync`, `/api/menu`, `/api/menu-metadata`, `/api/menu-preview`, `/api/menu-import`, `/api/menu-extract`, `/api/floor-extract`, `/api/menu-image`, `/api/menu-image-generate`, `/api/floor`, `/api/table`, `/api/background`, `/api/reservation-cancel`, `/api/settings`, `/api/manager-insights` |
| Firebase account | GET `/api/account/profile`, POST `/api/account/bootstrap`, `/api/account/invite` |

---

## 3. Frontend structure (`legacy/public`)

- **Shell.** `index.html` loads 17 stylesheets and `entry.js`. `entry.js` dynamically imports one page module per path. Staff pages get a floating language switcher.
- **Guest app** (`guest.js`, 53 KB). Screens are `menu`, `status`, `reserve`, `share`, `receipt`, `counter` and `closed`. It is menu-first with a product sheet (modifiers), cart (`sessionStorage['resuto-cart-v2']`), checkout, order timeline, bill, split builder, share links (with a `wa.me` share button), rating, receipts (`receipt.js`, `receipt.css`) and the AI "Help me choose" chat (`guest-chat.css`). It polls `GET /api/events` every 2 s and refetches when `revision` changes. It skips re-rendering while an input has focus.
- **Staff app** (`app.js`, 57 KB). The sidebar workspace has 14 manager tabs: `overview, floor, reservations, visits, orders, menu, inventory, customers, payments, analytics, branches, integrations, data, settings`. `overview`, `inventory`, `customers`, `payments`, `analytics`, `branches` and `integrations` are rendered by `manager-platform.js`. Kitchen gets one Kanban board with drag-and-drop (`kitchen-dnd.js`). Host gets `host.js` (floor, free tables, arrivals, open bills, requests, "Seat a walk-in"). Icons are Unicode glyphs (`const icons={overview:'◈',…}` in `app.js`). Polling is the same `/api/events` loop, paused on the data, integrations and inventory tabs.
- **Floor:** `floor-shared.js` (SVG scene renderer plus `geometryError`/`bounds`/`overlaps`, shared with the server), `floor-model.js` (`tableFeatures`, the 12-table `demoFloor` template), `floor-preview.js`, `floor-editor.js` (the full editor) and `owner-import.js` (AI floor and menu import choices).
- **Owner tools:** `setup.js` (8-step wizard), `owner-menu.js` (menu import page), `owner-media.js` (image upload/generate), `data-workspace.js`.
- **Landing:** `landing.js` + `landing-stage|kitchen|manager|reserve|bill|pricing|import|import-data.js`. These are interactive product demos built from DOM/SVG, with no video. Also `company-logos.js` and `brand-marks.js` (Simple Icons data URIs).
- **Auth client:** `client/firebase-client.js` is bundled by esbuild into `public/firebase-client.js` (142 KB, minified). It handles email/password and Google popup sign-in. The Firebase web config, including the public API key, is embedded.
- **i18n/RTL** (`i18n.js`):
  - `locales/en.js` is nearly empty, because keys are the English text. `locales/ar*.js` are 8 Arabic dictionaries merged with `Object.assign`.
  - Language comes from `?lang=ar|en`, which overrides `localStorage['resuto-language']`. `setLanguage` sets `<html lang dir>` on the client. The server sets `lang`/`dir` too when `?lang=ar` is present (`seo.js renderShell`).
  - Staff screens are translated after render by `translateLegacy()`. A MutationObserver plus TreeWalker swaps known English phrases for Arabic. This is fragile and misses unknown strings; `premium_smoke.py` writes out an "untranslated review" file.
  - Bilingual data fields are `name/nameAr`, `description/descriptionAr`, modifier `nameAr` and branch `nameAr`. Money uses `Intl.NumberFormat('ar-EG'|'en-EG', EGP)`.

---

## 4. Persistence

**SQLite (local default).** `DB_PATH` defaults to `legacy/data/resuto.sqlite`. The table is `state(id INTEGER PRIMARY KEY CHECK(id=1), json TEXT)` in WAL mode, so the **entire restaurant is one JSON string**. Every mutation reads it, parses it, mutates it, re-serialises it and writes it under `BEGIN IMMEDIATE`. Reads parse the full document each time.

**State document keys:** `demo, tables[], menu[], reservations[], visits[], orders[], payments[], requests[], audit[], idem{}, sessions[], settings{}, credentials{}, floor{}, branches[], splits[], shares[], ratings[], integrations{}, checkouts[], salesInquiries[], profile{}, setup{}, revision, platformVersion (4)`.

**Migrations.** These run on boot and after every `tx`:
- `migrateFloor` moves floors to schema v2.
- `migratePlatform` (platformVersion 4) adds branches, splits/shares/ratings, menu bilingual and rich fields, the default `serviceMode='tables'` and `venueQr`. When `demo` is set it also seeds the `burger` branch.

Both are idempotent and return a "changed" flag.

**Firestore (`FIREBASE_TENANT_MODE=true`, `firebase-platform.js`):**
- **Documents:**
  - `restaurants/{id}/private/state` holds `{state, revision, updatedAt}`.
  - `restaurants/{id}` holds `{name, slug, plan, subscription:{status:'trialing', trialEndsAt:+14d}, createdBy}`.
  - `restaurantSlugs/{slug}` holds `{restaurantId}`.
  - `users/{uid}` and `users/{uid}/memberships/{restaurantId}` hold `{role: owner|manager|kitchen|host}`.
  - `media/{key}` holds image bytes (`firestoreMediaStore`).
- **Caching.** Each tenant keeps its state in memory, fed by an `onSnapshot` listener (`watch`). Reads are served from that memory.
- **Conditional writes.** `transaction()` clones the cached state, applies `fn`, then calls `ref.update(..., {lastUpdateTime})`. If another instance won (`FAILED_PRECONDITION` code 9), it retries up to 4 times, re-reading on each retry. This is optimistic concurrency, not a Firestore transaction.
- **Initialisation.** `initialize` seeds the demo tenant `olive-room-demo` in a real Firestore transaction.
- **Rules** (`firestore.rules`). Clients may read `restaurantSlugs`, their own `users` docs and memberships, and the `restaurants/{id}` metadata of restaurants they belong to. Every client write is denied. `private/**` is server-only.
- **Scaling hazard.** A Firestore document is capped at 1 MiB. The single state document holds every order, the audit log, idempotency results, sessions and the base64 floor background, which can reach 1 MB and is stored **twice**: `settings.background` and `floor.background.image`. None of these is ever pruned except expired sessions. A busy tenant will hit the cap.

**Media.** `localMediaStore` writes to `legacy/data/media`. `firestoreMediaStore` stores images up to 800 KB. Keys are `menu-<itemId>-<rand>.<ext>`, served at `/media/<key>`.

---

## 5. Auth and sessions

- **Staff passwords.** There are three shared role passwords (`MANAGER_PASSWORD`, `KITCHEN_PASSWORD`, `HOST_PASSWORD`). They are stored as **unsalted SHA-256** in `state.credentials`. If an env var is missing on first boot, a random password is printed to the console. Comparison hashes again and uses `timingSafeEqual`.
- **Login** (`/api/login`). Rate limit is 20 per minute per `req.socket.remoteAddress`, in memory. On success it creates an opaque 128-bit token `{token, role, expires:+8h}` in `state.sessions` (plaintext) and sets `Set-Cookie: session=…; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800` (plus `Secure` on https). There is one cookie name for all roles, so a browser holds one role at a time. Every login is a full state write and bumps `revision`.
- **Guest auth.**
  - **Visits.** `visit.token` is a 128-bit hex value sent as `Authorization: Bearer`. The `guest()` lookup does not check visit status.
  - **PIN join.** Dine-in visits also get a 6-digit `pin` (`/api/join`). Since auto-open, rejoining works without the PIN.
  - **Shares.** Each share has its own `token`, used in the `/s/:token` URL.
  - **Reservations.** Each has a `token` for view, change and receipt.
- **Firebase Auth.**
  - **Request handling.** A Bearer JWT is verified with `verifyIdToken(token, true)`. The tenant is chosen by the `X-Restaurant-Id` header, or else the first membership. The role comes from the `X-Workspace-Role` header: owners and managers may act as any role, while kitchen and host are fixed.
  - **Guests in tenant mode.** Requests resolve the tenant by `X-Restaurant-Slug` or `?restaurant=`, and fall back to **the demo tenant**.
  - **Bootstrap.** `bootstrap` creates the slug, restaurant, user and owner membership in one transaction, then seeds the tenant with `createTenantSeed` (6 tables, empty menu, `credentials:{}`).
  - **Invite.** `invite` creates a Firebase user with a password chosen by the manager, plus the membership.

---

## 6. State machines and business rules

### Orders (`/api/transition`, server.js L214)
```
received -> preparing -> ready -> served            (dine-in, counter)
                               -> picked_up         (pickup)
                               -> out_for_delivery -> delivered   (delivery)
received -> cancelled   (manager only, and only when the visit is not settling; stock is restored)
```
- **Optimistic version.** Each order carries `version`; a mismatch returns 409.
- **Fulfilment.** `FULFILLED = served|picked_up|delivered` sets `fulfilledAt`.
- **Who can transition.** Kitchen, host and manager can all advance orders.
- **Order number.** `number = s.orders.length + 1`, so numbers are sequential per tenant. The kitchen displays `#001`; receipts show `RS-00001`.
- **Order creation** (`quoteLines`).
  - **Prices and stock.** The server re-prices every line: base price plus modifiers. If the client sent a price and it differs, the request fails with 409. Required modifiers are enforced, items must be available in the branch, `qty` is 1-50, there are at most 50 lines, and stock is checked across all lines. Stock is decremented atomically.
  - **Snapshot.** Each line records `{id, name, nameAr, qty, price, station, options}`.
  - **Integer minor units.** Money is integer piastres (EGP×100) everywhere.
  - **Settling block.** Ordering is blocked only while `settling`, meaning a pending checkout or an active split exists. Requesting the bill or paying part of it does **not** block ordering.

### Visits
- **Types:** `dine-in`, `counter`, `pickup`, `delivery`.
- **Statuses:** `open` → `closed`. An `undone` flag is set when an auto-open is undone.
- **Opening a visit:**
  - **QR scan (auto-open).** Only when there is no open visit, the table is not cleaning, it is reservable, the branch is active, and no reservation overlaps the next `duration+buffer` window. A confirmed reservation in the window −15/+30 min is checked in (`seated`) and its deposit becomes `credit`.
  - **Staff seat** (`/api/seat`) applies the same checks.
  - **Counter.** `serviceMode` is `counter` or `delivery`, with a single `venueQr`.
- **Undo.** `/api/undo-auto-open` releases an auto-opened visit within 60 s if it has no orders or payments. A seated reservation goes back to `confirmed`.
- **Close.**
  - **Manual** (`/api/close`). Requires no pending checkout, `due == 0`, and every order fulfilled or cancelled.
  - **Auto** (`sweepVisits`, run on every tx, `/api/staff` and `/api/events`). Requires paid, everything fulfilled, no open requests, no pending checkout, and 10 minutes quiet (`AUTO_CLOSE_MS`).
  - **Settle** (`settleVisit`). Writes a `test-refund` payment for unused credit, marks the reservation `completed`, and resolves the visit's requests.
- **Bill:** `subtotal = Σ non-cancelled order totals`, `total = subtotal + fee` (delivery fee), `due = max(0, total − credit − Σ bill payments)`.
- **Tables:** `cleaning` is a flag, and `/api/clean` clears it. The close dialog in `app.js` says "the table will then need cleaning", but no server code path sets `cleaning=true`. The rendered floor shows "Cleaning" only if seed or legacy data set it. Treat this as a gap. `active=false` archives a table.

### Reservations
```
held (5 min, expires) --deposit--> confirmed --check-in (−15/+30 min)--> seated --close--> completed
held --(expires)--> expired     held|confirmed --staff cancel--> cancelled
confirmed (future) --guest cancel--> cancelled (refundStatus text only)   confirmed --guest modify--> confirmed (new table/time)
```
- **Overlap.** A slot occupies `start` to `start + (duration + buffer)` minutes; the defaults are 90 + 15. Blocking statuses are `confirmed`, `seated` and unexpired `held`. `start` must lie between now−60 s and now+180 days. `party` must be 1 to the table's capacity.
- **When accepted.** Only when `serviceMode=tables` and `reservationsEnabled`, on a branch with `reservations:true`, at a table with `reservable!==false`.
- **Deposits.** The amount is `settings.deposit` (demo: 20000 = EGP 200). Payment is **simulated only** (`/api/deposit` returns 503 in live mode). The deposit becomes visit `credit` at check-in. Unused credit produces a `test-refund` row when the visit closes. A guest cancel only records the text "Contact restaurant for deposit refund".

### Payments
- **Bill payments** are rows in `s.payments` with `kind: bill|deposit|test-refund`, plus `provider` and `providerId` for online payments.
- **Idempotency** (`idem()`). Keyed by `scope:key` and stored in `s.idem` together with a SHA-256 fingerprint of the payload. Reusing a key with a different payload returns 409; a replay returns the stored result. It applies to order, pay, request, reserve, deposit, offsite, online-order, split, share-pay, checkout, menu-import, floor-save, reservation-change and sales-inquiry. It is never pruned.
- **Simulated payments.** `/api/pay`, `payShare` and `placeOnline(payment:'demo')`. These are refused when `PAYMENT_MODE=live`.
- **Online checkout:**
  1. A `tx` creates `checkouts[]` `{id, visitId, shareId, amount, provider, status:'pending', returnPath}`. The amount must be ≤ due, there may be only one pending checkout per visit or share, and the visit is set to `locked`.
  2. A second `tx` marks `creating` once, so a non-Stripe retry is refused rather than double-charging.
  3. `createCheckout` is called. Stripe gets an `Idempotency-Key` of `checkout.id`.
  4. The `providerId` and `url` are stored.
- **Webhook.** Finds the checkout by `provider + providerId` and requires matching amount and EGP. It is idempotent on `paid`. It writes the payment row and closes the share/split if all shares are paid. If due is less than the amount, it returns 409 "requires reconciliation" (there is no reconciliation UI).
- **Splits** (`createSplit`):
  - **Methods.** `full`, `equal` (2-20 people), `custom` (amounts must sum exactly to due) and `items` (each ordered *unit* is assigned exactly once). Amounts are apportioned by the largest-remainder method on integer piastres.
  - **Activation.** The split becomes `active` and the visit is `locked`. One `share` is created per participant: `{token, amount, status: pending→paid}`.
  - **Completion.** The split becomes `complete` when all shares are paid. A share cannot be rated until it is paid.
- **Ratings.** `overall` 1-5, optional `food`, `service`, `speed` and `value`, at most one per visit or share, and only after payment.

### Settings and service model
- **`serviceMode`.** `tables` (per-table QR), `counter` (single `venueQr`; counter orders), or `delivery` (online only). Reservations exist only in `tables`.
- **Settings validation:** `duration` 15-240, `buffer` 0-60, `deposit` 0-1,000,000, `deliveryFee` 0-100,000.

### Identifiers to preserve
- **Tables.** `id` (`t1`…, or 32-hex for new tables) and **`qr`** (32-hex, printed on physical QR codes, stable across floor saves).
- **Venue.** `settings.venueQr`.
- **Tokens.** Visit, share and reservation `token`s.
- **Menu.** Item ids: `m0`-`m7` for the demo, `b0`-`b8` for the burger brand, 32-hex for imports.
- **Branches.** `main` and `burger`.
- **Orders.** `number`.
- **Floor.** Object ids.
- **Firebase.** Restaurant ids `<slug>-<8hex>` and the slug.

---

## 7. Floor studio

- **Server** (`floor-domain.js`):
  - **Schema v2.** `{schemaVersion:2, revision, width:1200, height:800, background:{image, opacity, locked, x, y, width, height}, zones[], objects[]}`. Table geometry lives on `tables[]` (`cx, cy, width, height, rotation, shape round|square|rectangle`).
  - **Field visibility.** `publicTableKeys` and `managerTableKeys` differ by `internalNotes`.
  - **Migration.** v0 → v2 converts percentage `x/y` into layout units (`cx = x·12`, `cy = y·8`), adds default zones and objects, and on v1 forces round/square tables to have equal width and height.
  - **`saveFloor` validation, part 1.** `baseRevision` must equal `floor.revision`, otherwise 409 ("draft preserved"). Limits are at most 150 tables, 300 objects and 50 zones. Ids must be unique and match `^[\w-]+$`.
  - **`saveFloor` validation, part 2.** New tables must use ids starting `new-`; the server assigns the real `id` and `qr`. Archived tables cannot be restored. Size is 40-500 units, capacity 1-20, `features` must come from `tableFeatures` (13 tags), and `branchId` cannot change. `minimumSpend` and `premium` are validated. `geometryError` (shared with the client) rejects out-of-bounds or rotated overflow.
  - **Archival rules.** A table missing from the draft is archived (`active=false`), unless it has an open visit or a future reservation in confirmed, seated or unexpired-held state (409).
  - **Background.** A PNG/JPEG data URL of at most 1,000,000 characters ("under 700 KB").
- **Legacy writes.** `/api/table` (`legacyTable`) handles per-table edits with `version` checks and also bumps `floor.revision`.
- **Client.**
  - **Editor** (`floor-editor.js`, `floor-editor.css`, `floor-system.css`). An SVG draft workspace (`#studio-canvas`) with drag, rotate, resize, zones, objects and background, plus validation.
  - **Imports.** An imported draft arrives via `sessionStorage['resuto-floor-import-draft']`.
  - **Table states** are rendered as CSS classes: `state-available|occupied|ordering|preparing|ready|eating|payment|bill-requested|partially-paid|paid|cleaning|reserved|unavailable|recommended`.

---

## 8. Gemini integrations

- **`gemini-provider.js`.** Uses `generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` with header `x-goog-api-key`.
  - **Models.** `GEMINI_TEXT_MODEL`, `GEMINI_VISION_MODEL` and `GEMINI_IMAGE_MODEL`, each falling back to `GEMINI_MODEL`, whose default is `gemini-3.6-flash`. Image generation is off unless `GEMINI_IMAGE_MODEL` is set.
  - **`geminiJson`.** Uses `responseJsonSchema`; `maxItems` is stripped because the provider rejects it.
  - **`validateSources`.** At most 6 sources, 3 MB each and 9 MB in total. Allowed types are PDF, PNG, JPEG, WebP and text.
- **`ai-imports.js`.**
  - **`extractMenuDraft`.** Produces bilingual items, options, confidence and source indexes, and flags missing prices, low confidence and duplicates.
  - **`extractFloorDraft`.** Produces geometry fitted to the canvas and validated with `geometryError`.
  - **Approval.** Both only return drafts with `status:'review'`. A manager approves them through `/api/menu-import` or `/api/floor`. Nothing is auto-published.
- **`ai-service.js`.**
  - **`recommend`.** Gemini or a demo provider produces the suggestion. The output is validated: menu ids must be real, stock must be sufficient, the total must fit the budget, and total quantity must be at least the party size. Validation failure falls back to demo rules. An allergen disclaimer is always attached.
  - **`managerInsights`.** Gemini may only select among rule-built cards (low stock, station load).
- **`suggestions.js`.** Rules find the gap in the order (drink, starter, side or dessert). Gemini may only re-rank the candidates.
- **`restaurant-experience.recommendTables`.** Parses Arabic and English text: Arabic-Indic digits, party size, and feature words such as non-smoking, window, quiet and terrace. Gemini picks from the validated available tables.
- **`data-tools.extractMenu`.** An older single-file extraction function. It is not routed and hard-codes `gemini-2.5-flash`.
- **Labelling.** Every AI response carries `mode` (`Live Gemini` | `Demo rules` | `Fallback · demo rules`), and the UI shows it.

---

## 9. Payments (`payments.js`)

- **`paymentConfig(state)`.** Providers are enabled purely by env vars, with a per-tenant `integrations.<p>.enabled !== false` toggle. `methods` are cash (request), card (Stripe/Paymob), wallet (Paymob wallet integration id) and InstaPay (manual, `INSTAPAY_MERCHANT_ADDRESS`). **Credentials are global, one merchant for all tenants.**
- **Stripe.** Checkout Session through form-encoded `POST /v1/checkout/sessions`, `currency egp`, 30-minute expiry, success and cancel URLs at `returnPath?checkout=returned|cancelled`. Webhook check: `stripe-signature` `t` and `v1` HMAC-SHA256 over `t.raw`, at most 300 s skew, constant-time compare. It handles `checkout.session.completed`, `async_payment_succeeded` and `expired`.
- **Paymob.** Intention API `POST {base}/v1/intention/` (base allow-listed to `accept|uae|ksa|oman.paymob.com`) → unified checkout URL. Webhook check: HMAC-SHA512 over 20 concatenated fields compared with `?hmac`. It requires `success`, not `pending`, not refunded, not voided and not auth-only. **It only accepts `integration_id === PAYMOB_INTEGRATION_ID_CARD`, so wallet payments are never confirmed (bug).** `redirection_url` is always `/order`, so share payers are not returned to `/s/:token`.
- **InstaPay.** The address is only displayed. The manifests say "confirmed by the manager on the bill", but there is no confirmation endpoint.
- **Refunds.** Only an internal `test-refund` row for unused deposit credit. There are no provider refund API calls.

---

## 10. POS integrations (`integrations.js`)

- **Base class.** `IntegrationAdapter`, with `FoodicsAdapter` (`GET api.foodics.com/v5/products?include=category`, Bearer token) and `OdooAdapter` (Odoo 19 JSON-2 `/json/2/product.template/search_read`, HTTPS only). Both import **menu only**: at most 300 rows, mapped to draft CSV rows with `available:false, stock:0`.
- **Sync** (`/api/integration-sync`). Returns rows for review; the manager then imports them through `menu-preview`/`menu-import`. Orders are never pushed back.
- **Catalogue.** `marketplace()` lists foodics, odoo, paymob and stripe as implemented. WhatsApp, Email, SMS, Delivery providers, Accounting and Foodics Pay are `implemented:false` and shown as "Coming soon".

---

## 11. Tenant model

- **Local/SQLite.** One restaurant per process, plus a demo second brand (`burger` branch) inside the same state.
- **Branches.** Branches are entries in `s.branches` within one state. Menu items carry `branchIds[]`, tables carry `branchId`, and visits carry `branchId`. Per-branch fields: `pickup`, `delivery`, `deliveryAreas[]`, `paymentProvider auto|demo|stripe|paymob`, `reservations`, `nameAr`, `address`, `phone`, `hours`, `mapsUrl`.
- **Firebase.**
  - **Tenancy.** Each restaurant is its own document and is isolated by membership, with the slug as its public handle.
  - **Plans.** Recorded on `restaurants/{id}` (`trialing` for 14 days), but **nothing enforces plan limits** (`plan-comparison.js` says so).
  - **Webhook bug.** Webhooks carry no tenant identifier, so in tenant mode they resolve to the demo tenant. Any non-demo tenant's online payment would fail reconciliation.

---

## 12. Receipts (`receipts.js`)

Receipts are read-only projections over `s.payments`. A receipt exists only for a confirmed payment row.

| Field | Format |
|---|---|
| Receipt id | `RC-<8>` |
| Transaction | `TXN-<8>` |
| Order refs | `RS-00001` |
| Reservation ref | `RSV-<8>` |

Each receipt contains the brand, branch, items merged by dish and price, totals and the split context. A checkout receipt stays `pending` until the webhook has written the payment. The client draws a barcode SVG, can share the receipt as text, and supports print CSS (`receipt.css`). There is no tax line, VAT or fiscal numbering.

---

## 13. SEO (`seo.js`)

- **Indexed routes.** Only `/`, `/pricing`, `/restaurant`, `/menu` and `/reserve` get titles, descriptions and Open Graph tags in both languages, plus canonical and hreflang (`?lang=ar`) and JSON-LD (`WebSite`, `Organization`, `SoftwareApplication` with an `Offer`, `FAQPage`).
- **No-index.** Every other route gets `noindex,nofollow`.
- **Fallbacks and extras.** A readable fallback is rendered inside `#app`, and `robots.txt`, `sitemap.xml` (with `xhtml:link` alternates) and `llms.txt` are served.
- **Shared copy.** Plan facts come from `plans` and `plan-comparison.js` so they cannot drift.

---

## 14. Automated tests and smoke scripts

All tests use `node:test` against `createApp({dbPath:':memory:'})`, or a temp file, through the real HTTP handler.

| File | Coverage |
|---|---|
| `tests/api.test.js` (~40 tests) | Branch and modifier pricing; menu-first online checkout; split invitations; floor reservation tags; QR auto-open, undo and auto-close; manager import/export authz; Stripe checkout and signed webhook mismatch; role isolation and cross-origin refusal; QR does not authorize a bill (PIN); walk-in→order→kitchen→split→close; concurrent reservation holds; capacity and buffer; expired holds; deposit idempotency and credit refund; check-in window; guest token isolation; price re-check and stock rollback; duplicate keys; concurrent overpay; payment idempotency; bill-request dedupe; ordering pause while settling; stale kitchen transitions; cancel restores stock once; floor stale saves and archive protection; pickup and delivery transitions; menu recommendation rules; SQLite persistence; QR SVG; menu concurrent edits; background validation; oversell; floor migration; floor authz and private notes; floor commit preserves QR; floor retries; layout revision conflicts; rotated geometry rollback |
| `tests/rebuild.test.js` | Equal and custom split minor-unit preservation; item-split allocations; share completion idempotency; AI source limits; AI capability sanitising and image-gen 503; media upload authz and serving |
| `tests/receipts.test.js` | Receipt only after a confirmed payment and scoped to its visit; provider receipt pending until webhook; deposit and share receipts; host role limits (seat and clean, never money, menu or layout); service model gating; counter venue link; counter order type |
| `tests/experience.test.js` | Sales inquiries; Gemini table output validation; setup is manager-only and revision-protected; 12-table template and availability; premium metadata rollback and honest pricing |
| `tests/owner-ai.test.js` | AI menu and floor drafts validated, never published; approval writes canonical state |
| `tests/ai-service.test.js` | Gemini gets the structured catalogue; unsafe suggestions fall back |
| `tests/paymob.test.js` | Paymob intention uses the server amount; HMAC, order, currency and success checks |
| `tests/data-tools.test.js` | CSV quoting, Unicode and formula-injection escaping; preview and import rejects; exports exclude secrets |
| `tests/deployment.test.js` | Two app instances on one SQLite file: atomic writes and rollback |
| `tests/firebase-tenancy.test.js` | Firestore and Auth isolation (skipped without the emulators) |
| `tests/render.test.js` | Page templates execute for `/`, `/restaurant`, `/reserve`, `/menu`, `/order`, `/t/example`, `/manager` and `/kitchen` against stubs (no browser) |

**Python smoke scripts** (`scripts/*.py`) use Python Playwright, which is **not installed in this container**, against an isolated server.
- **`premium_smoke.py`** covers scenarios A-F: an Arabic AI request, a reservation, PIN-free dine-in, a four-way split, kitchen flow, and RTL at 5 widths.
- **The others:** `experience_smoke.py`, `editor_smoke.py`, `data_guest_smoke.py`, `owner_ai_smoke.py`, `browser_smoke.py`, and the `audit_flow`, `audit_routes`, `audit_rtl` and `audit_staff` audits.
- **Screenshot helpers:** `shot.py`, `shot_stitch.py`, `shots_sections.py`.

**Node scripts.** `build-client.mjs` (esbuild Firebase bundle), `check-source.mjs` (`node --check` over all JS), `build-static-landing.mjs` (static landing for Vercel from `landing-snapshot.json`), `provision-smash.mjs`, `owner-fixture-server.mjs` and `write-owner-fixtures.mjs`.

---

## 15. Deployments

- **Render** (`render.yaml`). A free web service in Frankfurt; `npm ci && npm run build`, then `npm start`, with health check `/api/events`.
  - **Environment.** `FIREBASE_TENANT_MODE=true`, `FIREBASE_PROJECT_ID=resuto-cf8f5`, and **`PAYMENT_MODE=test`, so production accepts simulated payments**. Secrets: `FIREBASE_SERVICE_ACCOUNT` (JSON or base64), `APP_ORIGIN`, the role passwords and `GEMINI_API_KEY`.
  - **Behaviour.** The service sleeps when idle, with a cold start of about 30 s. The live URL is `resutogdg.onrender.com`.
- **Vercel** (`vercel.json`). A static landing page plus `/pricing` built into `dist-landing/`. `/api/public`, `/api/plans` and `/api/integration-capabilities` are rewritten to snapshot JSON. App routes redirect (302) to Render. It sets its own CSP.
- **Firebase** (`firebase.json`, `.firebaserc` → `resuto-cf8f5`). Provides Firestore rules, the Auth and Firestore emulators (ports 9099 and 8080), and a hosting config that serves `public/` with an SPA rewrite. That hosting cannot run the server; `DEPLOYMENT.md` explains that Blaze billing would be needed.
- **Older docs.** `ARCHITECTURE_AUDIT.md` mentions Postgres on Netlify; no such code exists any more.

---

## 16. Security weaknesses observed

1. **Remote takeover of any table.** `GET /api/public` returns every active table's **`qr`**. `POST /api/table-session {qr}` then auto-opens the table, or for an open visit returns its **bearer token** without a PIN. Anyone on the internet can therefore open tables, order to them, read bills, create splits and make simulated payments for any table. *Verified at runtime: two anonymous scans returned the same token, and `/api/visit` with that token succeeded.* The test "QR identifies a table but never authorizes its bill" still passes. It only checks that the raw QR is not accepted as a Bearer token and that a wrong PIN fails. It does not cover the `/api/table-session` rejoin path.
2. **Production accepts fake payments.** `PAYMENT_MODE=test` in `render.yaml` lets any guest mark bills, shares and deposits paid with simulated payments.
3. **Weak password storage.** Staff passwords are shared per role (no per-user accountability without Firebase) and stored as unsalted SHA-256. Session tokens are stored in plaintext inside the tenant state document.
4. **Rate limiting is unreliable.** Limits are in-memory, per process, and keyed on `socket.remoteAddress`. Behind Render's proxy that is the proxy IP, so the limits are either global (a single attacker can lock out logins) or ineffective across instances. The `rates` map is never pruned. PIN brute force (10⁶ space) depends on this limit.
5. **Unauthenticated AI calls.** `/api/recommend` and `/api/table-recommend` call Gemini for anonymous users with no rate limit, so they can be used to run up cost.
6. **Webhooks ignore the tenant.** In Firebase mode, webhooks and unauthenticated guest calls without a slug resolve to the demo tenant (§11). The payment credentials are platform-global, so there is no per-restaurant merchant.
7. **Unbounded state growth.** `audit`, `idem`, `orders`, `payments` and `salesInquiries` grow without limit in one JSON document. That means O(n) parse and serialise on every request, and a hard failure at Firestore's 1 MiB document limit. Base64 backgrounds are stored twice.
8. **Origin check only when present.** Requests without an `Origin` header are accepted. The cookie is `SameSite=Strict`, so CSRF risk is low, but the check is weak.
9. **CSP and XSS exposure.** The CSP allows `style-src 'unsafe-inline'`. Rendering is `innerHTML` string templating throughout, so XSS safety depends on remembering `escapeHtml` everywhere.
10. **Closed-visit tokens stay valid.** Guest tokens remain valid for reads after a visit closes, with no expiry.
11. **Unenforced plans.** Plans and subscriptions are not enforced. `trialEndsAt` is never checked.
12. **Missing data controls.** No audit trail of the actor: audit rows hold the event type and entity only, not who did it. There is no PII retention policy for customer contacts.

---

## 17. Migration must-preserve checklist

- Integer minor-unit money (EGP piastres) with server-side re-pricing and price-change 409.
- Idempotency keys with payload fingerprints on every guest and owner mutation.
- Optimistic `version` checks on menu, tables and orders; `revision` on floor and setup.
- The full order, visit, reservation, split and share state machines, including the settling rule, auto-open/undo (60 s) and auto-close (10 min quiet).
- The reservation hold of 5 minutes, the duration+buffer overlap rule, the −15/+30 min check-in window, and deposit → credit → unused-credit refund.
- Table `qr` and `venueQr` identity (printed QR codes), floor schema v2 geometry (1200×800 units), and the archival protection rules.
- AI is draft-only and validated, always labelled with its mode, and Gemini may only select from server-built candidates.
- Webhook signature verification (Stripe v1 HMAC-SHA256 with 300 s tolerance; Paymob HMAC-SHA512 over 20 fields) and amount and currency matching.
- Receipts only from confirmed payments.
- Role matrix: manager everything; host seat, clean, close, undo, resolve and transition; kitchen transition and resolve.
