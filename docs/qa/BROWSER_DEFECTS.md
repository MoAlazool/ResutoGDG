# Browser end-to-end defects (Agent H)

Found by the real-API Playwright specs in `tests/e2e/real-*.spec.ts` and
`tests/e2e/scenario-*.spec.ts` (no interception of Resuto APIs). Each spec that
covered a defect asserts the **correct** behaviour. While open they were marked `test.fail()`;
all seven are now **fixed** and the specs run as ordinary regression tests
(`// Regression for H-<n> (fixed)`). Run: see `docs/qa/BROWSER_E2E.md`.

## Status

| Id | Status | Fix |
|---|---|---|
| H-1 | Fixed | `floorTableInput.zone` is nullable/optional (blank → `null`); floor rules store `null`. API test `floor.test.ts` › "accepts tables without a zone" |
| H-2 | Fixed | `close` defaults `needsCleaning` to `true`; §8 documents the flag |
| H-3 | Fixed | `/t/<qr>`: a saved visit that returns 401 shows "session ended" instead of opening a new visit |
| H-4 | Fixed | `/t/<qr>`: tracking polls only while the sheet is open for that order (ref guard); closing clears it |
| H-5 | Fixed | Hosted ordering page starts in the `resuto_locale` cookie language; its toggle writes the cookie |
| H-6 | Fixed | KDS "Out for delivery" on an order with an open driver job hands the bag over (lines served, ticket leaves the board, event `handed_to_driver`) and keeps the order `ready`; only the driver's delivery marks it delivered and settles COD. API test `delivery.test.ts` › "kitchen hand-over" |
| H-7 | Fixed | Dashboard shell loads the org and its entitlements together and renders only once module gates are known |

The sections below are the original reports, kept for the record.

| Id | Severity | Area | One line |
|---|---|---|---|
| H-1 | High | Floor Studio ↔ floor API | First table on a branch without zones cannot be saved (`zone: null` rejected) |
| H-2 | Medium | Live floor ↔ visits API | Closing a table never puts it in "Cleaning"; "Mark clean" is unreachable |
| H-3 | High | QR guest page | Reloading after staff closed the visit silently opens a new visit |
| H-4 | High | QR guest page | Order-tracking sheet polls in a tight loop (~11 req/s) and reopens after being closed |
| H-5 | Low | WhatsApp hosted ordering | Page ignores the `resuto_locale` cookie |
| H-6 | High | KDS ↔ delivery | "Out for delivery" on the KDS marks a driver-dispatched COD order `delivered`/unpaid |
| H-7 | Medium | Dashboard shell / module gate | Unentitled pages fire module API calls (402 + console errors) before the upgrade prompt |

---

## H-1 · Floor Studio: the first table on a fresh branch cannot be saved

- **Page:** `/dashboard/<org>/floor?tab=studio`
- **Spec:** `real-floor.spec.ts` › "the first table on a fresh branch (no zones yet) can be added and saved"
- **Steps:** create a restaurant (its floor has no zones), open Floor Studio, add a round
  table from the palette, press *Save layout*.
- **Expected:** "Floor layout saved. Guest maps are updated." and the table exists.
- **Actual:** the save fails with "The request is invalid"; the draft stays unsaved. Every
  new restaurant hits this on its very first floor edit unless it first adds a zone.
- **Network evidence:**
  `PUT /v1/o/<org>/floor/<branch>` → `400 {"error":{"code":"validation_failed","message":"The request is invalid","details":[{"path":"layout.tables.0.zone","message":"Invalid input: expected string, received null"}]}}`
