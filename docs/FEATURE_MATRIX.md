# Resuto 2.0 — Feature traceability matrix

> Baseline from the 2026-10-19 audit (commit c1a2501). Rows are re-marked as workstreams land; the open gaps are tracked in [BACKLOG.md](./BACKLOG.md). Probe files referenced below are kept with the audit evidence, not in the repository.

Audited: branch `claude/relaxed-mayer-omkl3f` at `c1a2501` (2026-10-19). Sources of agreed scope:
`docs/architecture/{FEATURE_INVENTORY,MODULE_CONTRACTS,TARGET_ARCHITECTURE}.md`, `docs/MODULE_STATUS.md` and the owner's
module list. Every row was checked against code and tests, not against the status docs.

Verification run for this matrix (own databases, nothing written to `resuto_demo`):

| Suite | Command | Result |
|---|---|---|
| API integration (38 files) | `cd apps/api && TEST_DATABASE_URL=…/resuto_features_audit_full npx vitest run` | **373 / 373 passed** |
| Integrations adapters | `pnpm --filter @resuto/integrations test` | **73 / 73 passed** |
| AI service | `apps/ai-service/.venv/bin/python -m pytest -q` | **33 passed** |
| Web unit | `cd apps/web && npx vitest run` | **25 / 25 passed** (1 file) |
| DB security | `node --test supabase/tests/*.test.mjs` | **14 / 14 passed** |
| Targeted probe (this audit) | `probes/features-probe.test.ts` on `resuto_features_audit` | 2 / 2 ran; output in `probes/probe-output.txt` |
| Playwright E2E | not run by this audit (specs listed per row) | — |

**Totals:** 107 feature rows. 76 are A or A/B, 16 are partial (A·C, A/B·C or B·C: the main flow works but a named
part is missing) and 15 are C. The gaps map to backlog items FT-01…FT-27.

## Legend

**Status:** **A** = internal workflow complete (UI + API + DB + permission + test). **B** = internal part done, external
verification pending (provider credentials / regulator / hosting). **C** = internal capability missing or broken.
**D** = deferred by plan (not a gap for this phase). A row can carry two statuses, e.g. `A/B` (works in sandbox, real
provider unverified) or `A·C` (main flow works, a named sub-capability is missing).

**Path shorthands:** `api:` = `apps/api/src/modules/`, `web:` = `apps/web/app/`, `cmp:` = `apps/web/components/`,
`pkg:` = `packages/integrations/src/`, `t:` = `apps/api/test/`, `s0N` = `apps/api/test/scenarios/s0N-*.test.ts`,
`e2e:` = `tests/e2e/`. Migrations (all `supabase/migrations/`): **FND** `20261017000100_foundation`, **BIL** `…0200_billing`,
**OPS** `…0300_operations`, **INT** `…0350_integrations`, **PDFC** `…0400_pay_delivery_finance_compliance`,
**CMS** `…0500_connect_marketing_studio`, **IM** `…0600_intelligence_mcp`, **REF** `…0700_reference_data_storage`,
**KER** `…0800_kernel`, **EVT** `…0900_event_handling`, **x01…x09** = the `202610180N000M_*` extension files.
**Gap** column = backlog item id (FT-nn) in the features-audit backlog (structured result of this audit; each item carries evidence, build plan and files).

---

## 1. CORE

