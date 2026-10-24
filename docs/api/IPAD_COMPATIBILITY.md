# iPad POS — API compatibility checklist

The contract between the Resuto API (`/v1`) and the native iPad POS app (built on `feature/ipad-pos`). It lists
every route and event the app needs, its status, the contract version that introduced it and the tests that cover
it. **Keep this file current on every API change that touches these routes**: `apps/api/test/pos-flow.test.ts` fails
when a POS route is served but not listed here, or listed here but not served.

- Contract version: **0.1.0** (`POS_CONTRACT_VERSION` in `packages/contracts/src/pos.ts`; also returned by
  `GET /v1/pos/session` and `POST /v1/pos/pair`).
- Schemas: request bodies and queries are zod schemas in `packages/contracts/src/pos.ts` and are published in
  `docs/api/openapi.json` (OpenAPI 3.1). Response shapes are the TypeScript interfaces in the same file (`PosSession`,
  `PosEventPage`, `PosMenuSync`, `PosOrder`, …); OpenAPI does not describe response bodies yet.
- Status: **draft** = implemented and tested on this branch, may still change additively before the app integrates.
  **stable** = validated against staging with the real app; changes are additive only. Nothing is stable yet: an
  entry moves to stable when the iPad team has run it against staging (plan §10).
- History: `docs/api/CHANGELOG.md`.

## Auth model

1. A manager (permission `devices:manage`: owner, admin and manager; a branch-scoped manager only for their
   branches) creates a pairing code for **one branch and one acting role** (`waiter`, `cashier` or `kitchen`):
   `POST /v1/o/:orgId/pos/pairings` → `{ code: "XXXXX-XXXXX", expiresAt }`. The code is 10 characters of Crockford
   base32 (50 bits), single use, valid 1–60 minutes (default 10). Only its SHA-256 is stored.
2. The device sends the code to `POST /v1/pos/pair` (public; case and dashes do not matter; 30 attempts per IP per 10
   minutes) and receives its credential once: `rpos_<43 url-safe characters>` (256 bits). Store it in the Keychain.
   Only its SHA-256 and a display prefix are stored server side. The credential expires after `deviceTtlDays`
   (default 365, at most 730).
3. Every device request sends `Authorization: Bearer rpos_...`. The API derives the organization, the branch and the
   acting role from the credential; device routes have no `:orgId` and never take a branch id. The acting role's
   permissions (the same matrix as staff, `ROLE_PERMISSIONS`) decide what the device may do; `GET /v1/pos/session`
   lists them.
4. A device credential works **only** on the device routes below (`403 pos_device_only` elsewhere), and the device
   routes accept **only** device credentials (`403 pos_device_required` for a staff token).
5. Refusals: `401 device_revoked` (a manager unpaired it), `401 device_expired`, `401 unauthorized` (unknown token,
   restaurant suspended or closed, branch deactivated). On `device_revoked` / `device_expired` delete the credential
   and show the pairing screen.
6. `last_seen_at` is updated at most once a minute. Pairing, pairing codes, revocation and every device action are in
   the audit log (actor type `device`, actor id = device id). Rate limit: 600 requests per minute per device.

## Routes