- **Cause:** contract mismatch with §8. Studio creates tables with
  `zone: f.zones[0]?.label ?? null` and treats `zone` as nullable (§8 lists `zone` without
  a constraint; F's double accepted null), while the API's `floorTableInput.zone` is
  `z.string().trim().min(1)`. The UI also shows the generic 400 text instead of a
  field-level message (it only maps `422 invalid_geometry`).
- **Suspected files:** `apps/web/components/floor/model.ts` (`createItem`, `toSaveBody`),
  `packages/contracts/src/floor.ts` (`floorTableInput.zone`), `apps/api/src/modules/floor/floor-rules.ts`
  (`t.zone.trim()`). Fix one side: default the zone (e.g. "Main Room") in the UI, or make
  `zone` nullable in the contract and rules.

## H-2 · Live floor: closing a table skips the cleaning state

- **Page:** `/dashboard/<org>/floor?tab=live`
- **Spec:** `real-floor.spec.ts` › "after closing, the table needs cleaning and "Mark clean" returns it to Available"
- **Steps:** select T1, *+ Seat a walk-in*, *Close table*.
- **Expected:** the table shows **Cleaning** with a *Mark clean* action (legacy host flow; F's
  live floor is built around it and F's §8 double modelled close → `cleaning`).
- **Actual:** the badge goes straight to **Available**; *Mark clean* never appears.
  DB: `dining_tables.status = 'available'` after close.
- **Cause:** `LiveFloor.close()` posts `{}` to `POST /v1/o/<org>/visits/<id>/close`; the API's
  `closeVisitRequest.needsCleaning` defaults to `false` (`VisitsService.settle` sets
  `needsCleaning ? 'cleaning' : 'available'`). §8 does not document `needsCleaning`.
- **Suspected files:** `apps/web/components/floor/LiveFloor.tsx` (send `needsCleaning: true`, or
  offer a choice), `apps/api/src/modules/orders/visits.service.ts` (default), and §8 in
  `docs/architecture/MODULE_CONTRACTS.md`.

## H-3 · QR guest page: a closed session silently reopens as a new visit

- **Page:** `/t/<qr>` (390 px)
- **Spec:** `scenario-dine-in.spec.ts` › "after staff close the visit, reloading the guest page shows the session ended"
- **Steps:** guest opens `/t/<qr>`; staff closes the visit (live floor or
  `POST /visits/:id/close`); guest reloads.
- **Expected:** "This table session has ended" with *Start again*; no new visit until the
  guest chooses to start again (or staff seats the table).
- **Actual:** the menu appears again for a **new** visit opened by the reload. DB evidence for
  the table: `{closed:qr:manual, open:qr:}` (two visits; the second auto-opened by the reload).
  A guest who leaves the tab open at home re-opens the table remotely; staff see an
  occupied table nobody is sitting at.
- **Network evidence:** `GET /v1/public/visits/current` → `401 visit_closed`, immediately
  followed by `POST /v1/public/tables/<qr>/session` → `200` with a **new** `visitId`, then the menu.
- **Cause:** the mount effect in `apps/web/app/t/[qr]/page.tsx` treats any failure of
  `/visits/current` as "rescan": `.catch(() => { clearGuestVisit(qr); void startSession(); })`.
  The `closed` phase is only reached from `refresh()`.
- **Suspected file:** `apps/web/app/t/[qr]/page.tsx` (on `401 visit_closed` for a saved visit, set
  `phase = 'closed'` instead of calling `startSession()`).

## H-4 · QR guest page: order-tracking sheet polls in a hot loop and will not stay closed

- **Page:** `/t/<qr>` after *Send to kitchen*
- **Spec:** `scenario-dine-in.spec.ts` › "the order-tracking sheet polls at the 2.5 s cadence and stays closed when dismissed"
- **Steps:** add Fries, *View cart*, *Send to kitchen* (the "Order #n" sheet opens); wait 5 s;
  tap *Back to the menu*.
- **Expected:** order status polled every 2.5 s (≤ 3 requests in 5 s); the sheet closes.
- **Actual:** **55** `GET /v1/public/visits/current/orders/<id>` requests in 5 s (~11/s, each
  paired with `GET /visits/current`). At that rate the guest read limits in
  `GuestController` (120/min per token, 240/min per IP) are exhausted within seconds, after
  which the limiter answers `429` (by the limiter's arithmetic; the spec measures the request
  rate, not the 429s). After closing, the sheet re-opens within a second (an
  in-flight poll calls `setTracking(...)` again). The dine-in scenario has to reload the
  page to get past it.
- **Cause:** `refresh` is a `useCallback` over `[visit, tracking, qr]` and calls
  `setTracking(newObject)`; the polling `useEffect` depends on `refresh` and calls
  `refresh()` immediately on every re-run → fetch → new `tracking` → new `refresh` → effect
  re-runs → fetch … An already-started `refresh` resolves after *Back to the menu* and
  re-opens the sheet.
- **Suspected file:** `apps/web/app/t/[qr]/page.tsx` (`refresh`/polling effect; keep the tracked
  order id in a ref, and ignore results for a sheet that was closed).

## H-5 · Hosted ordering page ignores the locale cookie

- **Page:** `/o/<token>` (WhatsApp ordering link)
- **Spec:** `scenario-whatsapp.spec.ts` › "the hosted ordering page honours the Arabic locale cookie (dir=rtl, no overflow)"
- **Steps:** set `resuto_locale=ar`, open the ordering link.
- **Expected:** Arabic, `dir="rtl"` (every other public page honours the cookie).
- **Actual:** `<div dir="ltr" lang="en">` — the page uses only the conversation's locale
  (`view.locale`). The in-page language toggle works (the Arabic run of the scenario uses
  it, and Arabic/RTL at 390 px has no horizontal overflow).
- **Suspected file:** `apps/web/app/o/[token]/OrderingClient.tsx` (`setLocale((l) => l ?? v.locale)`; seed
  the initial locale from `useT()`/the cookie when the guest has chosen one).
- Severity is low: the conversation language is a reasonable default; this matters when a
  guest's chat language differs from their chosen site language.

## H-6 · KDS "Out for delivery" closes a driver-dispatched delivery order

- **Page:** `/kitchen/<org>`
- **Spec:** `scenario-driver.spec.ts` › "the KDS hand-over of a driver-dispatched delivery ticket does not mark the order delivered behind the driver"
- **Steps:** COD delivery order from the website; dispatcher assigns a driver who accepts;
  on the KDS: *Start preparing* → *Ready* → *Out for delivery*.
- **Expected:** handing the bag to the driver leaves the order open until the driver
  delivers it (the driver then confirms pickup, collects cash, delivers → order paid).
- **Actual:** the order becomes `delivered` (final) while unpaid and while the job is still
  `accepted`. DB after the tap: `orders.status = 'delivered'`, `payment_status = 'unpaid'`,
  `delivery_jobs.status = 'accepted'`, `cash_status = 'pending'`. The kitchen can thereby
  end a COD order with no cash collected and analytics count it as delivered.
- **Cause:** `KitchenBoard` maps the hand-over button with
  `FULFILLED = { …, delivery: 'delivered' }` and labels it "Out for delivery"; the kernel
  state machine allows `ready → delivered` from staff even when a delivery job exists.
- **Suspected files:** `apps/web/app/kitchen/[orgId]/_kds/KitchenBoard.tsx` (hide/replace the
  button for delivery tickets that have a job — the driver's pickup/delivery drives the
  order), and/or `apps/api/src/modules/kitchen/kitchen.service.ts` / kernel
  `OrdersKernelService.transition` (refuse `delivered` while an active delivery job exists).

## H-7 · Unentitled module pages call their APIs before showing the upgrade prompt

- **Pages:** `/dashboard/<org>/{marketing,delivery,finance}` on the `free` plan
- **Spec:** `scenario-owner.spec.ts` › "a gated (unentitled) page makes no module API calls and logs no errors"
  (the prompt itself works: "a free-plan owner sees the upgrade prompt …" passes in en/ar)
- **Expected:** the gate shows "This module is not in your plan" without calling paid APIs.
- **Actual:** each page first mounts its content and calls the module API, producing
  `402 Payment Required` responses and console errors
  (`Failed to load resource: the server responded with a status of 402`), then the upgrade
  prompt replaces it. Calls seen:
  `GET /marketing/campaigns`, `/marketing/segments`, `/connect/templates`, `/delivery/board`,
  `/finance/overview`, `/finance/insights`, `/finance/reconciliation`, `/finance/fees` → 402.
- **Cause:** `OrgProvider.hasModule` returns `true` while `modules === null` (not loaded yet),
  so every `ModuleGate` renders its children during the first render; the finance page also
  calls `useApi` above its `ModuleGate`.
- **Suspected files:** `apps/web/lib/org-context.tsx` (`hasModule` while loading; treat unknown as
  "loading" and let `ModuleGate` render a skeleton), `apps/web/components/shell/DashboardShell.tsx`,
  `apps/web/app/dashboard/[orgId]/finance/page.tsx`.

---

## Real floor API vs. F's §8 assumptions (`floor-api-mock.ts`)

Compared while running `real-floor.spec.ts` against B1's module:

| # | §8 / F's double | Real API | Impact |
|---|---|---|---|
| 1 | `Table.zone` may be `null` | `zone` required, non-empty string (400 `validation_failed`) | **Defect H-1** |
| 2 | Close puts the table in `cleaning` | Close → `available` unless the body sends `needsCleaning: true` (undocumented in §8) | **Defect H-2** |
| 3 | Bad geometry → `422 invalid_geometry` only | Schema errors (zone, sizes, duplicate labels) come back as `400 validation_failed` / `422 duplicate_label`; Studio shows only the generic message for these | part of H-1 |
| 4 | `PUT` response = layout | layout **plus** `created: [{ clientId, id }]` | none (ignored by the UI) |
| 5 | `POST /visits` → `{ id, tableId }` | `{ id, tableId, creditMinor }` | none |
| 6 | `POST /visits/:id/close` → `{ closed: true }` | `{ ok, unusedCreditMinor, dueMinor }`; unpaid balance → `409 visit_not_settled` (`details.dueMinor`, `openOrders`); force-close is manager-only (`403`) | none — Studio's forced-close confirm handles 409 correctly |
| 7 | Tables keep draft order | Server returns tables ordered by label | none |
| 8 | `background.opacity` 0.4 | default 0.45 | none |
| 9 | QR `url` = `${APP_ORIGIN}/t/<token>` | identical; QR SVGs are real codes | none |

Everything else in §8 matched: `baseRevision` → `409 stale_layout { currentRevision }` (the
second of two concurrent managers gets the conflict UI with *Export draft* / *Reload saved
floor*), `409 table_in_use { tableId }` when removing a table with an open visit (no table
archived, revision unchanged), the live payload (`visit.dueMinor/paidMinor/orderCount/requests`),
and the QR print sheet.