| # | Feature | Workflow (UI → API) | Route / UI | Controller → service | Persistence | Permission / module | Failure & recovery | Deps | Tests | Status | Gap |
|---|---|---|---|---|---|---|---|---|---|---|---|
| C1 | Restaurant creation | signup → one-form org + first branch + plan → dashboard | `web:onboarding/page.tsx` | `api:platform/platform.controller.ts` `POST /orgs` → `organizations.service.ts:create` | organizations, branches, memberships, subscriptions, tax_profiles, menus, websites, floor_layouts (FND, BIL, OPS, PDFC, CMS) | authenticated user; plan branch limit (402) | atomic tx; duplicate slug 409 | billing, compliance, studio seeds | `t:platform.test.ts` (onboarding ×4), `s01`, `e2e:onboarding.spec.ts` | A | — |
| C2 | Guided setup / launch checklist | settings checklist: steps are **marked done by hand** | `web:dashboard/[orgId]/settings/page.tsx:27-131` | `POST /o/:orgId/onboarding/:step` → `completeOnboardingStep` (`organizations.service.ts:131`) | organizations.onboarding jsonb | org:manage | none (any step can be asserted without data) | — | none for steps | **C** (legacy 8-step wizard: operating mode, payment readiness, preview not ported; steps not derived from data) | FT-13 |
| C3 | Branch setup (hours, fulfilment flags, fees, deposit, timezone) | settings → create/update branch | `web:dashboard/[orgId]/settings/page.tsx` | `POST/PATCH /o/:orgId/branches` → `organizations.service.ts:142,155` | branches (FND, x02) | branches:manage | plan limit 402; validation via `branchInput` | — | `t:platform.test.ts` (branch limits) | A·C (opening hours enforced only for reservations; `delivery_radius_m` stored but never read; no delivery zones) | FT-09 |
| C4 | Staff (invite, roles, branch scope, remove) | team page → invite link shown once → `/invite/[token]` accept | `web:dashboard/[orgId]/team/page.tsx`, `web:invite/[token]/page.tsx` | `platform.controller.ts:64-92` → `organizations.service.ts:195-300` | memberships, invitations (FND) | members:manage; escalation guard | token single-use, revoke, 7-day expiry | — | `t:platform.test.ts` (RBAC, escalation, invitations) | A (link must be shared manually; `member.invited` has no consumer) | FT-06 |
| C5 | Menu: categories, products (bilingual, allergens, dietary, cost), images | menu page CRUD, image upload | `web:dashboard/[orgId]/menu/page.tsx` | `api:menu/menu.controller.ts:39-96` → `menu.service.ts` | menus, menu_categories, products, media_assets (OPS) | menu:read / menu:write | version 409 on stale edit; archive not delete | storage | `t:menu.test.ts` (CRUD, stale, image) | A | — |
| C6 | Modifiers (groups min/max, options) | menu page modal | same | `menu.controller.ts:111-148` | modifier_groups, modifier_options, product_modifier_groups (OPS) | menu:write | server-side validation in `kernel/pricing.service.ts:106-118` | kernel | `t:menu.test.ts`, `t:kernel.test.ts` (required groups) | A | — |
| C7 | Branch-specific price / stock | product editor "branch price", "stock" | `menu/page.tsx:146-149,201-202` | `PUT /menu/products/:id/branches/:branchId` → `menu.service.ts:251` | product_branch_settings.price_override_minor / stock_qty (OPS) | menu:write | stock 409 `out_of_stock` at quote | kernel pricing | `t:kernel.test.ts`, `t:guest.test.ts` (sold out) | A | — |
| C8 | **Branch assignment vs temporary unavailability ("86")** | one checkbox `available` per branch | `menu/page.tsx:32,93-95` | `POST /menu/products/:id/availability` → `menu.service.ts:282-289` | **single** `product_branch_settings.is_available` (OPS:96-105) | menu:availability | 86 hides product from public menus exactly like "not offered" (probe `publicMenuAfter86Burger`); no auto-restore, no "until", no KDS control | MCP tool `update_product_availability` | `t:guest.test.ts` ("not offered vs sold out" covers stock only) | **C** | FT-02 |
| C9 | Menu import / export (CSV, POS rows) | menu page CSV preview → commit; POS rows from integrations | `menu/page.tsx:291-327` | `menu.controller.ts:155-161` → `menu-import.ts` | products etc. | menu:write | idempotent commit; imported drafts start unavailable | integrations | `t:menu.test.ts` (import ×2) | A | — |
| C10 | AI menu extraction (PDF / photo → draft) | — (landing copy promises "Upload a PDF, a photo or a CSV") | input `accept=".csv,text/csv"` only (`menu/page.tsx:327`) | none | — | — | — | Gemini (B-8) | none | **C** (legacy `ai-imports.extractMenuDraft` implemented) | FT-08 |
| C11 | QR table ordering (dine-in) | scan `/t/<qr>` → session → menu → cart → order → status → requests → bill | `web:t/[qr]/page.tsx`, `web:t/[qr]/_guest/*` | `api:guest/guest.controller.ts:37-82` → `guest.service.ts`, `orders/visits.service.ts` | visits, orders, order_lines, service_requests (OPS) | public, visit bearer token (sha256) | 60-s undo, auto-close sweep, settling rule blocks orders during payment | kernel | `t:guest.test.ts` (×7), `t:public-surface.test.ts`, `s02`, `e2e:scenario-dine-in.spec.ts` | A | — |
| C12 | Counter / single venue QR (takeaway, cloud kitchen) | — | — | — | no `service_mode` / venue token | — | — | — | none | **C** (legacy `server.js:88,154,178`) | FT-07 |
| C13 | Pickup & delivery web ordering | `/order/<slug>` → quote → place (pay at pickup / COD / online) → `/order/<slug>/track/<ref>` | `web:order/[slug]/page.tsx`, `web:order/[slug]/track/[ref]/page.tsx` | `guest.controller.ts:100-123` → `guest.service.ts:webOrder` | orders (OPS) | public; Idempotency-Key required | stale price 409 (`expectedTotalMinor`); online needs CHECKOUT_PORT | pay, kernel | `t:orders.test.ts` (website ×2), `t:web-attribution.test.ts` | A·C (no opening-hours check, no delivery area/radius check, no delivery ETA on tracking page) | FT-09, FT-14 |
| C14 | Staff orders, state machine, cancel, cash collect | orders page | `web:dashboard/[orgId]/orders/page.tsx` | `api:orders/orders.controller.ts:22-67` → `orders.service.ts`, `kernel/orders-kernel.service.ts` | orders, order_events | orders:read/write/status/cancel, payments:collect | refund required to cancel paid order; never collect above due | kernel ledger | `t:orders.test.ts` (×5), `t:kernel.test.ts` | A | — |
| C15 | Reservations: availability, 5-min holds, overlap, deposit, manage link, check-in, no-show | `/reserve/<slug>` floor map → hold → confirm/pay → manage; staff day book | `web:reserve/[slug]/page.tsx`, `web:reserve/[slug]/manage/page.tsx`, `web:dashboard/[orgId]/reservations/page.tsx` | `api:reservations/reservations.controller.ts` → `reservations.service.ts`, `availability.ts` | reservations (OPS, exclusion constraint), x02 | reservations:read/write, floor:seat | hold-expiry job; deposit refund on cancel/visit close | pay | `t:reservations.test.ts` (×9), `t:deposit-refunds.test.ts`, `t:payments.test.ts` (deposits) | A·C (manage page cannot resume an unpaid deposit although `POST /public/payments/reservations/:code/checkout` exists; guest cannot modify a booking) | FT-11 |
| C16 | Floor Studio (schema v2 editor, QR sheet) | floor page Studio tab | `web:dashboard/[orgId]/floor/page.tsx`, `cmp:floor/FloorStudio.tsx`, `cmp:floor/QrSheet.tsx` | `api:floor/floor.controller.ts:21-53` → `floor.service.ts`, `floor-rules.ts` | floor_layouts, dining_tables (OPS) | floor:read / floor:write | 409 stale_layout, 409 table_in_use, 422 invalid_geometry | — | `t:floor.test.ts` (×7), `e2e:real-floor.spec.ts`, `e2e:floor.spec.ts` | A | — |
| C17 | Live floor / host (seat, close, clean, undo) | floor page Live tab | `cmp:floor/LiveFloor.tsx` | `orders.controller.ts:79-110` → `visits.service.ts` | visits, dining_tables | floor:seat | unpaid close needs force | — | `t:floor.test.ts` (live), `e2e:real-floor.spec.ts` (live ×2) | A | — |
| C18 | KDS (station filter, bump, recall, prep times) | full-screen board | `web:kitchen/[orgId]/page.tsx`, `_kds/KitchenBoard.tsx` | `api:kitchen/kitchen.controller.ts` → `kitchen.service.ts` | order_lines.kitchen_status (OPS, x02) | kitchen:operate | 2-s polling, no sound; driver hand-over rule | delivery | `t:orders.test.ts` (KDS), `t:delivery.test.ts` (hand-over ×2), `e2e:scenario-dine-in.spec.ts` | A (no 86 control on the KDS; `GET …/prep-times` has no UI) | FT-02 |
| C19 | Service requests (waiter call, bill request) | guest button → staff list → resolve | `t/[qr]/page.tsx`, `orders/page.tsx` | `guest.controller.ts:82`, `orders.controller.ts:61-67` | service_requests (OPS) | orders:read | deduplicated while open | — | `t:guest.test.ts` (dedupe) | A | — |
| C20 | Inventory: items, suppliers, movements, recipes, alerts, valuation, waste | inventory tabs | `web:dashboard/[orgId]/inventory/_parts/tabs.tsx` | `api:inventory/inventory.controller.ts` → `inventory.service.ts`, `stock-alerts.service.ts` | suppliers, inventory_items, stock_levels, stock_movements, recipe_components (OPS), stock_counts, stock_alerts (x03) | inventory:read / inventory:write | idempotent movements; no negative stock; paired transfers | kernel (recipe deduction) | `t:inventory.test.ts` (×14) | A (bulk `POST /stocktakes` and `PATCH /suppliers/:id` have no UI) | FT-25 |
| C21 | Customers (CRM): list, profile, consent history, export, anonymise, merge | customers pages | `web:dashboard/[orgId]/customers/page.tsx`, `…/[customerId]/page.tsx` | `api:customers/customers.controller.ts` → `customers.service.ts` | customers, customer_identities, customer_addresses (OPS), customer_consent_events (x03) | customers:read/write/export | audited export, formula-safe CSV | — | `t:customers.test.ts` (×11) | A | — |
| C22 | Analytics (sales, products/margins, customers, marketing, operations, sustainability, ROI) | analytics tabs, overview | `web:dashboard/[orgId]/analytics/*`, `web:dashboard/[orgId]/page.tsx` | `api:analytics/analytics.controller.ts` → `analytics.service.ts` | read models | analytics:read | branch-scoped | — | `t:analytics.test.ts` (×11) | A | — |
| C23 | Guest ratings / feedback after payment | — | — | — | no table | — | — | — | none | **C** (legacy `/api/rating` implemented) | FT-21 |

