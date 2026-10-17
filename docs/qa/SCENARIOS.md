# End-to-end business scenarios (API level)

Owner: Agent G. Files: `apps/api/test/scenarios/s01…s10-*.test.ts` and the shared `support.ts`.

## Ground rules

- Each scenario boots the real `AppModule` with `bootTestApp()` and drives it through HTTP with supertest,
  in the order a real business would act. No Resuto module is mocked, and no test is skipped.
- Each scenario creates its own tenants, so the files are independent.
  - Menus are built through the menu API (`support.ts → buildMenuViaApi`), with bilingual names, modifier groups and costs.
  - Floors are built through `PUT /floor/:branchId`.
  - QR tokens come only from the print sheet.
- Direct SQL is used only to:
  1. Read and assert state.
  2. Stand in for time passing in **S07**, which back-dates `orders.placed_at` and `orders.business_date`
     after each order is created through `POST /v1/o/:orgId/orders`, because the API always stamps "now".
  3. Open an `authenticated` role session in **S09**, standing in for a direct Supabase client, as `supabase/tests/rls.test.mjs` does.
- Provider behaviour uses the real signed sandbox paths:
  - Payments: `POST /v1/public/pay/:token/start` then `POST /v1/public/pay/:token/sandbox/complete`.
    This returns the signed webhook to the normal verification path (`webhook_inbox`, `signature_valid = true`).
  - WhatsApp inbound: `POST /v1/o/:orgId/connect/sandbox/inbound` on a sandbox channel.
  - The settlement statement is an uploaded CSV.
- Reactions run with `EventDispatcher.drain()`: delivery jobs, fiscal documents, WhatsApp confirmations, attribution.
  S10 moves the subscription forward with `BillingLifecycleService.run(<controlled time>)`.
- A defect keeps the scenario asserting correct behaviour. That one step is marked `it.fails` with
  `// DEFECT: <id>` and recorded in [`DEFECTS.md`](./DEFECTS.md).

Run: `cd apps/api && TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54329/resuto_test_g npx vitest run test/scenarios`.
S07 needs the AI service virtualenv (`apps/ai-service/.venv`) and starts it on port 8117.

## Results

| # | Scenario | File | Steps | Result |
|---|---|---|---|---|
| S01 | Restaurant onboarding | `s01-onboarding.test.ts` | 8 | ✅ pass (website step limited: no Studio API) |
| S02 | Dine-in, split bill | `s02-dine-in.test.ts` | 10 | ✅ pass |
| S03 | WhatsApp structured ordering | `s03-whatsapp-ordering.test.ts` | 6 | ✅ pass |
| S04 | Delivery | `s04-delivery.test.ts` | 8 | ✅ pass |
| S05 | Marketing | `s05-marketing.test.ts` | 8 | ✅ 7 pass, 1 documented defect (G-01) |
| S06 | Finance | `s06-finance.test.ts` | 9 | ✅ pass |
| S07 | AI | `s07-ai.test.ts` | 4 | ✅ pass |
| S08 | MCP | `s08-mcp.test.ts` | 7 | ✅ pass |
| S09 | Multi-tenancy | `s09-multi-tenancy.test.ts` | 8 | ✅ pass |
| S10 | Entitlements | `s10-entitlements.test.ts` | 9 | ✅ 8 pass, 1 documented defect (G-02) |

Full API suite on 2026-10-17 (`cd apps/api && npx vitest run`, `TEST_DATABASE_URL=…/resuto_test_g`):
**34 files, 345 tests, all passed**. That is the 268 pre-existing tests plus 77 scenario steps. The 77 include the two `it.fails`
defect steps, which vitest counts as passed because they fail as expected.

## Steps per scenario

### S01 Restaurant onboarding
1. Dev signup (`POST /v1/auth/dev/signup`). `GET /v1/me` shows no memberships.
2. `POST /v1/orgs`: an EG restaurant with Arabic names, plan Pro.
   - The org reads EGP, Africa/Cairo, status `onboarding`.
   - Seeded atomically: Pro trial entitlements, the ETA tax profile (14 %, not validated) and an empty menu.
3. Second branch (`POST /branches`).
4. Menu through the API: two categories with Arabic names, three products with allergens, dietary tags and stations,
   and Size (required) and Extras modifier groups.
   - The public menu shows the Arabic names, groups and options, and no costs.
   - The second branch serves the same menu.
5. Website: **the Studio module has no controller in this tree**, so only the seeded `websites` row is checked.
6. Floor layout with three tables (`PUT /floor/:branchId`), all `available`. The live floor shows no visits.
7. QR print sheet (`GET /floor/:branchId/qr`): three unique `/t/<token>` URLs with SVGs.
   - The tokens appear in no other response: the public floor, public menu, web ordering page, staff floor,
     live floor and org.
   - A token is not accepted as `X-Visit-Token`.
   - A waiter cannot print the sheet.