| Route | Purpose | Permission (acting role) | Status | Since | Tests (`apps/api/test/pos-flow.test.ts`) |
|---|---|---|---|---|---|
| `POST /v1/o/:orgId/pos/pairings` | Staff: create a one-time pairing code | `devices:manage` | draft | 0.1.0 | pairing and device credentials; isolation and revocation |
| `GET /v1/o/:orgId/pos/devices` | Staff: list devices (limit/cursor, `status`, `branchId`) | `devices:manage` | draft | 0.1.0 | pairs a device…; a device of branch A cannot… |
| `GET /v1/o/:orgId/pos/devices/:id` | Staff: one device | `devices:manage` | draft | 0.1.0 | a device of branch A cannot… |
| `POST /v1/o/:orgId/pos/devices/:id/revoke` | Staff: unpair (immediate) | `devices:manage` | draft | 0.1.0 | refuses a revoked or expired device… |
| `POST /v1/pos/pair` | Device: exchange the code for the credential | public | draft | 0.1.0 | pairs a device…; refuses expired, unknown and malformed pairing codes |
| `GET /v1/pos/session` | Device, org, branch, permissions, feed position, server time | any | draft | 0.1.0 | pairs a device…; refuses a revoked… |
| `GET /v1/pos/events` | Ordered branch event feed (`after`, `epoch`, `wait`) | `orders:read` | draft | 0.1.0 | the kitchen changes the ticket…; a long-poll returns…; reconnect, gaps and resync |
| `GET /v1/pos/sync/menu` | Branch menu snapshot (`since`) | `menu:read` | draft | 0.1.0 | the device syncs menu…; a price changed while offline… |
| `GET /v1/pos/sync/floor` | Floor: layout, tables, open visits and bills (`since`) | `floor:read` | draft | 0.1.0 | the device syncs menu…; enforces the acting role |
| `GET /v1/pos/sync/orders` | Open orders (full) or orders changed since a cursor (delta) | `orders:read` | draft | 0.1.0 | the kitchen changes the ticket…; answers resync_required… |
| `POST /v1/pos/orders/quote` | Server pricing of a cart (creates nothing) | `orders:write` | draft | 0.1.0 | the device syncs menu… |
| `POST /v1/pos/orders` | Submit an order (idempotent by `clientOrderId`) | `orders:write` | draft | 0.1.0 | the device syncs menu…; offline replay and conflicts |
| `GET /v1/pos/orders/:id` | One order of the branch | `orders:read` | draft | 0.1.0 | payments are captured…; isolation |
| `POST /v1/pos/orders/:id/transition` | Status change with `version` (required) | `orders:status` | draft | 0.1.0 | concurrent status changes…; payments are captured… |
| `POST /v1/pos/orders/:id/payments` | Record cash / card terminal / InstaPay (idempotent by `clientPaymentId`) | `payments:collect` | draft | 0.1.0 | payments are captured… |
| `POST /v1/pos/orders/:id/receipt` | Create a receipt print job (idempotent by `clientRequestId`) | `orders:read` | draft | 0.1.0 | payments are captured… |
| `GET /v1/pos/kitchen/routing` | Station → products | `menu:read` | draft | 0.1.0 | the web orders list, the overview and the KDS show it |
| `GET /v1/pos/kitchen/tickets` | KDS tickets of the branch (`station`, `since`) | `kitchen:operate` | draft | 0.1.0 | the web orders list…; the kitchen changes the ticket… |
| `POST /v1/pos/kitchen/orders/:id/bump` | Order-level bump with `version` (required) | `kitchen:operate` + `orders:status` | draft | 0.1.0 | the kitchen changes the ticket…; concurrent status changes… |
| `POST /v1/pos/kitchen/lines/:lineId` | Line status (queued / preparing / ready, recall) | `kitchen:operate` | draft | 0.1.0 | the kitchen changes the ticket… |
| `GET /v1/pos/print-jobs` | Print jobs of the branch (limit/cursor, `status`, `kind`, `station`), oldest first | `orders:read` | draft | 0.1.0 | a kitchen ticket print job is created… |
| `GET /v1/pos/print-jobs/:id` | One job with its document | `orders:read` | draft | 0.1.0 | isolation |
| `POST /v1/pos/print-jobs/:id/claim` | Take a job to print (returns the document) | `orders:read` | draft | 0.1.0 | a kitchen ticket print job is created… |
| `POST /v1/pos/print-jobs/:id/complete` | `printed` or `failed` (+ `error`) | `orders:read` | draft | 0.1.0 | a kitchen ticket print job is created… |

Acting roles: `waiter` and `cashier` take orders, change status, take payments and read the floor; `kitchen` reads
the menu and orders, runs the KDS and bumps tickets, but cannot submit orders or read the floor. Cancelling an order
needs `orders:cancel`, which no device role has: cancellations stay on the staff web app for now (see open questions).

## Events (`GET /v1/pos/events`)

Each event: `{ seq, kind, entityType, entityId, payload, at }`. Unknown kinds may appear in later versions: ignore them.

| Kind | Entity | Written when | Payload | Status | Since |
|---|---|---|---|---|---|
| `order.created` | order | an order of the branch is placed, from any channel | `orderId, number, status, paymentStatus, version, fulfillment, channel, tableId, visitId, totalMinor, dueMinor` | draft | 0.1.0 |
| `order.updated` | order | anything on the order's timeline (status, lines, payment applied, hand-off) | as `order.created` (latest state) | draft | 0.1.0 |
| `ticket.status_changed` | order | order status change, line status change or recall, delivery hand-off | `orderId, number, scope (order/line), change, from, to, lineId, station, orderStatus, version` | draft | 0.1.0 |
| `payment.captured` | payment | a payment succeeded (device, staff, guest QR, payment link, provider webhook) | `paymentId, method, provider, amountMinor, isTest, orderId, visitId, orderIds` | draft | 0.1.0 |
| `payment.refunded` | payment | a refund was recorded | as `payment.captured` (`amountMinor` = refunded amount) | draft | 0.1.0 |
| `menu.changed` | menu | anything any menu shows changed (`menu_versions` bump) | `menuVersion` | draft | 0.1.0 |
| `availability.changed` | product | offered at the branch, sold out (86), price override, or tracked stock reaching zero changed | `productId, offered, soldOut, soldOutUntil, stockQty, priceOverrideMinor` | draft | 0.1.0 |
| `table.changed` | table | table status / label / capacity / zone / archive, visit opened or closed | `tableId, label, status, active, visitId` | draft | 0.1.0 |
| `print_job.created` | print_job | a kitchen ticket (per station) or a receipt job was created | `printJobId, kind, orderId, station` | draft | 0.1.0 |