## 2. CONNECT (messaging)

| # | Feature | Workflow | Route / UI | Controller → service | Persistence | Permission / module | Failure & recovery | Deps | Tests | Status | Gap |
|---|---|---|---|---|---|---|---|---|---|---|---|
| N1 | Persistent conversations & unified inbox | inbox list/detail, filters, unread | `web:dashboard/[orgId]/inbox/page.tsx` | `api:connect/connect.controller.ts:50-98` → `conversations.service.ts` | conversations, messages (CMS) | connect:read/reply/manage, module `connect` | 24-h window badge | — | `t:connect.test.ts` (inbox access) | A (WhatsApp only) | FT-05 |
| N2 | WhatsApp Cloud API channel + webhook ingestion | channel form (phone number id, WABA) → signed webhook | inbox Channels tab | `connect/webhook.controller.ts` → `whatsapp-webhook.service.ts`; `channels.service.ts` | messaging_channels, webhook_inbox (CMS, INT) | connect:manage; public webhook with signature | bad signature rejected before parsing; dedupe; `connect.webhook-retry` job | integrations (`pkg:messaging/whatsapp-cloud.ts`) | `t:connect.test.ts` (webhook ×5), `pkg:messaging/whatsapp-cloud.test.ts` | A/B (B-4: Meta never exercised) | — |
| N3 | **Messenger / Instagram channels** | — | — | none (contracts `kind: z.literal('whatsapp')`, `packages/contracts/src/connect.ts:15,22`) | `messaging_channels.kind` check already allows `instagram`,`messenger` (CMS:10) | — | — | Meta Graph | none | **C** | FT-05 |
| N4 | Structured ordering (buttons → hosted menu → server-priced cart → COD / pay link) | bot flow + `/o/<token>` | `web:o/[token]/OrderingClient.tsx` | `connect/public-ordering.controller.ts` → `ordering.service.ts` | ordering_sessions (CMS) | public session token | idle expiry job tells customer; cancellable; tamper-proof cart | kernel, pay | `t:connect.test.ts` (×7), `s03`, `e2e:scenario-whatsapp.spec.ts` | A/B | — |
| N5 | Human handoff | "Take over" / "Resume bot" | inbox detail | `connect.controller.ts:74-80` → `handoff.service.ts` | handoffs (CMS) | connect:reply | bot paused until resolved | — | `t:connect.test.ts` (handoff) | A | — |
| N6 | Conversation assignment to a colleague | — (only "mine" filter after take-over) | none | `POST …/conversations/:id/assign` → `conversations.service.ts:226` | conversations.assigned_to | connect:manage | — | — | none | A·C (API without UI) | FT-12 |
| N7 | Templates (create, submit to Meta, status webhook) | Templates tab | inbox Templates | `connect.controller.ts:129-153` → `channels.service.ts:137` | message_templates (CMS) | connect:manage | sandbox marking without live connection; locked after submit | Meta | `t:connect.test.ts` (window/template), `pkg:…/whatsapp-cloud.test.ts` (status) | A/B | — |
| N8 | Confirmations & status notifications (order placed/paid/status, delivery on the way, reservation confirmed) | outbox handlers → `enqueueToCustomer` | — | `connect/connect-events.service.ts` → `messaging.service.ts` | messages | system | window/template fallback; `skipped` reasons | events | `t:connect.test.ts`, `s03` | A | — |
| N9 | Delivery / failure states | Meta status callbacks → `applyStatus`; sender retries with backoff (6 attempts) | message status label in inbox | `messaging.service.ts:175-241` | messages.status/attempts/error | — | final `failed` after 6 attempts | — | `t:connect.test.ts` | A | — |
| N10 | Recovery (manual resend of failed messages) | — | no button | no route | — | — | failed messages stay failed | — | none | **C** | FT-12 |

## 3. PAY (ResutoPay)