8. The audit trail contains `organization.created` and `menu.product.created`.

### S02 Dine-in
1. A guest scans the QR, which opens the visit. A second guest joins the same visit and token. The table shows `occupied`.
2. Visit menu (Arabic names) and a server quote: (18500 + 3000) × 2 + 4500 = 47500.
3. The guest orders. A retry with the same `Idempotency-Key` returns the same order, and exactly one order exists (`qr`/`dine_in`).
4. The kitchen feed shows the ticket with modifiers, stations and notes. The kitchen bumps it accepted → preparing → ready.
5. The waiter serves it. The guest's timeline reads placed → … → served, and 47500 is due.
6. Equal split for 3: shares 15834/15833/15833 (largest remainder, sums to the bill). Full-bill checkout is refused (`split_active`).
7. Each share: share checkout → provider start → a forged "paid" return URL changes nothing → sandbox complete.
   - The share becomes `paid`.
   - All `webhook_inbox` rows are `processed` with valid signatures.
   - The payments are simulated, test, and equal to the share amounts.
8. Bill due 0, split `settled`, order `paid`.
9. The waiter closes the visit with `needsCleaning`.
   - The table becomes `cleaning`.
   - The old token returns 401 `visit_closed` for reads, orders and the bill.
   - A new scan returns 409 `table_unavailable` (cleaning).
10. Clean (`POST /tables/:id/clean`): the table is `available`, the next scan opens a new visit with a new token,
    and the old token stays rejected.

### S03 WhatsApp structured ordering (real ResutoPay behind `CHECKOUT_PORT`)
1. Inbound "order" on a sandbox channel.
   - Interactive branch picker (two branches) → fulfillment buttons. Free text re-prompts.
   - Delivery → name buttons → typed name → typed address → `cta_url` hosted ordering link.
   - The hosted page shows step `menu`, delivery, the name, the address and the menu with modifier groups.
2. Price tampering in the cart is rejected: a `priceMinor` field → 400, a `totalMinor` field → 400,
   missing required modifiers → 422 `invalid_modifiers`.
   - Server quote: subtotal 28000 + delivery 2500 = 30500. The review buttons offer online and COD.
   - A lowered `expectedTotalMinor` at checkout → 409 `price_changed`.
3. (a) Online checkout: the order is `awaiting_payment`, the pay link is sent into the chat (`cta_url`), and the kitchen does not see it.
   A "paid ✅" chat message changes nothing.
4. Simulated provider payment (signed webhook): the order is `placed`/`paid` for 30500, and the kitchen now sees it.
5. Drain:
   - The ordering session is `completed`.
   - "Payment received" is queued to the conversation.
   - A prepaid delivery job exists with nothing to collect (`cod_amount_minor = 0`, `cash_status = 'none'`).
6. (b) COD with marketing consent: the order is placed immediately, unpaid, `whatsapp`/`delivery`, and the kitchen sees it.
   - Consent is stored with source `whatsapp`.
   - The retry replays the same order.
   - Drain: "Order #N received" is queued.

### S04 Delivery
1. A driver invited through `POST /invitations` and accepted appears in `GET /delivery/drivers` (active, offline).
2. The customer places a WhatsApp COD delivery order (two fries and a soda, plus delivery fee).
3. Drain: one delivery job, `unassigned`, COD = order total, with the drop-off address and phone snapshot.
4. Offering to the offline driver → `driver_unavailable`. The driver goes online, the dispatcher offers the job, and the driver sees it and accepts.
5. Pickup before the kitchen is ready → 409 `order_not_ready`. The kitchen bumps the order to ready; the driver picks up and goes en route.
   Drain: "#N is on the way" is queued to the customer.
6. Proof photo upload, then delivery.
   - A short cash amount → `cash_amount_mismatch`.
   - The exact cash amount with an `Idempotency-Key` → `delivered`/`collected`. The replay is OK.
   - The job's events and the signed proof URL are recorded.
7. The order is `delivered`, `paid` (COD payment of the full total). Drain: "#N received" and "#N was delivered" were queued.
8. The driver's cash on hand equals the total. Settlement:
   - The wrong amount is refused (`settlement_amount_mismatch`).
   - The exact amount is settled; nothing remains on hand.
   - A second settlement → `cash_not_collected`. The job is `settled` and the driver is `available`.

### S05 Marketing
1. Activity:
   - Amira: WhatsApp order with consent, paid in cash.
   - Bassem: WhatsApp order without consent, paid.
   - Carla: web order with consent.
   - The customers API lists all three, with consent as given.
