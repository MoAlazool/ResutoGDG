# Module status — honest readiness

Reconciled on 2026-10-21 (ws10a) against `docs/BACKLOG.md` and the code on this branch. Earlier versions of this
page called every module "MVP ✅" and said nothing had been deployed; both overstated or misstated the position.

Legend:
- **Working (API-tested)**: frontend + API + database + authorization + validation with API integration tests
  (`apps/api/test`) passing in this repository. It does **not** by itself mean a browser end-to-end spec passes.
- **Sandbox**: works through a clearly labelled simulated provider or sandbox transport; the real provider adapter
  has not been exercised with real credentials (`implemented_unverified`).
- **Partial**: the core works; open backlog items listed in the last column still change behaviour users see.
- **Staging**: a private staging deployment exists (Vercel + Render free plans + Supabase; `docs/STAGING_DEPLOYMENT.md`).
  It is not production; free-plan services sleep, and provider acceptance has not been run there.

Browser end-to-end (`tests/e2e`, Chromium): on 2026-10-21 the QR dine-in, WhatsApp hosted-ordering and KDS
driver-hand-over specs **fail** on this branch because they still target selectors of the pre-restoration guest UI
(`docs/qa/VISUAL_PARITY.md`); the driver delivery and Arabic hosted-page specs pass. WebKit (iPhone 13) is configured
for CI but has not run anywhere yet (CR-10). Test counts: `docs/TEST_RESULTS.md`.

| Product module | Status | What works (verified in code and tests) | Not yet / open backlog |
|---|---|---|---|
| **Platform** (tenancy, auth, RBAC, onboarding) | Working (API-tested) · Staging | Supabase Auth (JWKS) on staging, dev issuer locally; organizations, branches with timezone, invitations, roles × permissions, branch scope, audit log, suspension, account lifecycle (CR-05), RLS defence in depth; organization deletion cascades (fixed 20261022020001) | PS-16 API still connects with a BYPASSRLS role for platform-mode paths (planned); PS-13/PS-25 partial; B-14 Supabase dashboard settings |
| **Billing & entitlements** | Working (API-tested), no collection | Plans/prices as data, quotes, entitlements by plan/add-on/override, 402 enforcement, plan limits, lifecycle, draft invoices | FT-18: no billing provider; nothing is charged, invoices stay drafts |
| **Platform administration** | Working (API-tested) | Tenants, suspend/reactivate, overrides, price versions, operations view (outbox, handlers, webhooks, jobs), role-separated admins; `/v1/health/details` for monitors (CR-14) | — |
| **Core — menu** | Partial | Bilingual categories/products, modifiers, per-branch availability/price/stock, sold-out (86) split, images with signed URLs, CSV/POS import preview → commit, public menu with versioning | VP-04/DF-08 partial (photo-less dishes); CR-12 partial (image derivatives) |
| **Core — floor & QR** | Working (API-tested) | Schema-v2 layouts with revision conflicts, server-issued table QR tokens, print sheet, live floor, Floor Studio, service modes; counter venue QR (FT-07) and migrated legacy venue tokens resolving to it (CR-13) | FT-07 partial (remainder in follow-ups) |
| **Core — QR dine-in** | Partial | PIN-free table session, restored legacy guest shell, server pricing, idempotent orders, service requests, live bill, splits, menu assistant and upsell, ratings after payment (ws4b code: `guest/assistant.service.ts`, `guest/ratings.service.ts`) | Browser E2E spec failing (stale selectors); BACKLOG rows VP-20/21, VS-27, FT-20/21 still say "planned" although the code landed — to be re-verified and closed by the lead |
| **Core — orders & kitchen (KDS)** | Working (API-tested) | Fulfillment-specific state machine, cancel with refund guard, full-screen KDS with lanes, station filter, line bumps/recall, delta polling; driver jobs completed only by the driver; pollers survive token refresh (DF-13) | PCL-23 deferred (polling, no push); no KDS sound alert; KDS hand-over E2E spec failing (stale selector) |
| **Core — reservations** | Working (API-tested) | Branch-timezone availability, holds, overlap protection, deposits via ResutoPay, guest manage page, 3-step booking with floor map | — |
| **Core — inventory** | Working (API-tested) | Items, suppliers, movements, recipes with order-time deduction, low-stock alerts, valuation, waste | — |
| **Core — customers (CRM)** | Working (API-tested) | Search, profiles, append-only consent history, audited export, anonymise, merge | — |
| **Loyalty** | Partial | Ledger, earning/redemption rules, staff redeem, UI (ws8) | FT-03 partial |
| **Notifications** | Partial | In-app notifications module, bell and page (ws8) | FT-06 partial; INT-28/FT-27: no email, SMS or push provider |
| **Analytics & ROI** | Working (API-tested) | Revenue (gross/net/VAT, refunds netted), channels, heatmap, products & margins, cohorts, attribution (sandbox excluded), rollups | — |
| **Resuto Connect** (WhatsApp, inbox) | Sandbox · Partial | Structured ordering through a hosted menu page, unified inbox, 24-h window, templates, handoff, notifications, signed webhooks, channel ownership verification (INT-03), Messenger/Instagram channels | Meta Cloud API never exercised with real credentials (B-4); hosted-ordering E2E spec failing (stale selector) |
| **ResutoPay** | Sandbox · Partial | Checkout and links, QR bill, splits, deposits, COD, manual collection with verification, signed webhooks → ledger, refunds, reconciliation | Paymob/Stripe/Moyasar never exercised with real credentials (B-3); INT-05, INT-06, INT-16, PAY-19, PAY-21, PAY-22 partial |
| **Resuto Marketing** | Sandbox · Partial | Segments, campaigns with approval, consent filtering, promotions, tracking links → attribution, Meta Pixel + CAPI with consent (INT-20) | Ads never exercised (B-5); INT-22 partial; INT-23 TikTok/Snap and FT-27 SMS/email in progress or planned (ws7b) |
| **ResutoDriver** | Working (API-tested) | Invitations, availability, dispatch board with map, offers with expiry, proof photo and OTP, COD via ledger, settlement, tracking (FT-14), delivery zones | FT-22 no push notifications (ws7b); straight-line ETA unless a maps provider is configured (INT-29) |
| **ResutoStudio** | Partial | Website builder, publish revisions, media library, restaurant site with restored hero/story, Smash & Co branch storefront, photo enhancement pipeline, approved copy apply, menu extraction review | VS-26 partial; custom-domain SSL/routing needs a hosting provider (B-9, INT-27 in ws7b) |
| **Resuto Finance** | Working (API-tested) · Partial | Expenses with receipts, COGS, P&L policy with coverage, journals, reconciliation summaries, CSV exports | INT-25 accounting push (Wafeq/Qoyod/Odoo) unverified/planned |
| **Resuto Compliance** | Sandbox | Tax profiles with validation, fiscal documents (ZATCA Phase-1 TLV QR; ETA structure), hash chains, credit notes, licences | FT-24/INT-26: ZATCA Phase-2 and ETA submission are stubs. **No certification claimed.** |
| **Resuto Intelligence** | Working (API-tested) | FastAPI forecasting, RFM, churn, recommendations, routing; insights with templates and lifecycle; owner assistant (rules mode); AI quota (FT-10) | INT-30: Gemini path tested only with a scripted model; published metrics are on **synthetic** data |
| **ResutoMCP** | Working (API- and SDK-tested) | 22 tools with schemas, role/branch/tool scoping, approvals bound to inputs, rate limits, audit, Streamable HTTP + stdio, OAuth 2.1 with scope enforcement (ws9) | Not tested with the Claude or ChatGPT apps |
| **Integration framework** | Partial | Catalog with readiness, encrypted credentials, health checks, sync runs, OAuth start/callback, acceptance harness | All external providers unverified; INT-05/INT-16 partial |