| # | Feature | Workflow | Route / UI | Controller → service | Persistence | Permission / module | Failure & recovery | Deps | Tests | Status | Gap |
|---|---|---|---|---|---|---|---|---|---|---|---|
| P1 | Hosted checkout | `/pay/<token>` → start → provider / sandbox → webhook → ledger | `web:pay/[token]/page.tsx`, `…/sandbox/page.tsx` | `api:payments/public.controller.ts:33-67` → `checkout.service.ts` | checkout_sessions, payments, payment_attempt_refs (PDFC, x05) | public token (sha256 + sealed) | expiry job; method switch supersedes; declined → retry | kernel ledger | `t:payments.test.ts` (×7) | A/B (B-3) | — |
| P2 | Payment links (staff, MCP) | payments page "New link" | `web:dashboard/[orgId]/payments/page.tsx` | `staff.controller.ts:68-81` → `staff-payments.service.ts` | checkout_sessions | payments:collect | cancel link | — | `t:payments.test.ts` (links) | A (but reachable by MCP keys without approval — see M4) | FT-01 |
| P3 | QR table bill payment & split (equal/custom/by item), share links | `/t/<qr>/pay`, `/t/<qr>/pay/split`, `/s/<token>` | `web:t/[qr]/pay/*`, `web:s/[token]/page.tsx` | `public.controller.ts:74-121` → `bills.service.ts` | bill_splits, bill_shares (PDFC) | visit/share bearer | overpayment race blocked | kernel | `t:payments.test.ts` (×5), `e2e:scenario-dine-in.spec.ts` | A | — |
| P4 | Reservation deposits | hold → confirm → checkout → webhook confirms | `reserve/[slug]/page.tsx:102-106` | `reservations.service.ts:250`, `public.controller.ts:127` | reservations.deposit_status | public token | expiry/cancel refunds | reservations | `t:payments.test.ts` (×2), `t:deposit-refunds.test.ts` | A·C (no resume from manage page) | FT-11 |
| P5 | COD | web / WhatsApp COD → driver collects through ledger | driver app | `driver-app.service.ts` deliver | payments method `cod` | delivery:drive | — | delivery | `t:delivery.test.ts` (COD), `e2e:scenario-driver.spec.ts` | A | — |
| P6 | Provider payment records + verified transitions | signed webhooks → ledger; amount mismatch → alert | payments list/detail | `public.controller.ts:143` → `webhooks.service.ts`, `kernel/payment-ledger.service.ts` | payments, payment_allocations (KER), payment_alerts (x05) | public webhook, signature per provider | duplicate = no-op; mismatch alert; retry job | `pkg:payments/*` | `t:payments.test.ts`, `t:kernel.test.ts` (ledger ×3), `pkg:payments/payments.test.ts` | A/B | — |
| P7 | Refunds (provider / manual with instructions) | payment detail → refund → complete | `web:dashboard/[orgId]/payments/[paymentId]/page.tsx` | `staff.controller.ts:88-94,161` → `staff-payments.service.ts:200-290` | refunds (PDFC) | payments:refund | ledger only after provider success | providers | `t:payments.test.ts` (×2) | A/B | — |
| P8 | Cash / InstaPay / bank transfer collection | payments page Collect modal (staff-attested) | `payments/page.tsx:33,47` | `staff.controller.ts:46-60` | payments (provider `manual`) | payments:collect | never above due | — | `t:payments.test.ts`, `t:orders.test.ts` (collect) | A | — |
| P9 | Reconciliation (provider records, settlement CSV, cash count) | payments page reconciliation | `payments/page.tsx` | `staff.controller.ts:116-147` → `reconciliation.service.ts` | reconciliation_runs/items (PDFC) | payments:reconcile | item resolution | providers | `t:payments.test.ts` (×2) | A/B | — |

## 4. MARKETING / CRM / LOYALTY

| # | Feature | Workflow | Route / UI | Controller → service | Persistence | Permission / module | Failure & recovery | Deps | Tests | Status | Gap |
|---|---|---|---|---|---|---|---|---|---|---|---|
| K1 | Profiles & consent history | see C21 | | | customer_consent_events (x03) | | append-only | | `t:customers.test.ts` | A | — |
| K2 | Segmentation (DSL → parameterised SQL) | Segments tab preview/save/refresh | `web:dashboard/[orgId]/marketing/page.tsx:81-102` | `marketing.controller.ts:34-66` → `segments.service.ts`, `segment-sql.ts` | segments, segment_members (CMS) | marketing:read/write, module `marketing` | injection attempts bound | — | `t:marketing.test.ts` (×3) | A | — |
| K3 | Offers (promotions applied by pricing) | Promotions tab | `marketing/page.tsx:269-284` | `marketing.controller.ts:71-85` → `promotions.service.ts`; `kernel/pricing.service.ts:148-160` | promotions, promotion_redemptions (CMS) | marketing:write | per-customer limit skipped when guest has no customer id (`kernel/pricing.service.ts:181`) | kernel | `t:marketing.test.ts`, `t:kernel.test.ts` | A | — |
| K4 | Campaign drafts → approval → schedule/send, consent filtering | Campaigns tab | `marketing/page.tsx:145-240` | `marketing.controller.ts:90-152` → `campaigns.service.ts` | campaigns, campaign_deliveries (CMS) | marketing:write / marketing:approve | approved content locked (`campaigns.service.ts:103`); dispatcher job | connect | `t:marketing.test.ts` (×4), `s05` | A (per-campaign `GET …/deliveries` has no UI) | — |
| K5 | **Loyalty (earning, redemption rules, auditable ledger)** | — | — | — | **no tables** (grep `loyalty` = 0 hits in apps/packages/supabase) | — | — | — | none | **C** | FT-03 |
| K6 | Tracking links & attribution (web + WhatsApp, last touch) | Links tab → `/l/<code>` | `marketing/page.tsx:332-338` | `marketing.controller.ts:157-184` → `links.service.ts`, `marketing-events.service.ts` | tracking_links, attribution_events (CMS) | marketing:write; public click | sandbox excluded from ROI | analytics | `t:marketing.test.ts`, `t:web-attribution.test.ts` | A | — |
| K7 | Reporting (campaign report, analytics marketing) | report modal, analytics tab | `marketing/page.tsx:242` | `marketing.controller.ts:148` | ad_campaign_reports (CMS) | marketing:read | disclaimer non-incremental | — | `t:analytics.test.ts`, `t:marketing.test.ts` | A | — |
| K8 | Ad platform campaigns (Meta/TikTok/Snap) | launch / import insights | Campaigns tab | `campaigns.service.ts` → `pkg:ads/*` | ad_campaign_reports | marketing:write | sandbox rows never cost | providers | `t:marketing.test.ts`, `pkg:ads/ads.test.ts` | A/B (B-5) | — |
| K9 | Connection health | integrations page "Check" | `web:dashboard/[orgId]/integrations/page.tsx:129-159` | `integrations.controller.ts:87` → `connections.service.ts:205` | integration_connections.health | integrations:manage | manual only; payment/accounting adapters have no `healthCheck` | — | `t:integrations.test.ts` (health) | A·C (no scheduled checks) | FT-26 |
| K10 | SMS / email campaign channels | selectable, refused with `channel_unavailable` | `marketing/page.tsx` | `campaigns.service.ts:175` | — | — | honest refusal | — | `t:marketing.test.ts` | C (labelled; no provider) | FT-27 |
| K11 | Marketing recommendations (deterministic) → draft | Recommendations tab | `marketing/page.tsx:379-381` | `recommendations.service.ts` | campaigns | marketing:write | — | — | `t:marketing.test.ts` | A | — |

## 5. DRIVER (ResutoDriver)

