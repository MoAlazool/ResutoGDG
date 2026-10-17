# Defects found by the end-to-end scenarios

Owner: Agent G (scenario QA). Each defect has one scenario step marked `it.fails(...)` with a
`// DEFECT: <id>` comment. That step asserts the **correct** business behaviour, so the suite stays
green while the defect exists. Once the defect is fixed the step will fail; then change `it.fails`
back to `it`.

Module code was not changed. The suspected files and fixes below are suggestions for the owning agents.

| Id | Severity | Module (owner) | Scenario step |
|---|---|---|---|
| G-01 | High (wrong marketing ROI) | kernel / guest web ordering (Lead, B1), web `order/[slug]` (B1) | `s05-marketing.test.ts` step 8 |
| G-02 | Medium (broken checkout offered to guests) | guest web ordering (B1) | `s10-entitlements.test.ts` step 4 |

---

## G-01: Web orders placed from a tracking link are never attributed to the campaign

- **Endpoint:** `POST /v1/public/order/:slug/orders` (web pickup/delivery ordering).
- **Reproduction** (`apps/api/test/scenarios/s05-marketing.test.ts`, steps 6 and 8):
  1. Create a campaign and a tracking link with `POST /v1/o/:orgId/marketing/links` and
     `{ campaignId, destinationPath: "/order/<slug>" }`. The marketing module's own tests use this
     destination too.
  2. Click it with `GET /v1/public/l/:code`. The click is recorded (`attribution_events.kind = 'link_click'`),
     and the destination is `/order/<slug>?utm_source=resuto&utm_medium=…&utm_campaign=…&rcid=<campaignId>&rsid=<sessionKey>`.
  3. Place a web order on that page and forward the destination's query parameters as the order's
     `attribution` (the body field the contract allows).
- **Expected:** the order is attributed to the campaign: `orders.campaign_id = <campaignId>`. After
  payment it then shows in `GET /v1/o/:orgId/marketing/campaigns/:id/report` (orders, revenue), because
  that report and the `order.paid` → `attribution_events(order_paid)` handler both key on `orders.campaign_id`.
- **Actual:** `orders.attribution` holds `rcid` and `rsid`, but `orders.campaign_id` is `NULL`. The order
  never appears in the campaign report, so revenue from link traffic to the web ordering page is lost.
  The WhatsApp hosted page (`/o/<token>`) path works. Step 7 of the same scenario shows that.
- **Suspected cause:** `apps/api/src/modules/guest/guest.service.ts` → `webOrder()` passes `attribution`
  to `OrdersKernelService.place` but never derives `campaignId` from `attribution.rcid`. Compare
  `connect/ordering.service.ts` → `attributedCampaign()`, which validates the campaign id against the tenant.
  The kernel (`kernel/orders-kernel.service.ts`) sets `campaign_id` only from `input.campaignId`.
  Separately, the web page `apps/web/app/order/[slug]/page.tsx` does not forward `utm_*`/`rcid`/`rsid`
  at all, unlike `apps/web/app/o/[token]/OrderingClient.tsx`.
- **Suggested fix:** in `webOrder`, accept a validated `rcid` (a UUID of a campaign in this tenant) and pass
  it as `campaignId`. Store `rsid` as `attribution.session_key` the way the hosted page does. Then forward the
  query parameters from the web ordering page.

## G-02: The public ordering page offers online payment to restaurants without ResutoPay

- **Endpoint:** `GET /v1/public/order/:slug`, field `payment.online`.
- **Reproduction** (`apps/api/test/scenarios/s10-entitlements.test.ts`, steps 3 and 4):
  1. Create a restaurant on the `free` plan (core only, no `pay` module).
  2. `GET /v1/public/order/<slug>` returns `payment: { payAtPickup: true, cashOnDelivery: true, online: true }`.
  3. A guest who picks online payment gets `POST /v1/public/order/<slug>/orders` with `payment: "online"`,
     which returns `402 module_not_entitled`. The backend enforcement is correct: no order and no checkout
     session are created.
- **Expected:** `payment.online` is `false` when the tenant is not entitled to `pay`, so the page never
  shows a payment option that cannot complete.
- **Actual:** `payment.online` is `true` whenever the ResutoPay `CHECKOUT_PORT` is bound in the
  deployment, whatever the tenant's plan.
- **Suspected cause:** `apps/api/src/modules/guest/guest.service.ts` → `webMenu()` computes
  `online: !!this.checkout` and does not check `EntitlementsService.isEnabled(orgId, 'pay')`.
  `connect/ordering.service.ts` has a similar `paymentOnlineAvailable` flag that is worth checking.
  The scenario only showed the web page, because Free tenants cannot open WhatsApp channels.
- **Suggested fix:** `online: !!this.checkout && await entitlements.isEnabled(org.id, 'pay')`.

---

## Observations (not marked as defects)

- **Campaign approval has no separation of duties.** In `POST /v1/o/:orgId/marketing/campaigns/:id/approve`,
  any holder of `marketing:approve` can approve, including the person who drafted and submitted the campaign.
  The `marketing` role has both `marketing:write` and `marketing:approve`. Scenario S05 uses a separate approver
  (a manager), as the product brief describes. Whether the backend should *enforce* four-eyes approval is a
  product decision, so this is not recorded as a defect. If it should, `campaigns.service.ts → approve()`
  needs to compare `ctx.userId` with the submitter. That requires storing `submitted_by`.
- **Studio has no API in this tree.** `apps/api/src/modules/studio/studio.module.ts` declares no controllers.
  Because of that, S01 checks only the seeded `websites` row and S10 checks only the `studio` entitlement flag.
  The website section and publish steps could not be tested.