**Cross-cutting**

| Area | Status | Notes |
|---|---|---|
| Demo data | Working | Loader re-times relative to load, upserts only the demo tenant, post-load integrity check (DF-10/11, `scripts/demo`) |
| Observability | Working (no paid service) | Build identity on every service (CR-07), JSON access log, optional error tracking DSN, `/v1/health/details` (CR-14) |
| Visual parity gate | Partial | 14 restored surfaces captured deterministically; local baselines recorded; Docker baselines and owner approval pending (CR-11) |
| API quality | Planned | PS-19 OpenAPI, PS-20 error contract, PS-21 validation, PS-22 pagination, PS-23 HTTP semantics |
| Web performance | Partial | Bundle budget now enforced in CI; 4 routes currently over their group budget (/, /pricing, /t/[qr], website editor) |

## Semester-1 research tracks

| Track | Status | Evidence |
|---|---|---|
| Demand forecasting | Baselines + GBM, rolling-origin backtest | `research/forecasting/` — synthetic data, run `20261017-seed42` |
| Customer intelligence & recommendations | RFM, churn LR vs heuristic, association + hybrid recommender | `research/customers/` — synthetic |
| Delivery & operational optimisation | NN + 2-opt vs exact on small instances | `research/routing/` — synthetic |
| Literature review | 14 papers verified against Crossref by DOI | `research/literature/LITERATURE_REVIEW.md` |

All research metrics come from a seeded synthetic dataset and are labelled as such; they are not experimental
evidence about real restaurants.