Source: database triggers write the feed in the same transaction as the change, from the existing domain records —
the order timeline (`order_events`), the transactional outbox (`outbox_events`), `menu_versions`,
`product_branch_settings`, `dining_tables` and `pos_print_jobs`
(`supabase/migrations/20261024210001_pos_devices_feed.sql`). Orders from every channel (QR, web, WhatsApp, staff,
other devices) appear, not only the device's own.

## Sync and replay rules

- **Sequence numbers** are per branch, start at 1, increase by exactly 1 and become visible in order (the head row is
  locked until the writing transaction commits). Delivery is **at least once**: re-reading from an older `after`
  returns the same events with the same `seq`. Dedupe by `seq`; apply events in `seq` order.
- `GET /v1/pos/events?after=<last seq>&epoch=<epoch>` returns up to 200 events with `seq > after`, plus `head`,
  `epoch`, `nextAfter` and `hasMore`. Send `nextAfter` as the next `after`. With `wait=1..25` the call long-polls: it
  answers as soon as an event exists, or with an empty page after `wait` seconds. Store `epoch` with your cursor.
- `order.updated`, `menu.changed`, `availability.changed` and `table.changed` are merged per entity and transaction,
  so one change that touches an order several times yields one event with the final state.
- **Resync**: `409 resync_required` with `details: { reason, epoch, head, oldest }` when the cursor cannot be
  resumed: `cursor_expired` (older than the 7-day retention, `after < oldest`), `cursor_ahead` (`after > head`: the
  device talks to a restored or different database), `epoch_mismatch`, or `gap` (a hole in the sequence; never
  expected, but never skipped silently). Then: drop local state, call `GET /v1/pos/sync/menu`, `/sync/floor` and
  `/sync/orders` without cursors, and follow the feed from `head` with the new `epoch`. A gap the client itself
  detects (an event `seq` other than last + 1) is handled the same way: re-read from the last applied seq, and resync
  if the server confirms the gap.
- **Menu** (`/sync/menu?since=<cursor>`): a snapshot of the branch menu (categories, products with current branch
  price, availability and tracked stock, station, modifier groups and options with availability). The cursor is the
  organization's menu version plus the image-URL window (image URLs are signed for about a day): when nothing changed
  the answer is `{ cursor, unchanged: true }` and no body. Refetch on `menu.changed` / `availability.changed`, or at
  least daily. This is a snapshot, not per-entity deltas.
- **Floor** (`/sync/floor?since=<cursor>`): layout geometry and live tables (status, open visit, bill, next
  reservation); the cursor is a digest of the answer. Refetch on `table.changed`.
- **Orders** (`/sync/orders`): without a cursor, the open orders of the branch (kitchen statuses, orders of open
  visits, fulfilled but unpaid orders of the last 24 hours; at most 300, `truncated: true` beyond) and a cursor at
  the current feed head. With `cursor`, every order that had a feed event since (`mode: delta`, at most 200 per
  answer, `hasMore`), in its current state; `open: false` means drop it from the open list. A delta cursor is a feed
  position, so it expires with the feed (resync_required).

## Order submission and conflict rules

- **Client UUIDs.** `clientOrderId` is generated when the order is taken and reused for every retry (offline queue).
  The first successful submit stores its response; a retry with the same id and the same body returns that response
  again with the same status (201) and the header `Idempotent-Replayed: true` — no second order. The same id with a
  different body: `409 client_order_id_reused`. Concurrent duplicates wait for the first and return its order.
  Payments use `clientPaymentId` (a retry returns the first payment, a different amount/method is
  `409 idempotency_key_reused`), receipts `clientRequestId`.
- **Prices are server-authoritative.** Send what the device showed: `lines[].expectedLineTotalMinor`
  ((unit + modifier deltas) × quantity) and `expectedTotalMinor`. With `repricing: "reject"` (default) any difference is
  `409 pos_price_changed` with `details: { currency, lines: [{ index, productId, expectedLineTotalMinor,
  currentLineTotalMinor, currentUnitPriceMinor, currentModifiersTotalMinor }], expectedTotalMinor, currentTotalMinor,
  menuCursor }` and nothing is created (the same `clientOrderId` may be resubmitted). With `repricing: "accept"` the
  order is placed at current prices and `repriced` lists what changed. `POST /v1/pos/orders/quote` gives the current
  totals (tax, service charge) before submitting.
