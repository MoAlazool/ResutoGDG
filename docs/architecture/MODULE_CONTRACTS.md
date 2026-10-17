# Module contracts and ownership

Resuto 2.0 is a **modular monolith**: one NestJS API process (plus a worker
process from the same codebase), one PostgreSQL database, strict module
boundaries. This document is the coordination contract for the human team and
for parallel AI agents. If code and this document disagree, fix one of them in
the same change.

## 1. Golden rules

1. **One owner per file.** Only the owning agent/module edits a file. The lead
   owns everything not listed below (`apps/api/src/common`, `apps/api/src/modules/{kernel,auth,platform,system}`,
   `domain-modules.ts`, app shells, root config, existing migrations).
2. **Writes go to owned tables only.** Any module may *read* any tenant table
   inside a tenant-scoped transaction (read models for analytics, AI and MCP).
   Writes to another module's tables go through that module's exported service,
   the kernel, or an outbox event. The only exceptions are listed in §5.
3. **All tenant data access goes through `DbService.scoped(ctx, …)`** (or
   `withTenant(orgId, …)` for guests/webhooks/jobs). `withPlatform` is only for
   resolving a tenant from a public identifier (slug, QR token, checkout token,
   domain, provider webhook id) and platform administration. Never return data
   from a platform-context query without first scoping it to the resolved tenant.
4. **Money is integer minor units** with an explicit currency. Use
   `@resuto/contracts` money helpers. Never `float` money; never trust client totals.
5. **Validate every input with a Zod schema from `@resuto/contracts`** (`@Body(zod(schema))`).
6. **Authorization is declarative**: `@RequirePermission(...)` on every tenant
   route (path contains `:orgId`), `@RequiresModule(...)` for paid modules,
   `ctx.assertBranch(branchId)` for branch-scoped resources, `@AllowMcp()` only
   on routes MCP clients may call, `@Public()` only for guest/webhook routes.
7. **Mutations that clients may retry take an idempotency key** (`IdempotencyService.run`).
8. **State changes emit audit logs and/or outbox events in the same transaction.**
9. **Never fabricate.** Sandbox adapters are labelled `sandbox`/`simulated`;
   synthetic datasets are labelled synthetic; no fake metrics, customers,
   testimonials, approvals or provider status.
10. **Tests are real**: integration tests hit the API against the migrated local
    Postgres (`pnpm db:up`). No skipped tests, no mocked database.

## 2. Shared kernel and common services (lead-owned; call, don't copy)

| Service | Import | Purpose |
|---|---|---|
| `DbService` | `common/db/db.service` | `scoped(ctx, fn)`, `withTenant(orgId, fn, actor)`, `withPlatform(fn)`; `Tx.query/one/maybeOne` |
| `TenantContext` | `common/auth/context` | `orgId, role, branchIds, userId, actorType, actorId, can(), require(), assertBranch()`; `TenantContext.system(orgId)` for jobs/webhooks |
| `AuditService.record(tx, ctx, entry)` | `common/platform/audit.service` | append-only audit |
| `OutboxService.publish(tx, orgId, event)` | `common/platform/outbox.service` | domain events (`DOMAIN_EVENTS` in contracts) |
| `IdempotencyService.run(tx, orgId, scope, key, payload, fn)` | `common/platform/idempotency.service` | exactly-once client retries |
| `EntitlementsService` | `common/entitlements` | `isEnabled/assert(orgId, module)`, `invalidate(orgId)` |
| `StorageService.put(tx, ctx, {...}) / signedUrl(path)` | `common/storage` | tenant media under `<org_id>/` |
| `SecretBox.sealJson/openJson` | `common/crypto/secret-box` | provider credentials (AES-256-GCM) |
| `WebhookInboxService.store / markProcessed / pending` | `common/platform/webhook-inbox.service` | dedupe + persist every provider webhook (after signature check) |
| `RateLimiter.hit(key, limit, windowMs)` | `common/http/rate-limiter` | per-IP / per-client limits on public endpoints |
| `@OnDomainEvent(name, ...types)`, `@Scheduled(name, seconds)` | `common/events/events` | worker-side reactions and periodic jobs |
| `PricingService.quote(tx, orgId, input)` | `modules/kernel` | the only pricing implementation |
| `OrdersKernelService.place / transition / resolveCustomer / event` | `modules/kernel` | every order is created and every status change made here |
| `PaymentLedgerService.recordSucceeded / createPending / confirm / fail / applyRefund / outstanding` | `modules/kernel` | the only writer of `orders.paid_minor/refunded_minor/payment_status`, `payment_allocations` |