2. DSL segment `orders_gte 1 within 30d`: preview `{count: 3, consentedCount: 2}`.
   A consent + `channel web` preview gives 1. `raw_sql` → 400. The saved segment has 3 members, exactly these customers.
3. The marketer drafts a WhatsApp campaign (`draft`, sandbox).
   Sending before approval → `campaign_not_approved`. Submit → `pending_approval`. A cashier cannot approve (403).
4. A **separate approver** (manager) approves (`approvedBy` = the manager). The campaign is locked.
5. Send on the sandbox channel: recipients 3, queued 1, skippedNoConsent 1, failed 1 (Carla: `no_channel`), sandbox 1, live 0.
   Bassem received no campaign message. A second send → 409.
6. Tracking link to `/order/<slug>`. The click is recorded, and the destination carries `utm_*`, `rcid` and `rsid`.
7. Amira orders through the hosted WhatsApp page with the link attribution and pays.
   - The order is attributed (`campaign_id`, `session_key`), and `order_paid` attribution is recorded once.
   - Report: last touch, clicks 1, orders 1, revenue = order total, cost 0, ROAS null, disclaimer "not incremental".
8. **DEFECT G-01** (`it.fails`): a web order on the link destination, with `rcid`/`rsid` forwarded, is not attributed (`campaign_id` NULL).

### S06 Finance
1. The accountant validates the EG tax profile (ETA, 14 %).
2. A day of trading through the API:
   - 2 × fries, paid in cash.
   - Burger + soda, paid by card through a staff payment link on the simulated provider.
   - 2 × soda as a web order paid online.
   - 1 × fries left unpaid.
   - 1 × soda cancelled.
3. Provider refund of 5000 on the card payment: the payment is `partially_refunded`.
4. Drain: an ETA receipt (`authority = eta`, total, VAT = round(total × 14/114)) for each paid order, none for the
   unpaid or cancelled orders, one credit note of 5000, and the hash chain verifies.
5. Provider API reconciliation: 2 items, 2 matched, difference 0.
6. Settlement statement CSV (the two real transactions, one with its refund, plus one extra provider transaction of 77.00):
   matched 2, `missing_in_resuto` 1 (open, no payment booked), difference 7700.
7. Expenses: rent 100000; utilities 11400 incl. 1400 VAT; ingredients (COGS) 5700 incl. 700 VAT; payment-fee expense 1000.
   Totals {4, 118100, 2100, 116000}.
8. The overview and P&L are compared field for field with figures computed in the test from what happened:
   gross, refunds, VAT net of refund VAT, net ex-VAT, collected, COGS from line costs plus COGS expenses, opex by kind,
   fees (provider fees plus the fee expense), operating profit and gross margin.
   Coverage shows one unpaid order and two test payments.
9. Sales CSV export: 5 rows including the cancelled order. The checksum is sha256 of the content, and the download is
   byte-identical with an `x-content-sha256` header. The P&L export checksum is also verified.

### S07 AI (real Python AI service, rules-mode assistant)
- History: 89 days of orders, one per day from today−90 to today−2 (Thursday and Friday busier), plus one small order yesterday (a sharp drop).
  All were created with `POST /v1/o/:orgId/orders` and **then back-dated with SQL** on `placed_at` and `business_date`.
0. The history spans ≥ 60 distinct days, from today−90 to yesterday, all orders through the staff channel.
1. `GET /intelligence/forecast?horizon=14&top=3` (`isSyntheticData: false`, as of yesterday) returns the burger with:
   - 14 points with intervals;
   - two or more candidate models, the chosen one having backtest metrics (`n > 0`, `wape`) and the lowest WAPE;
   - coverage of 60 days or more ending yesterday.
2. `POST /intelligence/insights/refresh` creates 1 or more insights; at least one has evidence.
   The deterministic `revenue_drop` insight's `evidence.revenueMinor` equals yesterday's SQL revenue.
3. The assistant (no Gemini key → `rules`):
   - "How much did we sell yesterday?" → the `sales_summary` revenue and order count equal SQL, and the answer
     contains the formatted amount, cited.
   - "sales in the last 7 days" → period today−6…today, with revenue and count equal to SQL.

### S08 MCP (API `@AllowMcp` routes with an `rmcp_` key)
1. The owner creates a client.
   - The key (`rmcp_…`) is returned once; only its sha256 is stored, and the list never shows it.
   - `whoami` resolves the tenant and the acting role.
2. The tool list contains exactly the allowed tools, with schemas. `create_payment_link` is flagged sensitive.
   A tool that is not allowed → 403.
