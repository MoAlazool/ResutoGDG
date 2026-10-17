# Module status — honest readiness

Legend — **MVP ✅**: frontend + API + database + authorization + validation + tests working end to end in this
repository. **Sandbox**: works through a clearly labelled simulated provider; the real provider adapter exists but
has never been exercised with real credentials (`implemented_unverified`). Nothing here has been deployed.

Test counts are from the integrated branch (`claude/relaxed-mayer-omkl3f`); see `docs/TEST_RESULTS.md`.

| Product module | Status | What works | Sandbox / not yet | Owner agent |
|---|---|---|---|---|
| **Platform** (tenancy, auth, RBAC, onboarding) | MVP ✅ | Supabase-shaped JWT auth (dev issuer locally), organizations, branches (with timezone), invitations (create/accept/revoke), 10 roles × 46 permissions, branch scope, audit log, suspension, RLS defense in depth | Real Supabase Auth not exercised (B-1, B-12) | Lead |
| **Billing & entitlements** | MVP ✅ (no collection) | Plans/prices as data (EG/SA, monthly/annual), Build Your Resuto quote, entitlements by plan/add-on/override, backend enforcement (402), plan limits (branches, staff, monthly orders), upgrade/downgrade scheduling with guards, trial → past_due → unpaid lifecycle, draft invoices | No billing provider: nothing is charged; invoices stay drafts | A |
| **Platform administration** | MVP ✅ | Tenants list/detail, suspend/reactivate, entitlement overrides, price versions, operations view (outbox, handlers, webhooks, jobs), role-separated platform admins | — | A |
| **Resuto Core — menu** | MVP ✅ | Categories, products (bilingual, allergens, dietary, cost), modifiers, per-branch availability/price/stock, images (signed URLs), CSV/POS import preview → commit, public menu | — | B1 |
| **Core — floor & QR** | MVP ✅ | Schema-v2 layouts with revision conflicts, geometry validation, server-issued table ids + QR tokens (never public), archive guards, QR print sheet, live floor | Floor Studio React UI: Agent F (see below) | B1 / F |
| **Core — QR dine-in** | MVP ✅ | PIN-free table session, menu-first guest app, server pricing, idempotent orders, service requests, live bill, 60-s undo, auto-close, cleaning flow | — | B1 |
| **Core — orders & kitchen (KDS)** | MVP ✅ | Staff orders, fulfillment-specific state machine, cancel with refund guard, full-screen KDS with station filter, line bumps/recall, prep times | No KDS sound alert; Realtime not wired (2-s polling) | B1 |
| **Core — reservations** | MVP ✅ | Availability search, 5-min holds, exclusion-constraint overlap protection, deposits via ResutoPay, guest manage page, check-in window, deposit → visit credit, unused/cancelled deposit refunds | — | B1 / D1 / lead |
| **Core — inventory** | MVP ✅ | Items, suppliers, movements (purchase/waste/adjust/transfer/count), recipes with order-time deduction, low-stock alerts, valuation, measured waste | — | B2 |
| **Core — customers (CRM)** | MVP ✅ | Search/filters, profiles with computed totals, consent history (append-only), export (audited, formula-safe), anonymise, merge | — | B2 |
| **Analytics & ROI** | MVP ✅ | Revenue (gross/net/VAT, refunds netted), AOV, channels, heatmap, products & margins with cost coverage, cohorts/retention, attributed revenue (non-incremental, sandbox excluded), delivery & kitchen KPIs, waste, paper indicator, ROI calculator labelled hypothetical | — | B2 |
| **Resuto Connect** (WhatsApp, inbox) | MVP ✅ · Sandbox | OFB-style structured ordering (buttons → hosted menu page → server-priced cart → online pay link or COD), persisted session state, unified inbox, 24-h window, templates, handoff, retries, order/delivery/reservation notifications, signed webhook ingestion | Meta Cloud API never exercised (B-4); dine-in not offered via WhatsApp | C |
| **ResutoPay** | MVP ✅ · Sandbox | Checkout sessions & payment links, hosted checkout, QR table bill, equal/custom/by-item splits, share links, reservation deposits, COD, cash/InstaPay/bank transfer collection, signed webhooks → ledger, idempotency, refunds (provider/manual), reconciliation (provider/CSV/cash) | Paymob/Stripe/Moyasar never exercised (B-3); simulated provider reports zero fees | D1 |
| **Resuto Marketing** | MVP ✅ · Sandbox | Segment DSL (parameterised SQL), campaigns with approval, consent filtering, scheduling, promotions (applied by pricing), tracking links → attribution (web + WhatsApp), reports, deterministic recommendations | Meta/TikTok/Snap ads never exercised (B-5); SMS/email have no provider | C |
| **ResutoDriver** | MVP ✅ | Driver invitations, availability, devices, dispatch board, offers with expiry, pickup/en route/delivered with photo proof & OTP, COD via ledger, cash settlement, locations, ETA baseline, mobile web app `/driver` | No push notifications; straight-line ETA | D2 |
| **ResutoStudio** | In progress | API: websites, sections, publish revisions, media, custom domains (DNS TXT verification), creative generation | Pending Agent F merge; domain activation needs hosting provider (B-9) | F |
| **Resuto Finance** | MVP ✅ | Revenue overview, expenses with receipts, COGS, P&L with methodology/coverage, fees, reconciliation summaries, CSV exports with checksums, balanced journals | Wafeq/Qoyod/Odoo push unverified (B-7) | D1 |
| **Resuto Compliance** | MVP ✅ · Sandbox | Country-aware tax profiles with validation, fiscal documents on payment (ZATCA Phase-1 TLV QR exact; ETA receipt structure), hash chains, credit notes, immutability, licences with expiry reminders | ZATCA Phase-2 signing/clearance and ETA submission are sandbox stubs (B-6). **No certification claimed.** | D2 |
| **Resuto Intelligence** | MVP ✅ | FastAPI service: demand forecasting (seasonal naive / moving average / gradient boosting), RFM segments, churn, item recommendations, routing (NN + 2-opt); API: forecasts, insights job, owner assistant (rules mode), copy generation (template fallback), research registry | Gemini path tested only with a scripted model (B-8); all published metrics are on **synthetic** data | E1 |
| **ResutoMCP** | MVP ✅ | Client keys (shown once, hashed), 17 tools with schemas, role/branch/tool scoping, approvals for sensitive actions, rate limits, audit, Streamable HTTP + stdio server tested with the official SDK client | Not tested with Claude/ChatGPT apps; OAuth 2.1 not implemented | E2 |
| **Integration framework** | MVP ✅ | Provider catalog with readiness, encrypted credentials (never returned), health checks, sync runs/cursors/conflicts/logs, OAuth start/callback, POS menu import (Foodics/Odoo) | All external providers unverified | C |

## Semester-1 research tracks

| Track | Status | Evidence |
|---|---|---|
| Demand forecasting | Baselines + GBM, rolling-origin backtest | `research/forecasting/` — synthetic data, run `20261017-seed42` |
| Customer intelligence & recommendations | RFM, churn LR vs heuristic, association + hybrid recommender | `research/customers/` — synthetic |
| Delivery & operational optimisation | NN + 2-opt vs exact on small instances | `research/routing/` — synthetic |
| Literature review | 14 papers verified against Crossref by DOI | `research/literature/LITERATURE_REVIEW.md` |

All research metrics come from a seeded synthetic dataset and are labelled as such; they are not experimental
evidence about real restaurants.