Kernel behaviour is covered by `apps/api/test/kernel.test.ts`. If a module needs
a kernel change, describe it in your hand-off report; do not edit the kernel.

## 3. Ownership map

Migration files: each agent adds **new** files only, named
`supabase/migrations/<prefix><4 digits>_<module>_<what>.sql` (14-digit version),
e.g. Agent A's first file is `20261018010001_billing_usage.sql`. Never edit an existing migration. End every migration with
`select app.lockdown_public_grants();` and apply RLS with
`app.enable_tenant_rls('public.<table>', '<branch column or omit>')`.

| Agent | Scope | API modules (`apps/api/src/modules/…`) | Contracts (`packages/contracts/src/…`) | Web routes (`apps/web/app/…`) | Other | Migration prefix |
|---|---|---|---|---|---|---|
| **Lead** | architecture, kernel, auth, platform core, integration | `kernel`, `auth`, `platform`, `system`, `domain-modules.ts` | `common, money, modules, permissions, state-machines, events, platform` | `layout.tsx`, `(auth)`, `onboarding`, `dashboard/[orgId]/layout.tsx`, `components/shell`, `lib/*` (except `lib/i18n/dict/<module>.ts`) | root config, docs/architecture, `scripts/db` | `20261017…` |
| **A** Platform & billing | plans, pricing engine, subscriptions, usage, entitlements view, platform admin, legacy data migration, demo seed | `billing`, `admin` | `billing` (extend), `admin` | `pricing`, `admin/**`, `invite/[token]`, `dashboard/[orgId]/{billing,team,settings,audit}` | `tools/legacy-migration/**`, `scripts/db/seed.mjs`, `supabase/seeds/**` | `2026101801` |
| **B1** Restaurant operations | menu/modifiers/allergens/images/CSV import, floor API + QR, guest QR ordering, visits/bill/requests, staff orders, kitchen display, reservations | `menu`, `floor`, `guest`, `orders`, `kitchen`, `reservations` | `catalog, floor, orders, reservations` | `t/[qr]/**` (except `t/[qr]/pay/**`), `order/[slug]/**` (web pickup/delivery ordering), `reserve/[slug]/**`, `kitchen/[orgId]/**`, `dashboard/[orgId]/{orders,kitchen,reservations,menu}` | `lib/i18n/dict/core.ts` | `2026101802` |
| **B2** Insights & CRM | inventory, stock movements, recipes, customers/CRM, analytics & ROI, overview dashboard | `inventory`, `customers`, `analytics` | `inventory, customers, analytics` | `dashboard/[orgId]/page.tsx` (overview), `dashboard/[orgId]/{inventory,customers,analytics}` | `lib/i18n/dict/insights.ts` | `2026101803` |
| **C** Growth & integrations | Connect (channels, WhatsApp Cloud API + sandbox transport, webhook ingestion, inbox, structured ordering sessions, templates, handoff, retries), Marketing (segments, campaigns + approval, promotions CRUD, tracking links, attribution, Meta/TikTok/Snap ads adapters), integration framework (connections, encrypted credentials, health, sync runs/cursors/conflicts/logs, Foodics/Odoo POS menu import) | `connect`, `marketing`, `integrations` | `connect, marketing, integrations` | `o/[token]/**` (hosted ordering), `l/[code]` (tracking links), `dashboard/[orgId]/{inbox,marketing,integrations}` | `packages/integrations/src/{messaging,ads,pos}`, `lib/i18n/dict/{connect,marketing}.ts` | `2026101804` |
| **D1** ResutoPay & Finance | checkout sessions & payment links, hosted pay page, QR table-bill payment, split bills/shares, reservation deposits, COD confirmation, provider adapters (simulated, Paymob, Stripe, Moyasar), signed webhooks, refunds, reconciliation; finance (revenue, expenses, P&L, exports, accounting adapters Wafeq/Qoyod/Odoo) | `payments`, `finance` | `payments, finance` | `pay/[token]/**`, `s/[token]/**` (bill share), `t/[qr]/pay/**` (table bill payment), `dashboard/[orgId]/{payments,finance}` | `packages/integrations/src/{payments,accounting}`, `lib/i18n/dict/{pay,finance}.ts` | `2026101805` |
| **D2** ResutoDriver & Compliance | drivers, invitations, availability, dispatch, offers, driver web app, pickup/delivery/proof, cash collection & settlement, locations/ETA, device tokens; compliance (tax profile validation, fiscal documents with ZATCA/ETA structures, sandbox submissions, licences & expiry reminders) | `delivery`, `compliance` | `delivery, compliance` | `driver/**`, `dashboard/[orgId]/{delivery,compliance}` | `packages/integrations/src/{tax,maps}`, `lib/i18n/dict/{driver,compliance}.ts` | `2026101806` |
| **E1** Intelligence | Python FastAPI service (forecasting, customer intelligence/recommendations, delivery optimisation baselines, datasets, evaluation), API intelligence module (insights, owner assistant, creative generation proxy) | `intelligence` | `intelligence` | `dashboard/[orgId]/intelligence/**` | `apps/ai-service/**`, `research/**`, `lib/i18n/dict/intelligence.ts` | `2026101807` |
| **E2** ResutoMCP | MCP client keys, tool registry, approvals, audit, rate limits, MCP server app | `mcp` | `mcp` | `dashboard/[orgId]/mcp/**` | `apps/mcp-server/**`, `lib/i18n/dict/mcp.ts` | `2026101808` |
| **F** Frontend, Studio & QA | landing page port, design-system components, Floor Studio React port (UI for B1's floor API), restaurant website + custom domains + AI creative (Studio API), Playwright visual regression and E2E harness, accessibility | `studio` | `studio` | `page.tsx` (landing), `r/[slug]/**`, `middleware.ts`, `dashboard/[orgId]/{floor,website}`, `components/floor/**`, `components/landing/**` | `packages/ui/**`, `tests/e2e/**`, `tests/visual/**`, `lib/i18n/dict/{studio,platform}.ts` | `2026101809` |

`apps/web/lib/nav.ts` already lists every dashboard route. `DashboardShell` wraps
every dashboard page; use `useOrg()`, `useApi()`, `useSession()`, `useT()` and
`<ModuleGate module=…>` from the shell, and `@resuto/ui` components.

## 4. Cross-module interfaces

Exported services are bound to injection tokens in `apps/api/src/modules/kernel/ports.ts`
(`CHECKOUT_PORT`, `MESSAGING_PORT`, `SEGMENTS_PORT`, `CAMPAIGNS_PORT`, `ORDERS_QUERY_PORT`).
The owner implements the interface, makes its module `@Global()` and provides
`{ provide: TOKEN, useExisting: Service }` + exports the token. Consumers inject
`@Optional() @Inject(TOKEN)` and call `requirePort(port, 'Name')`. Do not import
another agent's service file directly.

Exported services (owner implements exactly this signature; consumers call it):

| Exporter | Signature | Consumers |
|---|---|---|
| D1 `CheckoutService` | `createSession(tx, ctx, { purpose: 'order' \| 'visit_bill' \| 'bill_share' \| 'reservation_deposit' \| 'payment_link', orderId?, visitId?, shareId?, reservationId?, amountMinor?, allowedMethods?: PaymentMethod[], channel: 'web' \| 'qr' \| 'whatsapp' \| 'staff' \| 'mcp', returnUrl?, customerId?, expiresInMinutes? }) → { id, token, url, amountMinor, currency, expiresAt }` — amount defaults to what is due; URL is `${APP_ORIGIN}/pay/<token>` | B1 (table bill, reservation deposit), C (WhatsApp checkout), E2 (MCP payment links) |
| C `MessagingService` | `enqueueToCustomer(tx, ctx, { customerId?, phone?, templateName?, text?, variables?, orderId?, reason }) → { messageId \| null, skipped?: 'no_channel' \| 'no_consent' \| 'outside_window' }` | D2, B1 (only if needed; prefer events) |
| C `SegmentsService` / `CampaignsService` | `SegmentsService.create(tx, ctx, { name, definition, source })`, `CampaignsService.createDraft(tx, ctx, { name, channel, segmentId?, content, objective, source })` (drafts never send) | E2 (MCP), E1 (AI recommendations → draft) |
| B1 `OrdersQueryService` | `list(tx, ctx, filters)`, `get(tx, ctx, orderId)` | E2, B2 (may also use read SQL) |
| D2 `DeliveryService` | `createJobForOrder(tx, ctx, orderId)` (idempotent per order) | invoked by D2's own handler on `order.placed`/`order.status_changed` for delivery orders |

Events (publisher → typical consumers). Payload fields are minimal ids; consumers
re-read state inside their own transaction.

| Event | Published by | Consumed by |
|---|---|---|
| `order.placed`, `order.status_changed`, `order.cancelled`, `order.paid` | kernel | C (WhatsApp confirmations/updates for `orders.conversation_id`), D2 (create delivery job when a delivery order is placed/accepted; fiscal document on `order.paid`), B2/E1 (aggregates), C marketing (attribution `order_paid`) |
| `payment.succeeded`, `payment.refunded` | kernel | D1 (checkout session finalisation, reconciliation), D2 (fiscal docs / credit notes) |
| `reservation.*` | B1 | C (confirmation message), D1 (deposit expiry) |
| `delivery.*` | D2 | C (customer updates), B2 (delivery KPIs) |
| `message.inbound` | C | C (ordering state machine), E1 (optional insights) |
| `stock.low` | B2 | E1 insights, dashboard alerts |
| `compliance.document_expiring` | D2 | notification (C) |
| `mcp.approval_requested` | E2 | dashboard notification |

## 5. Documented write exceptions

- Kernel writes `orders`, `order_lines`, `order_events`, `customers` (+identities),
  `promotion_redemptions`, `promotions.redemption_count`, `attribution_events (order_placed)`,
  `stock_movements/stock_levels (sale/return)`, `product_branch_settings.stock_qty`,
  `payments`, `payment_allocations`, `bill_shares.paid_minor/status`, `bill_splits.status`,
  `reservations.deposit_status/status (pending_deposit→confirmed)`, `checkout_sessions.status`.
- `OrganizationsService.create` seeds rows in billing, compliance (`tax_profiles`),
  catalog (`menus`), studio (`websites`, `website_sections`), finance (`expense_categories`), floor (`floor_layouts`).
- The ledger (kernel) is the only writer of `visits.credit_used_minor`: every `deposit_credit` payment consumes
  visit credit atomically (bounded by `credit_minor`).
- ResutoPay (D1) refunds unused/cancelled reservation deposits from `visit.closed` / `reservation.cancelled`
  and may set `reservations.deposit_status = 'refunded'`.
- Customers (B2) merge re-points `customer_id` on `orders`, `visits`, `reservations`; anonymise nulls/redacts
  `orders.customer_name/customer_phone/delivery_address` and `reservations.guest_*`/`notes`. Other modules'
  references stay on the merged tombstone; consumers follow `customers.merged_into_id`.
- The legacy migration tool and the demo seed (A) write every tenant table directly as the database owner, in one
  transaction per tenant, mirroring the ledger's arithmetic; they never run against non-local databases without
  an explicit flag.
- Checkout and bill-share link tokens are stored as sha256 (lookups) **and** sealed with `SecretBox` (so staff and
  table guests can re-display a link/QR); the sealed column is not selectable by member sessions.
- Organization/branch deletion is blocked once fiscal documents exist (immutability trigger) — by design;
  platform tooling suspends or closes tenants instead of deleting them.
- E1 may insert `usage_events` rows with metric `ai_requests`; E2 may insert `usage_events` with metric `mcp_calls`.
- E2 (MCP) may insert **drafts** into `segments`/`campaigns` with `source='mcp'` through C's services once merged.
- B1 sets `dining_tables.status` and owns `visits`; D1 may set `visits.credit_used_minor` only through the ledger (`deposit_credit` payments).

## 6. API conventions

- Base path `/v1`. Tenant routes: `/v1/o/:orgId/<module>/…`. Guest/public routes:
  `/v1/public/<module>/…` (`@Public()`, rate-limited by IP and token).
  Provider webhooks: `/v1/webhooks/<provider>` (`@Public()`, raw body via `req.rawBody`,
  signature verified before parsing, stored in `webhook_inbox`, processed idempotently).
- Errors: throw `DomainError` (`common/errors/domain-error`) with a stable snake_case
  `code`; the filter maps Postgres constraint errors to 409/422/403.
- Lists: `{ items, nextCursor }`, `limit ≤ 200`.
- Responses use camelCase; DB columns are snake_case — map explicitly.
- Never reuse one SQL parameter (`$1`) in positions of different types (Postgres
  rejects "inconsistent types deduced"); pass the value twice.
- Guest bearer credentials (visit, share, ordering session, checkout, reservation
  tokens) are random (`newToken()`); store only `sha256(token)`; never return QR
  tokens from public endpoints (legacy vulnerability, see CURRENT_STATE.md).

## 7. Testing conventions

- API integration tests: `apps/api/test/<module>.test.ts` using `test/helpers.ts`
  (`bootTestApp`, `createTenant`, `addMember`, `seedMenu`, `sql`). Each test creates
  its own tenant so files are independent. Run `pnpm --filter @resuto/api test`.
- Every module must test: happy path, validation failure, permission failure,
  cross-tenant access (404), entitlement denial where applicable, idempotent retry
  where applicable.
- Web: `pnpm --filter @resuto/web build` must pass (type-checks every page).
- E2E (Agent F harness): `tests/e2e/*.spec.ts` with Playwright 1.56 against
  locally started API + web.
- Python: `pytest` in `apps/ai-service`.

## 8. API agreements between parallel agents

These shapes are fixed now so producers and consumers can build in parallel.
JSON is camelCase; money in minor units.

### Floor (producer B1, consumer F — Floor Studio UI and live floor)

- `GET /v1/o/:orgId/floor/:branchId` (`floor:read`) →
  `{ branchId, revision, schemaVersion: 2, width, height, background, zones: Zone[], objects: FloorObject[], tables: Table[] }`
  where `Table = { id, label, capacity, zone, shape: 'square'|'round'|'rect'|'booth'|'bar', cx, cy, width, height, rotation, features: string[], reservable, minSpendMinor, premium, internalNotes, status, version }`
  and `Zone/FloorObject` keep the legacy schema-v2 shapes (`{ id, type, label, x, y, width, height, rotation, color? }`).
- `PUT /v1/o/:orgId/floor/:branchId` (`floor:write`) body `{ baseRevision, key, layout: { width, height, background, zones, objects, tables: Array<Partial<Table> & { id?: string }> } }`
  → `200` layout (as GET) · `409 stale_layout { currentRevision }` · `409 table_in_use { tableId }` (archiving a table with an open
  visit or future reservation) · `422 invalid_geometry { path }`. Tables without `id` are created (server issues id and QR token);
  tables omitted from the list are archived. Operational status is never taken from the body.
- `GET /v1/o/:orgId/floor/:branchId/live` (`floor:read`) → `{ revision, tables: Array<Table & { visit: null | { id, partySize, openedAt, orderCount, dueMinor, paidMinor, requests: string[] }, nextReservation: null | { id, startsAt, guestName, partySize } }> }`
- `POST /v1/o/:orgId/visits` `{ tableId, partySize?, reservationId? }` (`floor:seat`) → `{ id, tableId }`;
  `POST /v1/o/:orgId/visits/:visitId/close` `{ force?: boolean }`; `POST /v1/o/:orgId/visits/:visitId/undo`;
  `POST /v1/o/:orgId/tables/:tableId/clean` (`floor:seat`).
- `GET /v1/o/:orgId/floor/:branchId/qr` (`floor:write`) → `{ items: Array<{ tableId, label, url, svg }> }` (print sheet; the only
  place QR URLs appear). `url = ${APP_ORIGIN}/t/<qrToken>`.
- `GET /v1/public/floor/:slug/:branchCode` → sanitized geometry for reservation maps (no QR tokens, no internal notes, no status beyond `reservable`).

### Guest table session (producer B1, consumers D1 pay pages)

- `POST /v1/public/tables/:qrToken/session` → `{ token, visitId, orgId, branchId, tableLabel, currency, org: { name, nameAr, slug } }`
  (opens or joins the table's visit). Store with `saveGuestVisit()` from `apps/web/lib/guest-visit.ts`; send `X-Visit-Token`.
- `GET /v1/public/visits/current` (header `X-Visit-Token`) → `{ visitId, status, table, orders, totals: { totalMinor, paidMinor, creditMinor, dueMinor }, currency }`.
- D1 resolves the same header (sha256 → `visits.guest_token_hash`, open visits only) for `/v1/public/payments/visit/*`.

### Public menu (producer B1, consumers C hosted ordering, F website)

- `GET /v1/public/menu/:slug?branch=<branchCode>` → `{ org: { name, nameAr, currency, slug }, branch: { id, code, name, nameAr, acceptsDineIn, acceptsPickup, acceptsDelivery, deliveryFeeMinor, minOrderMinor }, branches: [...], categories: Array<{ id, name, nameAr, products: Array<{ id, name, nameAr, description, descriptionAr, priceMinor, imageUrl, allergens, dietary, spiceLevel, available, modifierGroups: Array<{ id, name, nameAr, minSelect, maxSelect, options: Array<{ id, name, nameAr, priceDeltaMinor, available }> }> }> }> }`.
  Consumers may also read these tables directly (read model) — the shape above is the reference.
- Quoting from any public channel uses the kernel `PricingService` with cart lines `{ productId, quantity, modifiers: [{ groupId, optionId }], notes }`.

### Menu import (producer B1, consumer C POS import)

- `POST /v1/o/:orgId/menu/import/preview` and `/commit` (`menu:write`) accept
  `{ rows: Array<{ externalId?, name, nameAr?, category, description?, priceMinor, station?, allergens?: string[], available?: boolean }>, source: 'csv'|'foodics'|'odoo'|'ai' }`.
  C's POS adapters produce rows in this shape and the dashboard sends them to B1's endpoints.