| # | Feature | Workflow | Route / UI | Controller → service | Persistence | Permission / module | Failure & recovery | Deps | Tests | Status | Gap |
|---|---|---|---|---|---|---|---|---|---|---|---|
| D1 | Driver portal (mobile web) | `/driver` jobs, job detail, cash, history | `web:driver/**` | `api:delivery/delivery.controllers.ts:110-208` → `driver-app.service.ts` | drivers, delivery_jobs (PDFC) | delivery:drive, module `driver` | idempotent actions | — | `t:delivery.test.ts`, `e2e:scenario-driver.spec.ts` | A | — |
| D2 | Invitations | dispatch Drivers tab → invite (role driver) → accept creates driver | `web:dashboard/[orgId]/delivery/_components/Drivers.tsx` | `platform.controller.ts:70`, `organizations.service.ts:252` | invitations, drivers | members:manage / delivery:dispatch | link shared manually | platform | `t:delivery.test.ts`, `e2e:scenario-driver.spec.ts` | A | FT-06 |
| D3 | Availability & devices | toggle on/off shift; device registration | `driver/page.tsx:27` | `delivery.controllers.ts:116-128` | drivers.availability, driver_devices | delivery:drive | — | — | `t:delivery.test.ts` (devices) | A (devices registered but **no push sender**) | FT-22 |
| D4 | Dispatch (offers, expiry, assign, unassign, cancel, OTP) | dispatch board | `delivery/_components/Board.tsx`, `JobModal.tsx` | `delivery.controllers.ts:27-97` → `delivery.service.ts` | delivery_offers, delivery_events | delivery:dispatch | offer expiry job (30 s) | orders | `t:delivery.test.ts` (×3) | A | — |
| D5 | Pickup → en route → deliver with photo proof / OTP; fail | job page | `driver/jobs/[jobId]/page.tsx` | `delivery.controllers.ts:180-208` | delivery_jobs.proof_* | delivery:drive | requires ready order; failure reason | storage | `t:delivery.test.ts` (×2), `e2e:scenario-driver.spec.ts` | A | — |
| D6 | Cash collection & settlement | driver Cash page; dispatcher Cash tab settles | `driver/cash/page.tsx`, `delivery/_components/Cash.tsx` | `delivery.controllers.ts:91-97,141` | driver_cash_settlements (PDFC) | delivery:dispatch | via ledger | kernel | `t:delivery.test.ts` (COD/settlement) | A | — |
| D7 | History | driver history page | `driver/history/page.tsx` | `delivery.controllers.ts:153` | delivery_jobs | delivery:drive | cursor pagination | — | `t:delivery.test.ts` | A | — |
| D8 | Location & ETA | driver uploads fixes on shift → straight-line ETA on board/job | `driver/_lib/driver-context.tsx:123`, Board/JobModal | `driver-app.service.ts:100-130`, `delivery.service.ts:473` | driver_locations, delivery_jobs.eta_at | delivery:drive | rate-limited batches | maps | `t:delivery.test.ts` (locations) | A·C (no customer-facing ETA/tracking, no dispatcher map) | FT-14 |

## 6. STUDIO / STOREFRONT

| # | Feature | Workflow | Route / UI | Controller → service | Persistence | Permission / module | Failure & recovery | Deps | Tests | Status | Gap |
|---|---|---|---|---|---|---|---|---|---|---|---|
| S1 | Website editing (sections, add/edit/hide/reorder/delete) | Website → Sections | `web:dashboard/[orgId]/website/_components/EditorPanels.tsx:135-268` | `studio.controller.ts:25-61` → `studio.service.ts` | websites, website_sections (CMS) | studio:read/write, module `studio` | validation | — | `t:studio.test.ts` (editor ×3), `e2e:studio.spec.ts` | A | — |
| S2 | Publishing + revisions/restore | Publish, History | `WebsiteStudio.tsx` | `studio.controller.ts:67-79` → `site-builder.service.ts` | website_revisions (x09) | studio:publish | restore revision | — | `t:studio.test.ts` (publishing ×2), `e2e:studio.spec.ts` | A | — |
| S3 | Branding (theme, logo, hero, font) | Design tab | `EditorPanels.tsx:60-100` | `PATCH studio/website` | websites.theme | studio:write | — | media | `t:studio.test.ts` | A | — |
| S4 | Default URL `/r/<slug>` | public site | `web:r/[slug]/page.tsx` | `public-sites.controller.ts:27` → `public-sites.service.ts` | website_revisions | public | 404 for unknown slug | — | `t:studio.test.ts`, `e2e:studio.spec.ts` | A | — |
| S5 | Custom domain setup / TXT verification / status | Domains tab | `website/_components/DomainsPanel.tsx` | `studio.controller.ts:118-142` → `domains.service.ts`, `domain-provider.ts`; host routing `apps/web/middleware.ts` | custom_domains (CMS, x09) | studio:publish | manual provider never claims active | Vercel API (B-9) | `t:studio.test.ts` (domains ×4), `e2e:studio.spec.ts` | A/B | — |
| S6 | Media management | Media tab | `website/_components/MediaLibrary.tsx` | `studio.controller.ts:92-111` | media_assets | studio:write | delete only unused | storage | `t:studio.test.ts` (media) | A (originals only, no derivatives) | FT-04 |
| S7 | SEO metadata (title, description, OG, JSON-LD, canonical) | SEO tab | `EditorPanels.tsx:121-123`, `r/[slug]/page.tsx:11-40` | `PATCH studio/website` | websites.seo | studio:write | — | — | `t:studio.test.ts`, `e2e:studio.spec.ts`, `e2e:landing.spec.ts` | A | — |
| S8 | Menu imagery | product image upload; studio product picker | `menu/page.tsx:204` | `menu.controller.ts:90` | products.image_media_id | menu:write | 15 MB limit, no resize | storage | `t:menu.test.ts` (image) | A | — |
| S9 | AI creative (copy) | Creative tab: brief → variants → approve/reject → **copy to clipboard** | `website/_components/CreativePanel.tsx` (screenshot `shots/studio-creative-text-only.png`) | `studio.controller.ts:149-165` → `creative.service.ts`, `creative-generator.ts` | creative_assets (CMS) | studio:write | labelled template fallback without `GEMINI_API_KEY` | Gemini (B-8) | `t:studio.test.ts` (creative) | A/B (text only; "approved" is a flag with no apply/publish path) | FT-16 |
| S10 | **Food-photo enhancement pipeline (upload → job → review → approve → publish)** | — | — | none (`creative_assets.kind='image'` allowed in CMS:322 but never produced) | no job table | — | — | — | none | **C** | FT-04 |