3. `list_orders`, `get_order` and `get_sales_summary` (today) match the SQL count and revenue.
4. `create_payment_link` for the unpaid order → 202 `approval_required` (summary "75.00 EGP").
   An identical retry → the same approval. No checkout session exists yet, and the status is `pending`.
5. A cashier cannot approve. The manager sees the queue and approves → `executed`, with a real ResutoPay URL.
   - A second approval → 409.
   - Exactly one `checkout_sessions` row (channel `mcp`), and the public pay page shows it open.
   - The URL is handed to the client once.
6. Audit:
   - one `mcp_tool_calls` row per call, the payment link as `approval_required ×2 → approval:ok`, and the denied tool recorded;
   - one `mcp.tool_call` audit row per call;
   - `mcp.approval.requested` and `mcp.approval.approved`;
   - the dashboard call log matches.
7. The key is revoked: 401 on tools, the tool list and `whoami`.

The standalone `apps/mcp-server` (SDK client over Streamable HTTP) is not started here. Its own `test/e2e.test.ts` covers it against these same routes.

### S09 Multi-tenancy
Two complete tenants, A and B. Each has a menu, floor, open visit with an order and a split, a web online
order with a checkout token, a WhatsApp ordering token, a product image, an MCP key and a cash payment.
B also has an extra order, so leaks would change the totals.
1. A's owner gets 404 on 17 of B's dashboard paths: org, orders, order, menu, floor, QR sheet, kitchen,
   payments, customers, finance, delivery, MCP, connect, marketing, audit, entitlements, compliance.
   - A gets 404 on its own path with B's ids (order, visit, payment, branch floor, product).
   - Mutations by B's id are refused: close visit, clean table, order transition, product edit, refund, cash collect.
   - B's rows are unchanged.
2. B's visit token returns only B's visit and bill. Ordering or quoting A's product with it fails, and no order is created.
   - B's share, checkout and ordering tokens resolve only to B. A cart with A's product fails.
   - No guest token works as a staff bearer on A's or B's org routes, and the token kinds are not interchangeable.
3. A's MCP key on B's org path → 404 (tools and the tool list); B's order through A's path → 404.
   Two `mcp.cross_tenant_denied` audits are recorded in A, and no rows in B.
4. A's slug cannot quote or place on B's branch or product and cannot track B's order. A's public menu has no B products or branches.
5. Media signed URLs: A's URL works (`image/png`). These are refused with 404:
   - A's signature on B's object;
   - A's object re-prefixed with B's org id;
   - an extended expiry;
   - no signature;
   - path traversal.
6. `authenticated` role session for A's owner: it reads only A's orders and organization. A forged `app.org_id = B` returns nothing.
   UPDATE on orders (A's or B's), and SELECT on payments and on MCP key hashes, all return permission denied.
7. Intelligence:
   - A's assistant reports A's revenue only, less than A+B.
   - B gets 404 on A's insights, assistant and thread.
   - B's org path with A's thread, branch (forecast) or route plan → 404.
8. Analytics: B gets 404 on A's summary and overview, and on its own path with A's branch.
   A's product analytics contain none of B's products.

### S10 Entitlements
1. Free: only `core` is enabled. QR ordering, staff orders and the kitchen work.
2. Every paid module returns 402 `module_not_entitled` with its module name on staff routes (12 routes):
   connect ×2, marketing ×2, pay ×2, driver, finance, compliance, intelligence, mcp ×2.
   Studio has no routes in this tree; its flag is checked in step 1.
3. Public routes that need ResutoPay return 402 (visit bill, split, checkout). A web order with `payment: online`
   returns 402, and no order or checkout session is created.
4. **DEFECT G-02** (`it.fails`): the public ordering page still advertises `payment.online: true`.
5. Module-gated reactions: a Free COD delivery order that is paid gets no delivery job and no fiscal document after a drain.
6. Port: "Build Your Resuto" with only the MCP add-on.
   - The MCP tool list hides `create_payment_link`.
   - Calling it → 402 `module_not_entitled`, with no approval and no checkout session.
7. Upgrade through billing (`POST /billing/change-plan growth`): applied, trialing.
   - Growth's modules are enabled: pay, connect, marketing, studio, intelligence.
   - Connect, marketing, payments and the public bill now return 200.
   - Finance and driver still return 402.
8. Billing lifecycle with controlled time (no SQL writes):
   - At trial end + 5 min → `past_due` with grace = +7 days. Modules stay on during grace.
   - At +8 days → `unpaid`. Connect, marketing and the public bill return 402.
   - The subscription events include upgraded, trial_ended and grace_expired.
9. Falling back to Free restores core immediately. Paid modules stay 402.