- **Availability is server-authoritative.** Items not on the menu, not offered at the branch, sold out (86) or out of
  tracked stock: `409 pos_items_unavailable` with every affected line: `details: { items: [{ index, productId,
  reason: not_on_menu | not_offered | sold_out | out_of_stock, availableQty }], menuCursor }`. Unavailable modifier
  options: `422 invalid_modifiers`. Other kernel refusals keep their codes (`branch_unavailable`,
  `fulfillment_unavailable`, `table_occupied`, `visit_closed`, …).
- **Optimistic concurrency.** Device status changes (`/orders/:id/transition`, `/kitchen/orders/:id/bump`) require
  the `version` the device saw; a stale one is `409 stale_order` with `details.version` = current version. Refetch
  the order and decide again. Line status changes (`/kitchen/lines/:lineId`) carry no version: they are idempotent and
  never move an order backwards.
- **Scope.** Ids of another branch or restaurant (orders, lines, tables, visits, print jobs) answer `404`, never 403.

## Kitchen routing and printing

- Each product has a kitchen **station** (`station` in the menu sync; `GET /v1/pos/kitchen/routing` maps stations to
  products). Order lines keep the station they were ordered with.
- When the kitchen may start an order (placed, or a prepaid order once paid) the API creates one `kitchen_ticket`
  print job per station and announces it (`print_job.created`). Receipts are created on request
  (`POST /v1/pos/orders/:id/receipt`).
- A device prints a job by **claiming** it (`POST /print-jobs/:id/claim`, which returns the document), then
  completes it as `printed` or `failed`. Another device may take over a claim older than 60 seconds or a failed job;
  a printed job cannot be claimed again (`409 print_job_completed`), a fresh claim of another device is
  `409 print_job_claimed`.
- Documents are structured JSON, never printer bytes: `kitchen_ticket` (`station`, `order` {number, fulfillment,
  tableLabel, customerName, notes, placedAt, …}, `lines` [{name, nameAr, quantity, modifiers, notes, kitchenStatus}])
  and `receipt` (`org`, `branch`, `order`, `lines` with prices, `totals`, `payments`, `currency`). The app renders them
  for ESC/POS over TCP 9100, Epson ePOS or Star StarPRNT (plan §10).

## Breaking-change policy

- Changes on `/v1` are **additive only**: new routes, new optional request fields, new response fields, new event
  kinds and new error codes. Clients ignore unknown fields and event kinds.
- A breaking change ships as a **new route** (or a new event kind) next to the old one; the old one answers with a
  `Deprecation` header (and `Sunset` when a date is set), is marked here and in `docs/api/CHANGELOG.md`, and stays
  until the iPad app no longer uses it.
- Error `code`s are stable (registry: `packages/contracts/src/error-codes.ts`); branch on `code`, never on `message`.
- `docs/api/openapi.json` is regenerated and committed with every route change (drift test in
  `apps/api/test/openapi.test.ts`); this checklist is checked against the router by `apps/api/test/pos-flow.test.ts`.
- CI compares a pull request's `docs/api/openapi.json` with the base branch's (`scripts/openapi/additive.mjs`): a
  removed operation (unless already deprecated), a changed success status, a removed parameter or body property, or a
  newly required one fails the build.

## Open questions for the iPad team

1. **Cancellation and voids.** No device role has `orders:cancel`. Should a device acting as `cashier` cancel unpaid
   orders (and void lines), or do cancellations stay on the web app?
2. **Bill splitting and table-side payment.** Payments are per order today (`/orders/:id/payments`). Do you need
   visit-level payment and splits (the guest bill-split API exists for QR guests) on the device?
3. **Card terminals.** A card payment is recorded as `method: card` with an optional `reference`; no terminal
   integration (SoftPOS / Geidea / Paymob terminal) exists. Which terminals must be supported first?
4. **Menu deltas.** The menu sync is a snapshot per change. Is that small enough for your largest menus, or do you
   need per-entity deltas?
5. **Printing.** Should receipts be created automatically when an order is paid or a visit closes? Which device
   should print kitchen tickets for a station (any device that sees the event, or devices bound to stations)?
6. **Offline window.** How long may an order stay in the offline queue? Client order ids are kept forever, but the
   feed is kept 7 days: after a longer outage the device resyncs.
7. **Credential rotation.** Credentials last up to 365 days (configurable at pairing). Do you want a rotate endpoint
   (new credential while the old one is still valid), or is re-pairing enough?
8. **Push.** The feed is long-poll. Do you need a push channel (APNs silent push or WebSocket) for background wake-up?
9. **Staff identity on a shared device.** Actions are attributed to the device. Do you need per-waiter PINs on the
   device so actions are attributed to a staff member?