## 7. FINANCE

| # | Feature | Workflow | Route / UI | Controller → service | Persistence | Permission / module | Failure & recovery | Deps | Tests | Status | Gap |
|---|---|---|---|---|---|---|---|---|---|---|---|
| F1 | Revenue overview, fees, reconciliation summary, insights | Finance page | `web:dashboard/[orgId]/finance/page.tsx` | `finance.controller.ts:30-56` → `finance.service.ts` | read models | finance:read, module `finance` | — | pay | `t:finance.test.ts` (×3), `s06` | A | — |
| F2 | Expenses with receipts, categories | Expenses page | `finance/expenses/page.tsx` | `finance.controller.ts:63-106` → `expenses.service.ts` | expenses, expense_categories (PDFC) | finance:write | audited delete | storage | `t:finance.test.ts` (expenses ×2) | A | — |
| F3 | COGS, P&L with methodology and cost coverage | P&L page | `finance/pnl/page.tsx` | `finance.controller.ts:37` | read models | finance:read | coverage flagged | menu costs | `t:finance.test.ts` (P&L), `t:analytics.test.ts` (margins) | A | — |
| F4 | Exports with checksums | Exports page | `finance/exports/page.tsx` | `finance.controller.ts:113-125` → `exports.service.ts` | financial_exports (PDFC, x05) | finance:read | byte-for-byte download | — | `t:finance.test.ts` (exports) | A | — |
| F5 | Balanced journals + accounting push (Wafeq/Qoyod/Odoo) | Exports page journal + push | `finance/exports/page.tsx` | `finance.controller.ts:137-149` → `accounting.service.ts:30-105`, `pkg:accounting/index.ts` | accounting_pushes (x05) | finance:write | failed pushes recorded honestly | providers (B-7) | `t:finance.test.ts` (journals), `pkg:accounting/accounting.test.ts` | A/B·C (journals cover sales/VAT/refunds only: no expenses, payment fees, COGS, delivery income; account mapping only via raw config) | FT-23 |

## 8. COMPLIANCE

| # | Feature | Workflow | Route / UI | Controller → service | Persistence | Permission / module | Failure & recovery | Deps | Tests | Status | Gap |
|---|---|---|---|---|---|---|---|---|---|---|---|
| L1 | Tax profiles (EG / SA validation) | Tax profile tab | `web:dashboard/[orgId]/compliance/_components/TaxProfileForm.tsx` | `compliance.controller.ts:63-69` → `tax-profile.service.ts` | tax_profiles (PDFC) | compliance:read/write, module `compliance` | country rules | — | `t:compliance.test.ts` (×2) | A | — |
| L2 | Invoices / receipts on `order.paid`, credit notes on refund, lifecycle, immutability, hash chain | Fiscal documents tab | `compliance/_components/FiscalDocuments.tsx` | `compliance.controller.ts:76-118` → `fiscal.service.ts`, `compliance.handlers.ts` | fiscal_counters, fiscal_documents, government_submissions (PDFC, x06) | compliance:read/write | immutable except status; counters unique under concurrency | kernel events | `t:compliance.test.ts` (×5) | A | — |
| L3 | Licences with expiry tracking | Licences tab | `compliance/_components/Licences.tsx` | `compliance.controller.ts:125-156` → `licences.service.ts` | compliance_documents (PDFC) | compliance:write | files stored | storage | `t:compliance.test.ts` (licences) | A | — |
| L4 | **Expiry reminders** | job marks reminder `sent` and publishes `compliance.document_expiring` | UI says "Reminders are sent 30, 7 and 1 days before expiry" (`shots/compliance-licences-reminders.png`) | `licences.service.ts:168-199` | compliance_reminders | system | **no consumer** for the event (`grep -rn "@OnDomainEvent" apps/api/src/modules` lists 15 handlers, none for this event; same for `stock.low`, `mcp.approval_requested`, `member.invited`) — nobody is notified | notifications | `t:compliance.test.ts` (asserts the row/outbox only) | **C** (A-claim broken) | FT-06 |
| L5 | Regulator adapters (ZATCA Phase-1 QR; Phase-2 signing/clearance; ETA submission) | resubmit button | FiscalDocuments | `fiscal.service.ts` → `pkg:tax/zatca.ts`, `pkg:tax/eta.ts` | government_submissions | compliance:write | `sandbox_stub` mode labelled | ZATCA / ETA (B-6) | `pkg:tax/tax.test.ts`, `t:compliance.test.ts` | B·C (Phase-2 `sign()` is an interface only, `zatca.ts:172`; ETA submit is a stub, `eta.ts:163-173`) / D (certification not claimed) | FT-24 |

## 9. INTELLIGENCE

