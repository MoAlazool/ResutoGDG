# iPad POS — integration and migration path

**Audience:** the native iPad POS track (Codex, `feature/ipad-pos`, draft PR #3) and the Resuto API track
(`claude/relaxed-mayer-omkl3f`).

**Purpose:** this document reconciles the two designs that exist today:

- **A — what the app does now** (PR #3, `apps/ipad-pos/API_DEPENDENCIES.md`):
  - signs staff in through Supabase Auth (`/auth/v1/token` with `grant_type=password` and `grant_type=refresh_token`);
  - calls the staff routes `/v1/o/{orgId}/*` with `Authorization: Bearer <Supabase JWT>`, which are the same routes, guard and checks as the web app;
  - polls with ETags;
  - creates orders on `POST /v1/o/{orgId}/orders` (channel `staff`) with an `Idempotency-Key`.
- **B — the device API built for the app** (21-POSAPI, `docs/api/IPAD_COMPATIBILITY.md`):
  - a paired device credential (`rpos_…`) bound to one branch and one acting role;
  - routes under `/v1/pos/*`;
  - an ordered per-branch event feed;
  - server-checked price consent;
  - `clientOrderId` idempotency with no expiry;
  - kitchen routing and print jobs.

Neither design replaces the other. The target is **staff sign-in on a paired device**: the device credential
supplements the staff login (the request in `API_DEPENDENCIES.md` §P0 "device authorization"). It never replaces
the employee's permissions.

## Status

| Part | Where | Status |
|---|---|---|
| Staff routes `/v1/o/*` used by PR #3 | `main` behaviour, unchanged on this branch | Existing, covered by the API suites. Not changed by this track. |
| Device API 0.1.0 (`/v1/pos/*`, device credential only) | this branch, `b15bd20` | **Draft.** Contract and API tests pass, including a scripted-iPad cross-platform test. **Not staging-verified, not verified with the real app.** |
| Device API 0.2.0 (staff on device, `requireStaff`, `by-client-id`) | this branch, merge `f8590ce` | **Draft, implemented.** Additive over 0.1.0. Covered by `apps/api/test/pos-staff.test.ts` and the auth unit test (`apps/api/src/common/auth/context.test.ts`). **Not staging-verified; not verified with the real app.** |

**Exact names (0.2.0):**
- header `X-Resuto-Staff-Authorization` (`POS_STAFF_HEADER`);
- OpenAPI security `[{posDeviceAuth}, {posDeviceAuth, posStaffAuth}]` on every device route except pairing;
- error codes `pos_staff_not_allowed` (403) and `pos_staff_required` (401);
- response types `PosSession.requireStaff`, `PosSession.staff` (`PosSessionStaff`), `PosDeviceSummary.requireStaff` and `PosOrderByClientId`;
- pairing request field `requireStaff?: boolean`.

**Staging rule:** nothing here counts as staging-verified until the real iPad build has run the end-to-end flow
(`docs/api/IPAD_COMPATIBILITY.md` → "stable") against staging and the result is recorded.

## 1. Authentication model (target)

The app keeps **two credentials**, both in the Keychain:

| Credential | How it is obtained | Sent as | Used on |
|---|---|---|---|
| Staff session (Supabase access + refresh token) | Unchanged: `AuthService.signIn` / `token()` in `Networking.swift` | `Authorization: Bearer <JWT>` | `/v1/me`, `/v1/o/{orgId}/*` (unchanged) |
| Device credential `rpos_<43 url-safe chars>` | Once, by pairing (§2) | `Authorization: Bearer rpos_…` | `/v1/pos/*` only |
| Staff session on a device request (0.2.0) | The same staff JWT | `X-Resuto-Staff-Authorization: Bearer <JWT>` alongside the device credential | `/v1/pos/*` |

**Rules the API enforces.** All of them are implemented in contract 0.2.0.

1. **Device credential scope.** A device credential is accepted **only** on `/v1/pos/*`. Elsewhere it answers `403 pos_device_only`.
2. **Device routes and staff tokens.** A staff JWT in `Authorization` on `/v1/pos/*` answers `403 pos_device_required`. This is unchanged in 0.2.0: the staff JWT goes in `X-Resuto-Staff-Authorization`.
3. **Device-only requests (0.1.0).** Without the staff header, the device acts as its paired role (`waiter`, `cashier` or `kitchen`). Actions are attributed to the device (`actor_type = device`).
4. **Staff on device (0.2.0).** With the staff header:
   - **Membership:** the staff member must have an active membership in the device's restaurant whose branch scope includes the device's branch.
   - **Effective permissions:** the staff member's role permissions **intersected with** the device's acting role. A manager signed in on a `kitchen` device can still only do kitchen work; a waiter on a `cashier` device can only do what a waiter may do.
   - **Attribution:** actions are attributed to the staff member, with the device id recorded.
   - **Refusals:**
     - `401 unauthorized` for a missing, invalid or expired JWT;
     - `403 pos_staff_not_allowed` for a valid user without such a membership. It never reveals other tenants.
     - The header must be exactly `Bearer <access token>`. A device credential or MCP key in this header is `401 unauthorized`.
   - **Order of checks:** the device credential first (`device_revoked`, `device_expired`, `unauthorized` win), then the per-device rate limit, then the staff session, then the route permission.
   - **What keeps the device id:** `pos_order_submissions.device_id`, print-job claims (`claimedBy`), receipt requests and the session. The audit log carries `metadata.deviceId`.
5. **`requireStaff` devices (0.2.0).** A device paired with `requireStaff: true` refuses every `/v1/pos/*` route except `GET /v1/pos/session` without the staff header, with `401 pos_staff_required`. Use this for shared waiter iPads, so every action has a person behind it. `GET /v1/pos/session` reports `requireStaff` and, when the header is present, the staff member and the effective permissions. `requireStaff` is fixed at pairing; to change it, pair the device again.
6. **Device refusals.**
   - `401 device_revoked` or `401 device_expired`: delete the device credential and show the pairing screen. Keep the staff session.
   - `401 unauthorized` on the device credential: the restaurant was closed or suspended, or the branch was deactivated.
7. **Rate limit.** 600 requests per minute per device, counted per device whoever is signed in.
8. **Refresh and retry.** A refreshed staff JWT is used for the next request. The existing rule in `APIClient` stays: only GETs are retried automatically after a refresh. Mutations keep their own durable identity (`clientOrderId`, `clientPaymentId`, `clientRequestId`).

**What does not change:** `/v1/me`, `/v1/o/{orgId}`, the branch filtering, and every staff route PR #3 calls today
(`scripts/check_contracts.py` list). Membership, permission, entitlement and branch checks on those routes are the
same as for the web app.

## 2. Pairing (device enrolment)

1. **Code.** A manager creates a code on the web dashboard, or with `POST /v1/o/{orgId}/pos/pairings` using a staff JWT with the `devices:manage` permission. A branch-scoped manager can do this only for their own branches.
   - Body: `{ branchId: uuid, actingRole: "waiter"|"cashier"|"kitchen", name: string(1..60), expiresInMinutes?: 1..60 = 10, deviceTtlDays?: 1..730 = 365, requireStaff?: boolean = false }`. `requireStaff` is 0.2.0.
   - Response: `{ id, branchId, actingRole, name, code: "XXXXX-XXXXX", expiresAt }`. The code is 10 Crockford base32 characters, single use.
2. **Exchange.** The app sends `POST /v1/pos/pair`, which is public. Case and dashes are ignored, and there are 30 attempts per IP per 10 minutes.
   - Body: `{ code: string(10..20), platform?: "ipados"|"ios"|"other" = "ipados", appVersion?: string(≤40), model?: string(≤60) }`.
   - Response (once): `{ token: "rpos_…", device: PosDeviceSummary, orgId, contractVersion }`.
   - Store `token` in the Keychain under the environment scope (as `Scope.environment` is used today). Never log it.
3. **Revocation** is immediate (`POST /v1/o/{orgId}/pos/devices/{id}/revoke`).

**Two-step flow in the app.** Staff signs in as today, picks restaurant and branch, and then, when the device has no
credential, the app shows "Pair this iPad" (code entry or QR scan of the code). A manager can pair on the spot from
the web app. The app's existing "enrollment unavailable" label can be replaced by this flow: 0.2.0 is on the branch (draft).

**Codex's proposed `POST /pos/devices/enroll` (public key, App Attest): not built.** Pairing codes plus a hashed
bearer credential are the 0.1.0 design. App Attest and key-bound credentials can be added as optional fields later
without breaking 0.1.0 (open question 10).

## 3. What moves to `/v1/pos/*` and what stays on `/v1/o/*`

| App capability (PR #3) | Today (A) | Target | Why |
|---|---|---|---|
| Sign-in, restaurant and branch selection | `/v1/me`, `/v1/o/{orgId}` | **Stays** | Staff identity is Supabase; `/me` defines memberships |
| Menu for ordering | `GET /v1/o/{orgId}/menu` + local filtering by branch | **`GET /v1/pos/sync/menu?since=`** | Branch-resolved prices, availability, stock and stations in one snapshot, with `unchanged: true` when nothing changed |
| Floor layout and live tables | `floor/{branchId}`, `floor/{branchId}/live` | **`GET /v1/pos/sync/floor?since=`** + `table.changed` events | One cursor; refresh driven by events |
| Order creation | `POST /v1/o/{orgId}/orders` (channel `staff`, `Idempotency-Key` kept 7 days) | **`POST /v1/pos/orders`** (channel `pos`) | `clientOrderId` has no expiry; `expectedTotalMinor` price consent; structured conflicts. Answers P0 "atomic quote" and P0 "durable reconciliation" in `API_DEPENDENCIES.md` |
| Active orders, kitchen status | Polling `orders`, `kitchen/{branchId}` every 5 s with ETags | **`GET /v1/pos/events?after=&epoch=&wait=25`** + `GET /v1/pos/sync/orders?cursor=` | Ordered feed with gap and resync detection. Answers P1 "event stream" (long-poll; no SSE or WebSocket yet) |
| Status changes | `orders/{id}/transition` | **`POST /v1/pos/orders/{id}/transition`** (`version` required) | Same kernel and rules; stale version is `409 stale_order` |
| Kitchen line status, bump | `kitchen/{branchId}`… | **`/v1/pos/kitchen/lines/{lineId}`**, **`/v1/pos/kitchen/orders/{id}/bump`** | Same kernel |
| Cash and card collection | `POST orders/{id}/collect` | **`POST /v1/pos/orders/{id}/payments`** (`clientPaymentId`) | Idempotent retries without a new key |
| Receipt printing | Local projection + AirPrint / ESC/POS queue | **`POST /v1/pos/orders/{id}/receipt`** + print-job claim/complete | Shared queue: one device prints each job; a stale claim can be taken over after 60 s |
| Cancel order | `orders/{id}/cancel` | **Stays on `/v1/o/*`** with the staff JWT | No device role has `orders:cancel` (open question 1) |
| Refund requests | `payments/{paymentId}/refunds` | **Stays on `/v1/o/*`** | ResutoPay entitlement and refund rules stay where they are |
| Visits close, table clean, reservations, customer lookup, delivery address | `/v1/o/*` | **Stays on `/v1/o/*`** | Not in the device API |

**During and after the migration, both route families keep working.** An order created on either route appears in
the feed and in web Orders, the dashboard, KDS, inventory and analytics. Both go through the same order kernel and
outbox. Payments recorded either way reach the same ledger.

## 4. Exact schemas (contract 0.1.0, `packages/contracts/src/pos.ts`)

**Conventions:**
- Amounts are integers in minor units.
- Ids are UUIDs.
- Times are ISO 8601 UTC.
- Ignore unknown fields and unknown event kinds.
- Errors use one envelope: `{ "error": { "code", "message", "details"?, "requestId" } }`. Branch on `code`, never on `message`. The registry is `packages/contracts/src/error-codes.ts`.

**Session.** `GET /v1/pos/session` returns `PosSession`:

```json
{
  "device": { "id", "branchId", "name", "actingRole", "tokenPrefix", "status", "expired", "platform", "appVersion", "model",
              "pairedAt", "expiresAt", "lastSeenAt", "revokedAt", "revokeReason" },
  "org": { "id", "name", "nameAr", "currency", "country", "timezone" },
  "branch": { "id", "code", "name", "nameAr", "timezone", "serviceMode", "acceptsDineIn", "acceptsPickup", "acceptsDelivery" },
  "permissions": ["orders:read", "..."],
  "feed": { "epoch": "uuid", "head": 0, "oldest": 0 },
  "serverTime": "…",
  "contractVersion": "0.1.0"
}
```

0.2.0 adds `requireStaff: boolean` (top level and in `device`) and `staff: { id, email | null, role } | null`. With a
staff session, `permissions` holds the effective (intersected) permissions.

**Menu.** `GET /v1/pos/sync/menu?since=<cursor>` returns:
- when nothing changed: `{ cursor, unchanged: true }`;
- otherwise: `{ cursor, unchanged: false, currency, stations: string[], categories: [{ id, name, nameAr, products: PosMenuProduct[] }] }`.

`PosMenuProduct`:

```text
id, categoryId, name, nameAr, description, descriptionAr
priceMinor                       (branch price, override applied)
available, unavailableReason     (sold_out | out_of_stock | null)
stockQty                         (null = not tracked)
station, prepMinutes, spiceLevel, allergens[], dietary[], imageUrl   (signed, about one day)
modifierGroups: [{ id, name, nameAr, minSelect, maxSelect,
                   options: [{ id, name, nameAr, priceDeltaMinor, available }] }]
```

**Quote.** `POST /v1/pos/orders/quote` takes `{ fulfillment: "dine_in"|"pickup"|"delivery", lines: CartLine[1..60] }` and
returns `PosQuote`:

```text
{ currency,
  lines: [{ index, productId, unitPriceMinor, modifiersTotalMinor, lineTotalMinor }],
  subtotalMinor, discountMinor, serviceChargeMinor, deliveryFeeMinor, taxMinor, taxInclusive, totalMinor,
  menuCursor }
```

`CartLine` = `{ productId: uuid, quantity: 1..99, modifiers: [{ groupId, optionId }] (≤40, default []), notes?: string(≤200) }`.
This is the same shape as `CartLine` in `Contracts.swift`.

**Submit.** `POST /v1/pos/orders` takes:

```text
{ clientOrderId: uuid,
  fulfillment,
  tableId?: uuid|null, visitId?: uuid|null, guests?: 1..100,
  lines: [CartLine & { expectedLineTotalMinor?: int }] (1..60),
  expectedTotalMinor?: int,
  repricing?: "reject" (default) | "accept",
  customer?: { name?, phone? (E.164) } | null,
  notes?: string(≤500),
  takenAt?: ISO }
```

It returns **201** `PosOrderSubmitted` = `{ clientOrderId, order: PosOrder, repriced: null | { lines, expectedTotalMinor, totalMinor } }`.

- **Replay:** the same `clientOrderId` with the same body returns the stored 201 again with `Idempotent-Replayed: true`. The same id with a different body is `409 client_order_id_reused`.
- **Conflicts:**
  - `409 pos_price_changed`: `details = { currency, lines: [{ index, productId, expectedLineTotalMinor, currentLineTotalMinor, currentUnitPriceMinor, currentModifiersTotalMinor }], expectedTotalMinor, currentTotalMinor, menuCursor }`;
  - `409 pos_items_unavailable`: `details = { items: [{ index, productId, reason: not_on_menu|not_offered|sold_out|out_of_stock, availableQty }], menuCursor }`;
  - `422 invalid_modifiers`.
  - In all three cases nothing is created: no order, stock decrement, kitchen ticket or payment. Resubmit the same `clientOrderId` after the staff member reviews.

**Reconcile (0.2.0).** `GET /v1/pos/orders/by-client-id/{clientOrderId}` (`orders:read`) returns `PosOrderByClientId`:
- `{ state: "accepted", orderId, number, response: PosOrderSubmitted }`;
- `{ state: "processing" }` while a submit with that id is still running (ask again in about a second);
- `404 not_found` when the order was never accepted, or was submitted at another branch or restaurant. Resubmitting the same id is safe: it is idempotent with no expiry, and no maintenance job deletes `pos_order_submissions`.

**`PosOrder`:**

```text
id, clientOrderId, number, branchId, channel, fulfillment, status, paymentStatus
tableId, tableLabel, visitId, customerName, currency
subtotalMinor, discountMinor, serviceChargeMinor, deliveryFeeMinor, taxMinor, taxInclusive
totalMinor, paidMinor, refundedMinor, dueMinor
notes, placedAt, updatedAt, version, open
lines: [{ id, productId, name, nameAr, quantity, unitPriceMinor, modifiers, modifiersTotalMinor,
          lineTotalMinor, station, kitchenStatus, notes }]
```

**Status changes and kitchen:**

| Route | Body | Notes |
|---|---|---|
| `POST /v1/pos/orders/{id}/transition` | `{ to, version }` | `to` is any order status except `cancelled` and `awaiting_payment` |
| `POST /v1/pos/kitchen/orders/{id}/bump` | `{ to: accepted\|preparing\|ready\|served\|picked_up\|delivered, version }` | |
| `POST /v1/pos/kitchen/lines/{lineId}` | `{ status: queued\|preparing\|ready }` | Idempotent; never moves the order backwards |

A stale `version` is `409 stale_order` with `details.version`.

**Payments.** `POST /v1/pos/orders/{id}/payments` takes
`{ clientPaymentId: uuid, method?: cash|card|instapay|cod = cash, amountMinor?: int (default: all due), reference?: string(≤120) }`.

**Receipts and print jobs:**

| Route | Body or query | Notes |
|---|---|---|
| `POST /v1/pos/orders/{id}/receipt` | `{ clientRequestId: uuid }` | Idempotent by `clientRequestId` |
| `GET /v1/pos/print-jobs` | `?status=&kind=&station=&limit=&cursor=` | Oldest first |
| `POST /v1/pos/print-jobs/{id}/claim` | — | Returns the job with its `document` |
| `POST /v1/pos/print-jobs/{id}/complete` | `{ status: printed\|failed, error? }` | |

**Orders sync.** `GET /v1/pos/sync/orders?cursor=` returns `{ cursor, mode: full|delta, orders: PosOrder[], hasMore, truncated? }`.

## 5. Event format (`GET /v1/pos/events`)

**Request:** `?after=<last applied seq>&epoch=<uuid>&wait=0..25`.

**Response:** `{ epoch, head, events: [PosEvent], nextAfter, hasMore, serverTime }`.

**`PosEvent`:** `{ seq: int (per branch, +1, no gaps), kind, entityType, entityId, payload, at }`.

| `kind` | `entityType` | `payload` |
|---|---|---|
| `order.created`, `order.updated` | order | `orderId, number, status, paymentStatus, version, fulfillment, channel, tableId, visitId, totalMinor, dueMinor` |
| `ticket.status_changed` | order | `orderId, number, scope (order\|line), change, from, to, lineId, station, orderStatus, version` |
| `payment.captured`, `payment.refunded` | payment | `paymentId, method, provider, amountMinor, isTest, orderId, visitId, orderIds` |
| `menu.changed` | menu | `menuVersion` |
| `availability.changed` | product | `productId, offered, soldOut, soldOutUntil, stockQty, priceOverrideMinor` |
| `table.changed` | table | `tableId, label, status, active, visitId` |
| `print_job.created` | print_job | `printJobId, kind, orderId, station` |

**Delivery:**
- At least once. Dedupe by `seq` and apply in `seq` order.
- Events from every channel appear: QR, web, WhatsApp, staff routes, and other devices.
- Payloads carry identifiers and states, not customer contact data. Customer names appear only in order reads.

**Resync:** `409 resync_required` with `details = { reason: cursor_expired|cursor_ahead|epoch_mismatch|gap, epoch, head, oldest }`.
When it arrives:
1. Drop the cached projections (keep unsent `PendingOrder`s).
2. Run `/sync/menu`, `/sync/floor` and `/sync/orders` with no cursor.
3. Follow the feed from `head` with the new `epoch`.

Feed retention is 7 days.

## 6. Required client adaptations (PR #3 → target)

1. **`Networking.swift`:**
   - add a `DeviceCredentialStore`, Keychain-backed and scoped like the session;
   - add a `POSClient` that sends `Authorization: Bearer rpos_…` and, from 0.2.0, `X-Resuto-Staff-Authorization: Bearer <AuthService.token()>`.
   - Keep `APIClient` for `/v1/me` and `/v1/o/*`.
   - On `device_revoked` / `device_expired`, clear only the device credential.
   - On `pos_staff_required` / `pos_staff_not_allowed`, sign the staff member in again or show "not allowed on this iPad".
2. **Pairing UI** (Settings): code entry, `POST /v1/pos/pair`, store the token, then show `GET /v1/pos/session` (branch, acting role, effective permissions). The branch of a paired device is fixed: the app's branch picker must match `session.branch.id`, or ask to re-pair.
3. **`Synchronization.swift`:**
   - `RemoteOrderSubmitter` posts `posOrderSubmit` to `/v1/pos/orders`, with `clientOrderId = PendingOrder.id` (already durable and immutable).
   - The 6-day `retry_window_expired` stop is no longer needed for `/v1/pos/orders`, because `clientOrderId` has no expiry. Keep it for any order still sent to `/v1/o/*/orders`.
   - After an ambiguous result, call `GET /v1/pos/orders/by-client-id/{id}` (0.2.0) before showing "attention".
4. **Price consent:**
   - before approving a queued order, call `POST /v1/pos/orders/quote` and show the server totals;
   - send `expectedLineTotalMinor` per line and `expectedTotalMinor` with `repricing: "reject"`;
   - on `409 pos_price_changed` / `pos_items_unavailable`, show the per-line differences and resubmit the same `clientOrderId` only after the staff member confirms.
   - Never send tax arithmetic: the server computes tax.
5. **Live updates:** replace the 5-second polling of `orders` and `kitchen/{branchId}` with one long-poll loop on `/v1/pos/events` (`wait=25`). Refetch `/sync/menu` on `menu.changed` and `availability.changed`, `/sync/floor` on `table.changed`, and `/sync/orders?cursor=` on order events. Persist `(epoch, lastSeq)` with the scope.
6. **Contracts (Swift DTOs):** add `PosSession`, `PosMenuSync`, `PosMenuProduct`, `PosQuote`, `PosOrderSubmitted`, `PosOrder`, `PosEventPage`, `PosEvent`, `PosResyncDetails`, `PosPriceConflictDetails`, `PosUnavailableDetails` and `PosPrintJob`, matching §4–§5. Extend `scripts/check_contracts.py` to the `/v1/pos/*` operations in `docs/api/openapi.json`. The response bodies are TypeScript interfaces in `pos.ts`; OpenAPI does not describe them yet (Codex P2).
7. **Printing:** optionally keep the local queue for AirPrint. For shared kitchen printers, use print jobs: claim → print → complete. Do not reprint a `printed` job automatically.
8. **Staff switch:** on a `requireStaff` device, sign-out and sign-in changes only the staff session. The device credential stays.

## 7. Migration path

| Step | App | API | Exit criterion |
|---|---|---|---|
| 0 (now) | PR #3 on staff routes only | Unchanged | Existing behaviour |
| 1 | Pairing UI + `POSClient`; read `session`, `sync/menu`, `events` in parallel with the current polling (shadow mode, compare, no writes) | 0.2.0 deployed to staging (it is on the branch; staging still runs an older build) | Feed and sync match the staff reads on staging for a full service day |
| 2 | Orders via `/v1/pos/orders` + quote + reconcile; payments via `/pos/orders/{id}/payments` | — | Cross-platform flow passes on staging with the real app (§8) |
| 3 | Kitchen and print jobs on `/v1/pos/kitchen/*` and print jobs; drop the polling | — | KDS and printing acceptance on hardware |
| 4 | Routes in `IPAD_COMPATIBILITY.md` marked **stable** | Additive changes only from then on | Recorded staging run |

At every step the app can fall back to the staff routes. The API keeps both families.

## 8. Acceptance (what "verified" means)

The cross-platform flow, plan §8 21-POSAPI:

1. The iPad creates an order.
2. The API validates and persists it.
3. Web Orders and the dashboard update.
4. The KDS receives it and the kitchen changes its status.
5. The iPad and the web reflect the change.
6. Payments, inventory and analytics reconcile.

The flow must also cover event delivery, reconnect, offline replay, idempotency, conflicts and branch permissions.

| Level | Status |
|---|---|
| Scripted device in `apps/api/test/pos-flow.test.ts` (API level) | **Passes** on this branch |
| Playwright spec with a simulated device | **Not written yet** (stabilisation phase) |
| Real iPad build against staging | **Not run.** Contracts stay **draft** until it passes |

## 9. Open questions (new or changed by this reconciliation)

1–9: unchanged in `IPAD_COMPATIBILITY.md`.

10. **Key-bound devices.** Is a hashed bearer credential acceptable for the first release, or must enrolment bind a device key (App Attest / Secure Enclave public key) before release? It can be added as optional pairing fields.
11. **Offline sign-in.** With `requireStaff`, how long may a cached staff JWT be used? The app's current 8-hour policy holds only while the JWT is valid: an expired JWT is refused server-side whatever the device state.
12. **Line amendments, table move, merge and staff splits** (`API_DEPENDENCIES.md` P1). These are not in either route family yet. Should they be device routes (`/v1/pos/orders/{id}/amend`, …), staff routes, or both?