| # | Feature | Workflow | Route / UI | Controller → service | Persistence | Permission / module | Failure & recovery | Deps | Tests | Status | Gap |
|---|---|---|---|---|---|---|---|---|---|---|---|
| I1 | Demand forecasting (seasonal naive / MA / GBM, intervals, backtest) | Forecast tab | `web:dashboard/[orgId]/intelligence/forecast/page.tsx` | `intelligence.controller.ts:47` → `intelligence.service.ts`, `ai-client.service.ts` → `apps/ai-service` | ai_predictions, ai_models (IM, x07) | ai:use, module `intelligence` | 503 when AI service is down; baseline fallback with reason | ai-service | `t:intelligence.test.ts` (×3), `apps/ai-service/tests/*` | A (synthetic evaluation only) | — |
| I2 | Customer intelligence (RFM, churn) | Customers tab | `intelligence/customers/page.tsx` | `intelligence.controller.ts:54-67` | — | ai:use + customers:read | heuristic labelled | ai-service | `t:intelligence.test.ts` (×2) | A | — |
| I3 | Recommendations (owner: frequently bought with) | Recommendations tab | `intelligence/recommendations/page.tsx` | `intelligence.controller.ts:74` | — | ai:use | excludes unavailable | ai-service | `t:intelligence.test.ts` | A | — |
| I4 | Guest-facing menu assistant / upsell suggestions | — | none in `t/[qr]`, `order/[slug]`, `o/[token]` | none | — | — | — | — | none | **C** (legacy `/api/recommend`, `/api/suggest` implemented) | FT-20 |
| I5 | Insights & anomalies (deterministic + model) | Insights tab, refresh, status | `intelligence/page.tsx` | `intelligence.controller.ts:103-117` → `insights.service.ts` | ai_insights (IM) | ai:use | dedupe; scheduled hourly | — | `t:intelligence.test.ts` (×4) | A·C (title/body stored and rendered in **English only**, evidence shown as raw JSON — `intelligence/page.tsx:60-65`, `shots/intelligence-insights-ar-english-body.png`) | FT-15 |
| I6 | Owner assistant (rules mode, Gemini function calling) | Assistant tab | `intelligence/assistant/page.tsx` | `intelligence.controller.ts:123-145` → `assistant.service.ts`, `assistant-tools.ts` | assistant_threads/messages (IM) | ai:use | grounded-number check | Gemini (B-8) | `t:intelligence.test.ts` (×8) | A/B | — |
| I7 | Model metadata, evaluation, labelled modes, research registry | Research tab, badges | `intelligence/research/page.tsx` | `intelligence.controller.ts:165` → `registry.service.ts` | ai_models, ai_evaluations (IM, x07) | ai:use | synthetic-data labels | research | `t:intelligence.test.ts` (registry) | A | — |
| I8 | Route planning (NN + 2-opt) | Routes tab | `intelligence/routes/page.tsx` | `intelligence.controller.ts:82-96` | — | ai:use + delivery:dispatch | — | ai-service | `t:intelligence.test.ts` (×3) | A | — |
| I9 | Copy generation API | **no UI** (`POST /intelligence/generate-copy`) | — | `intelligence.controller.ts:159` → `copy.service.ts` | usage_events | ai:use | template fallback | Gemini | `t:intelligence.test.ts` | A·C (API-only; overlaps Studio creative) | FT-16 |
| I10 | AI usage limits per plan | plan shows "AI requests / month" | `web:pricing/PricingView.tsx:55,168`, billing usage | `ai-client.service.ts:77` meters only | usage_events | — | **limit never enforced** (`plan-limits.service.ts` checks orders only) | billing | none | **C** | FT-10 |

## 10. MCP (ResutoMCP)

| # | Feature | Workflow | Route / UI | Controller → service | Persistence | Permission / module | Failure & recovery | Deps | Tests | Status | Gap |
|---|---|---|---|---|---|---|---|---|---|---|---|
| M1 | Secure connectivity (client keys shown once, hashed; Streamable HTTP + stdio server) | MCP → New client → key; `apps/mcp-server` | `web:dashboard/[orgId]/mcp/{new,connect,clients/[clientId]}` | `mcp.controller.ts:20-63` → `mcp-clients.service.ts`; `mcp-runtime.controller.ts` | mcp_clients (IM, x08) | mcp:manage, module `mcp` | revoke/expiry 401 | — | `t:mcp.test.ts` (keys ×5), `s08` | A (no OAuth 2.1 for remote connectors) | FT-17 |
| M2 | Authorised queries / actions with schemas (17 tools) | tool list filtered by allowlist, role, entitlement | — | `mcp/tools/{read-tools,action-tools,registry}.ts` → `mcp-execution.service.ts` | mcp_tool_calls | acting role + allowed_tools | per-client & per-tool rate limits | ports | `t:mcp.test.ts` (×11) | A·C (no menu/finance/payments/delivery tools; `update_product_availability` needs product ids no tool returns except top items) | FT-17 |
| M3 | Approvals bound to the exact action | sensitive tool → approval with stored input + hash → human approves → executes once | `mcp/approvals/page.tsx` | `mcp-execution.service.ts:199-358` | mcp_approvals | mcp:approve + tool permission | expire job; revocation closes pending | — | `t:mcp.test.ts` (approvals ×5) | A (for the tool path) | — |
| M4 | **Bounded access / audit / revocation across all routes** | MCP key on REST routes | — | `common/auth/access.guard.ts:44-47` lets `rmcp_` keys call any `@AllowMcp()` route (36 outside `mcp/`) | — | role permission only; **allowed_tools, approvals and mcp_tool_calls bypassed** | probe: key allowed only `list_orders` → `POST /payments/links` 201 with URL, `POST /menu/products/:id/availability` 201, `POST /orders/:id/transition` 201; nothing in `mcp_approvals`; only the denied tool call logged | — | `t:mcp.test.ts:382-384` checks only `/mcp/clients` and `/members` | **C** (security/integrity) | FT-01 |
| M5 | Calls log, usage, revocation | Calls page, client detail | `mcp/calls/page.tsx`, `mcp/clients/[clientId]/page.tsx` | `mcp.controller.ts:50-84` | mcp_tool_calls, usage_events | mcp:manage | — | billing | `t:mcp.test.ts` (audit/usage) | A | — |

## 11. PLATFORM

| # | Feature | Workflow | Route / UI | Controller → service | Persistence | Permission / module | Failure & recovery | Deps | Tests | Status | Gap |
|---|---|---|---|---|---|---|---|---|---|---|---|
| X1 | Auth (dev issuer local; Supabase JWKS deployed) | login / signup | `web:(auth)/*` | `auth.controller.ts`, `common/auth/*` | profiles (FND) | — | dev auth refused in staging | Supabase | `t:platform.test.ts` (auth ×3), `t:deployment-config.test.ts` | A | — |
| X2 | Tenancy, RLS, roles (10 × 46), branch scope, audit | everywhere | `web:dashboard/[orgId]/audit/page.tsx` | `common/auth/access.guard.ts`, `common/db/db.service.ts` | memberships, audit_logs (FND) | role matrix | cross-tenant 404 | — | `t:platform.test.ts`, `s09`, `supabase/tests/rls.test.mjs` | A | — |
| X3 | Onboarding | see C1/C2 | | | | | | | | A·C | FT-13 |
| X4 | Platform admin (tenants, suspend, overrides, prices, operations) | `/admin/**` | `web:admin/**` | `admin.controller.ts` → `admin.service.ts`, `tenant-status.service.ts` | platform_admins, entitlement_overrides (FND, BIL) | platform role | audited | — | `t:admin.test.ts` (×10) | A | — |
| X5 | Integrations framework (catalog, encrypted credentials, OAuth, sync runs, conflicts, logs) | Integrations page | `web:dashboard/[orgId]/integrations/page.tsx` | `integrations.controller.ts` → `connections.service.ts`, `sync.service.ts`, `oauth.service.ts` | integration_* (INT, x04) | integrations:manage | 429 back-off; credentials never returned | providers (B-7) | `t:integrations.test.ts` (×10), `pkg:pos/pos.test.ts` | A/B | — |
| X6 | Packages, Free QR tier, Build Your Resuto, EG/SA pricing, monthly/annual, plan comparison | `/pricing`, billing page | `web:pricing/PricingView.tsx`, `web:dashboard/[orgId]/billing/page.tsx` | `billing.controller.ts:25-73` → `catalog.service.ts`, `subscriptions.service.ts` | plans, plan_modules, plan_prices, module_prices (BIL, REF) | public / billing:manage | price history kept | — | `t:billing.test.ts` (×10), `s10` | A | — |
| X7 | Entitlements & plan limits (modules 402; branches, staff, monthly orders) | ModuleGate + guard | `cmp:shell/DashboardShell.tsx` | `common/entitlements`, `billing/plan-limits.service.ts` | subscriptions, subscription_modules, entitlement_overrides | — | 402 with reason | — | `t:billing.test.ts`, `s10`, `e2e:scenario-owner.spec.ts` | A·C (AI-requests limit displayed but not enforced) | FT-10 |
| X8 | Subscriptions lifecycle (trial → past_due → unpaid, scheduled downgrade, cancel/resume) | billing page | billing page | `lifecycle.service.ts`, `subscriptions.service.ts` | subscriptions, subscription_events, platform_invoices (BIL) | billing:manage | job every 300 s | — | `t:billing.test.ts` (×7) | A·C (**no collection**: invoices stay drafts, nothing is charged) | FT-18 |
| X9 | Usage metering | billing usage | billing page | `usage.service.ts` | usage_events (BIL, x01) | — | idempotent by source_ref | — | `t:billing.test.ts`, `t:intelligence.test.ts`, `t:mcp.test.ts` | A (orders, ai_requests, mcp_calls only) | FT-19 |
| X10 | Platform fees separate from messaging / ads / payment / AI costs | pricing copy "provider fees are not part of the subscription" (`apps/web/lib/i18n/dict/platform.ts:558`) | pricing page | `usage_events.cost_owner/external_cost_minor` exist; only `ai-client.service.ts:77` writes `cost_owner` | usage_events | — | — | — | none | A·C (disclosure only; no per-tenant pass-through cost ledger/view) | FT-19 |
| X11 | Staff / owner notifications (in-app + email/WhatsApp) | — | no bell / notification centre in `DashboardShell` | consumers missing for `compliance.document_expiring`, `stock.low`, `mcp.approval_requested`, `member.invited` | no table | — | — | connect, email | none | **C** | FT-06 |

---

## API routes with no UI caller (verified by hand after `scripts/unused.mjs`)

| Route | Notes | Gap |
|---|---|---|
| `POST /o/:orgId/connect/conversations/:id/assign` | assignment to a colleague | FT-12 |
| `POST /public/payments/reservations/:code/checkout` | resume unpaid deposit | FT-11 |
| `POST /o/:orgId/intelligence/generate-copy` | copy generation (also Studio creative) | FT-16 |
| `GET /o/:orgId/kitchen/:branchId/prep-times` | prep-time stats | (P2 polish, no item) |
| `GET /o/:orgId/marketing/campaigns/:id/deliveries` | per-recipient delivery list | (P2 polish, no item) |
| `POST /o/:orgId/inventory/stocktakes`, `PATCH /o/:orgId/inventory/suppliers/:id` | bulk count, supplier edit | FT-25 |
| `GET /o/:orgId/integrations/sync-runs/:runId` | run detail | (minor) |
| every non-runtime `@AllowMcp()` route (36) | reachable by MCP keys, not used by `apps/mcp-server` (`apps/mcp-server/src/api.ts:76-88` calls only `/mcp/whoami`, `/mcp/tools`, `/mcp/tools/:tool`) | FT-01 |

## UI that is decorative or self-asserted

| Where | What the UI implies | What the code does | Gap |
|---|---|---|---|
| Settings launch checklist | progress toward launch | "Mark done" stores a timestamp; nothing checks data | FT-13 |
| Compliance licences | "Reminders are sent 30, 7 and 1 days before expiry" | reminder row → `sent`, outbox event with no consumer | FT-06 |
| Pricing / billing "AI requests per month" | a plan limit | metered, never enforced | FT-10 |
| Studio creative "Approve" | approved copy gets used | status flag; output only copyable | FT-16 |
| Branch "delivery radius" | delivery area limit | stored, never read | FT-09 |
| Driver devices | push-ready driver app | rows stored, no sender; 10-s polling | FT-22 |
| Landing "Upload a PDF, a photo or a CSV" | AI menu extraction | CSV only | FT-08 |

## Template-mode masquerading as AI

None found unlabelled: Studio creative shows "Template fallback · not AI" (`apps/web/lib/i18n/dict/studio.ts:92`), the
assistant shows "rules mode" (`intelligence/assistant/page.tsx:66-79`), insights carry `method` badges. The gap is
scope, not labelling: the owner's "AI creative / food-photo enhancement" is an image pipeline, and only text copy exists
(FT-04, FT-16).

## Probe evidence (verbatim excerpt of `probes/probe-output.txt`)

MCP client created with `actingRole: 'manager', allowedTools: ['list_orders']` on a fresh `pro` tenant:

```
"toolCreatePaymentLink": { "status": 403, "code": "tool_not_allowed" },
"restCreatePaymentLink": { "status": 201, "hasUrl": true },
"restAvailability": { "status": 201, ... "available": false },
"restTransition": { "status": 201, "to": "accepted" },
"mcpToolCallsRecorded": [ { "tool": "create_payment_link", "outcome": "denied", "via": "mcp" } ],
"approvals": [],
"checkoutSessions": [ { "purpose": "payment_link", "channel": "staff", "status": "open" } ],
"publicMenuBefore": [ "Smash burger:true", "Soda:true", "Limited special:true" ],
"publicMenuAfter86Burger": [ "Soda:true", "Limited special:true" ],
"productBranchSettingsColumns": [ "org_id","product_id","branch_id","is_available","price_override_minor","stock_qty","updated_at" ]
```

("Fries" is already absent before the 86 test because the MCP key "86"-ed it through REST moments earlier.)

## Cross-reference: Arabic numbering

On the audited branch `ar-EG` without `-u-nu-latn` remains in ~20 places (e.g. `apps/api/src/modules/connect/connect-events.service.ts:105`,
`apps/web/lib/format.ts:8,11`, `packages/contracts/src/money.ts:29`), so the Arabic UI shows Eastern Arabic digits
(`shots/intelligence-insights-ar-english-body.png`). Branch `lead/p0-digits` (`d660d21`, `6b7e45b`) fixes this with
`packages/contracts/src/locale-format.ts` + a guard test; it is not merged into the audited branch. Not a features-audit item.
