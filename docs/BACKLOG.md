# Backlog — Resuto 2.0 continuation

Source: the grounded audit of 2026-10-19/20 (8 independent audits + a completeness critic; 227 items, evidence and reproduction for each kept in the programme scratchpad). Priorities follow the owner brief: **P0** security/integrity, original look, Western digits, loading foundations; **P1** module workflows, payment safety, adapters, activation tests; **P2** remaining integrations, Studio AI, MCP interop, advanced performance, hardening.

Status is updated as workstreams land. "NR" rows are checks that did not reproduce (kept as evidence).

| Id | P | Title | Workstream | Status |
|---|---|---|---|---|
| VP-01 | P0 | Arabic-Indic digits rendered on every AR public/guest page (must be 0-9) | lead | done (lead d660d21) |
| VP-02 | P0 | Arabic brand name misspelled 'ريزوتو' (legacy 'ريسوتو'); pricing header uses text instead of Arabic logo | ws3-staff-shell | done (wave 1, 5274252) |
| VP-03 | P0 | Landing pricing teaser broken: all cards 'See plans and prices', Monthly/Yearly toggle missing | ws4a-public | planned |
| VP-04 | P0 | Contact sheet (menu-photography.webp 2x4 grid) used as the image of every photo-less dish | ws4a-public | planned |
| VP-05 | P0 | Smash & Co storefront missing (legacy /burger) and its 9 product photos not migrated | ws4a-public | planned |
| VP-06 | P0 | Restaurant site /r/the-olive-room lost the legacy hero, story section, tagline and disclosure; shows Smash content | ws4a-public | planned |
| VP-07 | P0 | Guest menu/order/table pages do not use the legacy consumer shell (platform.css) | ws4b-guest | planned |
| VP-08 | P0 | Reservation page lost the legacy 3-step booking UI and the zoomable floor map | ws4b-guest | planned |
| VP-09 | P0 | /pricing is a different design from legacy (nav, logo, cards, comparison, FAQ, sales form, footer) | ws4a-public | planned |
| VP-10 | P0 | Guest pages load with an unbranded grey skeleton (no header/brand) instead of a branded loading shell | ws4b-guest | planned |
| VP-11 | P1 | Reservations use browser time, not the branch (Cairo) timezone | ws4b-guest | planned |
| VP-12 | P1 | Landing hero/CTA floor uses static 12-table SAMPLE instead of the demo restaurant's saved floor | ws4a-public | planned |
| VP-13 | P1 | Floor renderer: AR zone labels overflow zones; zone fills/door label differ from legacy | ws4a-public | planned |
| VP-14 | P1 | Running demo data is stale: English category names and restaurant name on AR pages, no hero photo | ws4a-public | planned |
| VP-15 | P1 | Legacy URLs 404 on the new web | ws4a-public | planned |
| VP-16 | P1 | ?lang=ar / ?lang=en links ignored (shareable Arabic links broken) | ws4a-public | planned |
| VP-17 | P1 | Guest pages all titled 'Resuto — Restaurant operating system' | ws4a-public | planned |
| VP-18 | P1 | Table bill/split/share UX differs from legacy; empty bill says 'fully paid' | ws4b-guest | planned |
| VP-19 | P1 | Order status and cart sheet differ from legacy (tracker, thumbnails, upsell sheet) | ws4b-guest | planned |
| VP-20 | P1 | Menu assistant ('Help me choose') and cart upsell missing on guest menus | ws4b-guest | planned |
| VP-21 | P1 | No guest rating after payment; receipt actions differ | ws4b-guest | planned |
| VP-22 | P1 | Pricing copy: English plan descriptions on AR, '1 branch(es)' | ws4a-public | planned |
| VP-23 | P2 | Emoji used as icons on guest/payment UI | ws4a-public | planned |
| VP-24 | P2 | Landing service-demo QR points to the site, not a table | ws4a-public | planned |
| VP-25 | P2 | Landing extras not in legacy: 'Create your restaurant' in CTA and footer | ws4a-public | planned |
| VP-26 | P2 | Price formatting drops decimals ('EGP 145' vs legacy 'EGP 145.00') | ws4a-public | planned |
| VP-27 | P2 | Duplicate legacy images in apps/web/public (brand/ and landing/) | ws4a-public | planned |
| VS-01 | P0 | Single design-token source; port missing legacy staff tokens; guard against hex literals | ws3-staff-shell | done (wave 1, 5274252) |
| VS-02 | P0 | Restore the legacy staff shell (sidebar, wordmark, restaurant chip, topbar, footer, profile, floating language switch) | ws3-staff-shell | done (wave 1, 5274252) |
| VS-03 | P0 | Replace colour emoji icons with the legacy monochrome glyph set | ws3-staff-shell | done (wave 1, 5274252) |
| VS-04 | P0 | Port legacy page primitives (PageHeading, StatsStrip, Panel, buttons, file input, checkbox accent) and fix .card+.card grid misalignment | ws3-staff-shell | done (wave 1, 5274252) |
| VS-05 | P0 | Restore legacy staff login layout and role-aware post-login routing | ws3-staff-shell | done (wave 1, 5274252) |
| VS-06 | P0 | Western digits 0-9 everywhere in Arabic (verify the lead/p0-digits fix in the running build) | ws3-staff-shell | done (wave 1, 5274252) |
| VS-07 | P0 | Loading foundations: chrome-first shell, route-level skeletons, navigation pending state, no layout shift | ws3-staff-shell | done (wave 1, 5274252) |
| VS-08 | P0 | RTL floor SVG: restore direction:ltr on the scene and translate seeded zone/object labels | ws5-ops | planned |
| VS-09 | P0 | Bidi isolation for phones, emails, codes and user text in RTL | ws3-staff-shell | done (wave 1, 5274252) |
| VS-24 | P0 | Mobile staff shell parity: horizontal chip nav and visible language switch instead of a hidden drawer | ws3-staff-shell | done (wave 1, 5274252) |
| VS-10 | P1 | KDS parity: 5 lanes, drag-and-drop with forward-only validation, service requests, completed lane, sane timers | ws5-ops | planned |
| VS-11 | P1 | Floor overview side panel and actions parity (QR, walk-in, resolve, kitchen states, KPI strip, default tab) | ws5-ops | planned |
| VS-12 | P1 | Host front desk view and host routing | ws5-ops | planned |
| VS-13 | P1 | Active visits list (including pickup/delivery visits) with close-visit flow | ws5-ops | planned |
| VS-14 | P1 | Orders: add the legacy board view (kanban + drag + requests) alongside the list | ws5-ops | planned |
| VS-15 | P1 | Overview parity: live floor, station load, operational insights ask box, low stock, legacy KPI strip | ws5-ops | planned |
| VS-16 | P1 | Settings: service model cards and reservation/delivery policy; mode-driven nav | ws5-ops | planned |
| VS-17 | P1 | Guided setup: 8-step wizard with step list and progress | ws5-ops | planned |
| VS-18 | P1 | Menu & inventory table parity (portions/stock, image action, AR vocabulary) and native control styling | ws5-ops | planned |
| VS-19 | P1 | Replace native window.confirm/prompt with styled Modal/useConfirm | ws3-staff-shell | done (wave 1, 5274252) |
| VS-20 | P1 | Live/polling behaviour: pause while editing, skip unchanged revisions, global connection status | ws5-ops | planned |
| VS-21 | P1 | Untranslated operator-facing strings in Arabic (server-generated text, technical keys, vocabulary) | ws3-staff-shell | partial (wave 1; remainder in follow-ups) |
| VS-22 | P1 | Plural-aware i18n (Arabic six forms) | ws3-staff-shell | done (wave 1, 5274252) |
| VS-23 | P1 | Floor Studio as a full-bleed editor (not squeezed inside the dashboard shell) | ws5-ops | planned |
| VS-27 | P1 | Guest satisfaction ratings missing end-to-end | ws4b-guest | planned |
| VS-25 | P2 | Mobile overflow and clipping fixes (badges, data tables, KDS timers, chart labels) | ws5-ops | planned |
| VS-26 | P2 | Studio AI: AI menu extraction review flow and AI floor import | ws9-studio-mcp | planned |
| VS-28 | P2 | Consolidated Import & export hub | ws5-ops | planned |
| VS-30 | P2 | Human-friendly durations and timestamps (Elapsed/When formatters) | ws3-staff-shell | done (wave 1, 5274252) |
| VS-31 | P2 | New-only modules: migrate inline styles/local hex to shared components so they inherit the restored legacy language | ws5-ops | planned |
| VS-32 | P2 | Integrations cards visual parity (provider tile/logo, filter chips) | ws5-ops | planned |
| FT-01 | P0 | MCP keys bypass tool allowlist, approvals and MCP audit via @AllowMcp REST routes | ws1-security | done (wave 1, 5274252) |
| FT-02 | P1 | Menu: temporary unavailability (86) conflated with branch assignment | ws5-ops | planned |
| FT-03 | P1 | Loyalty missing: no earning/redemption rules, no auditable ledger, no UI | ws8-features | planned |
| FT-05 | P1 | Connect: Messenger and Instagram channels missing | ws7a-meta | planned |
| FT-06 | P1 | Owner/staff notifications never delivered (licence expiry reminders marked 'sent', low stock, MCP approvals, invitations) | ws8-features | planned |
| FT-07 | P1 | Counter / single venue QR mode (takeaway, cloud kitchen) not ported | ws5-ops | planned |
| FT-08 | P1 | AI menu extraction from PDF/photo missing although the landing advertises it | ws9-studio-mcp | planned |
| FT-09 | P1 | Pickup/delivery ordering ignores opening hours and delivery area; no delivery zones | ws8-features | planned |
| FT-10 | P1 | ai_requests_per_month plan limit displayed but never enforced | ws8-features | planned |
| FT-11 | P1 | Guest cannot resume an unpaid reservation deposit | ws4b-guest | planned |
| FT-12 | P1 | Connect recovery: no resend of failed messages; conversation assignment API has no UI | ws5-ops | planned |
| FT-13 | P1 | Onboarding: one-form creation + self-asserted checklist; legacy guided wizard not ported | ws5-ops | planned |
| FT-15 | P1 | Intelligence insights are English-only inside the Arabic UI; evidence shown as raw JSON | ws8-features | planned |
| FT-18 | P1 | Platform subscription invoices never collected (no billing provider) | ws8-features | planned |
| FT-04 | P2 | Food-photo enhancement pipeline missing (upload -> processing job -> review -> approval -> publish) | ws9-studio-mcp | planned |
| FT-14 | P2 | No customer-facing delivery ETA/tracking and no dispatcher map | ws8-features | planned |
| FT-16 | P2 | Approved creative has no publish/apply path; copy-generation API has no UI | ws9-studio-mcp | planned |
| FT-17 | P2 | MCP interop: tool coverage gaps (menu, finance, payments, delivery) and no OAuth 2.1 | ws9-studio-mcp | planned |
| FT-19 | P2 | Platform fees not separated from pass-through costs (messaging, ads, payment fees, AI) in data/UI | ws8-features | planned |
| FT-20 | P2 | Guest-facing menu assistant and upsell suggestions not ported | ws4b-guest | planned |
| FT-21 | P2 | Guest ratings/feedback after payment not ported | ws4b-guest | planned |
| FT-22 | P2 | Driver devices registered but no push notifications | ws7b-integrations | planned |
| FT-23 | P2 | Finance journals cover sales only; account mapping not editable; invoices push unused | ws8-features | planned |
| FT-24 | P2 | Regulator adapters are stubs: ZATCA Phase-2 signing/clearance and ETA submission | ws7b-integrations | planned |
| FT-25 | P2 | Inventory bulk stocktake and supplier edit have API but no UI | ws5-ops | planned |
| FT-26 | P2 | Connection health is manual only; payment and accounting adapters lack health checks | ws2-payments | partial (wave 1; remainder in follow-ups) |
| FT-27 | P2 | SMS and email marketing channels have no provider | ws7b-integrations | planned |
| INT-01 | P0 | Production can run simulated payments: PAYMENT_MODE defaults to sandbox with no deployed-env guard | ws1-security | done (wave 1, 5274252) |
| INT-02 | P0 | SSRF through tenant-supplied provider URLs (Odoo POS and Odoo Accounting), with the response reflected in last_error | ws1-security | done (wave 1, 5274252) |
| INT-03 | P0 | WhatsApp channel phone_number_id and WABA ownership not verified, so inbound messages can be intercepted across tenants | ws7a-meta | planned |
| INT-04 | P1 | Credential AAD mismatch: payments and accounting cannot decrypt connections created through Integrations (do first in P1) | ws2-payments | done (wave 1, 5274252) |
| INT-05 | P1 | Payment and accounting connections never become 'connected': no healthCheck and no account identity check | ws2-payments | partial (wave 1; remainder in follow-ups) |
| INT-06 | P1 | Setup UI cannot configure payment or accounting providers; labels not localised; defaults to live; no edit or reconnect UI | ws2-payments | partial (wave 1; remainder in follow-ups) |
| INT-07 | P1 | The 'enabled=false' flag is ignored by payments and accounting | ws2-payments | done (wave 1, 5274252) |
| INT-08 | P1 | No guard against test and live mixing: live connections accept test keys; webhook livemode not checked | ws2-payments | done (wave 1, 5274252) |
| INT-09 | P1 | Moyasar contract errors: invoice callback_url aimed at the webhook endpoint; failure-event spelling; minimum amount | ws2-payments | done (wave 1, 5274252) |
| INT-10 | P1 | Merchant webhook secret (Moyasar secret_token) stored in plaintext in webhook_inbox | ws2-payments | done (wave 1, 5274252) |
| INT-11 | P1 | OAuth hardening: state not bound to the browser, no PKCE, short-lived Meta token, no account selection, Snapchat refresh unused, no provider-side revocation | ws7a-meta | planned |
| INT-12 | P1 | Meta Marketing API pinned to v23.0, which is no longer supported | ws7a-meta | planned |
| INT-13 | P1 | WhatsApp multi-tenant onboarding model is inconsistent (one platform app secret vs merchant-owned apps); no Embedded Signup | ws7a-meta | planned |
| INT-14 | P1 | Ad campaign launch silently falls back to the ads sandbox when the live connection is not 'connected' | ws7a-meta | planned |
| INT-15 | P1 | No executable provider acceptance tests and no recorded verification evidence | ws2-payments | done (wave 1, 5274252) |
| INT-16 | P1 | Readiness labels are static and overstated; adopt the six-state per-capability taxonomy | ws2-payments | partial (wave 1; remainder in follow-ups) |
| INT-17 | P1 | Health is manual only; no last-success or last-webhook tracking; raw provider text in diagnostics | ws2-payments | done (wave 1, 5274252) |
| INT-18 | P1 | API tests bypass the real connection setup path, masking INT-04, INT-05 and INT-06 | ws2-payments | done (wave 1, 5274252) |
| INT-19 | P1 | Payment adapter contract details: Stripe version pin and expiry cap, Paymob listing endpoint and wallet callback limits | ws2-payments | done (wave 1, 5274252) |
| INT-20 | P1 | Meta Pixel and Conversions API not configured (distinct from Paymob's checkout 'Pixel' component) | ws7a-meta | planned |
| INT-21 | P2 | Messenger and Instagram messaging channels not configured | ws7a-meta | planned |
| INT-22 | P2 | Meta Ads audiences, ad sets, creatives and organic publishing not configured | ws7a-meta | planned |
| INT-23 | P2 | TikTok Events API, Snapchat Conversions API and their pixels not configured | ws7b-integrations | planned |
| INT-24 | P2 | Foodics OAuth not implemented despite authType 'oauth'; no menu-change webhook | ws7b-integrations | planned |
| INT-25 | P2 | Accounting completion: endpoint verification, invoice push, Odoo JSON-2 migration, scheduled push | ws7b-integrations | planned |
| INT-26 | P2 | ZATCA Phase-2 and ETA submission are stubs only | ws7b-integrations | planned |
| INT-27 | P2 | Custom domains: apex detection wrong for .com.eg and .com.sa; SSL status inferred | ws7b-integrations | planned |
| INT-28 | P2 | Notifications: no email, SMS or push provider | ws7b-integrations | planned |
| INT-29 | P2 | Maps: no routing or geocoding provider (offline baseline only) | ws7b-integrations | planned |
| INT-30 | P2 | Gemini: two separate clients; never run against the real API | ws7b-integrations | planned |
| PAY-01 | P0 | Paymob callback resolves the payment from unsigned fields; one signed transaction can settle a different (unpaid) order | ws2-payments | done (wave 1, 5274252) |
| PAY-02 | P0 | No test/live separation for real providers: live connections accept test keys and test-mode events, and the Paymob integration check fails open | ws2-payments | done (wave 1, 5274252) |
| PAY-03 | P0 | PAYMENT_MODE defaults to 'sandbox' in production, so any link holder can settle real orders through the simulated provider | ws1-security | done (wave 1, 5274252) |
| PAY-04 | P0 | Moyasar webhooks are authenticated only by a static secret_token, which is stored in plaintext in webhook_inbox; there is no server-side payment fetch | ws2-payments | done (wave 1, 5274252) |
| PAY-05 | P0 | A refund with an uncertain result is recorded as failed, and the retry sends a new provider refund with a new idempotency key (double refund) | ws2-payments | done (wave 1, 5274252) |
| PAY-06 | P1 | Real payment providers cannot be activated through the product (AAD mismatch, no healthCheck, no credential fields) | ws2-payments | done (wave 1, 5274252) |
| PAY-07 | P1 | A decline followed by a successful retry inside the same Paymob or Moyasar checkout is never applied (customer charged, order unpaid) | ws2-payments | done (wave 1, 5274252) |
| PAY-08 | P1 | Superseded or expired attempts stay payable at the provider; late_success only raises an alert, with no resolution workflow | ws2-payments | done (wave 1, 5274252) |
| PAY-09 | P1 | Concurrent /start creates two live provider attempts for one checkout session (double charge on partial links or partial bill payments) | ws2-payments | done (wave 1, 5274252) |
| PAY-10 | P1 | A verified event is not bound to the payment's connection or environment | ws2-payments | done (wave 1, 5274252) |
| PAY-11 | P1 | Refunds, voids and disputes started at the provider are ignored, so the ledger stays 'paid'; auth-only flows silently never settle | ws2-payments | done (wave 1, 5274252) |
| PAY-12 | P1 | Pending provider refunds are never resolved | ws2-payments | done (wave 1, 5274252) |
| PAY-13 | P1 | Payment tests do not cover the owner's required list (no Paymob or Moyasar test through the real webhook controller, no concurrency, no live-mode boot, no official vectors, no activation test) | ws2-payments | done (wave 1, 5274252) |
| PAY-14 | P1 | Paymob return path and status inquiry depend on an optional credential; the GET-redirect HMAC is neither verified nor stripped | ws2-payments | done (wave 1, 5274252) |
| PAY-15 | P2 | Signature comparison does no input hygiene (hex, length, case) | ws2-payments | done (wave 1, 5274252) |
| PAY-16 | P2 | Moyasar event-model details: failure-event spelling, unsigned invoice callback_url, payment_captured not handled | ws2-payments | done (wave 1, 5274252) |
| PAY-17 | P2 | Ledger invariants for reservation deposits: no due check, and deposit marked 'paid' on cancelled or expired reservations | ws2-payments | done (wave 1, 5274252) |
| PAY-18 | P2 | Webhook endpoint hygiene: prototype-key provider lookup, unbounded rejected-payload storage, no retention or PII minimisation, silent retry exhaustion | ws2-payments | done (wave 1, 5274252) |
| PAY-19 | P2 | COD and manual-transfer collection is inconsistent across routes, with no duplicate-reference guard or verification step | ws2-payments | partial (wave 1; remainder in follow-ups) |
| PAY-20 | P2 | Raw provider error text and unsigned provider messages are shown to guests | ws2-payments | done (wave 1, 5274252) |
| PAY-21 | P2 | Adapter and reconciliation correctness items that need provider-sandbox verification | ws2-payments | partial (wave 1; remainder in follow-ups) |
| PAY-22 | P2 | Status docs overclaim payment-adapter readiness | ws2-payments | partial (wave 1; remainder in follow-ups) |
| PS-01 | P0 | Supabase 'authenticated' role (Data API/Realtime) bypasses RBAC and branch scope on orders, messages, reservations, delivery_jobs, dining_tables | ws1-security | done (wave 1, 5274252) |
| PS-02 | P0 | Storage policy lets any org member (driver, kitchen) read compliance documents, expense receipts and delivery proofs directly | ws1-security | done (wave 1, 5274252) |
| PS-03 | P0 | MCP keys bypass allowed_tools and human approval by calling @AllowMcp REST routes directly | ws1-security | done (wave 1, 5274252) |
| PS-04 | P0 | API (and in-process worker) crashes when an idle DB connection errors: no pool error handler or timeouts | ws1-security | done (wave 1, 5274252) |
| PS-05 | P0 | Production env guardrails missing: PAYMENT_MODE defaults to sandbox (simulated payments), local storage allowed, unverified DB TLS allowed | ws1-security | done (wave 1, 5274252) |
| PS-06 | P0 | DB TLS not verified (sslmode=no-verify); ship the Supabase CA and use verify-full | lead | done (lead 9caad7d) |
| PS-07 | P1 | Function hardening: 11 app functions without search_path, EXECUTE granted to PUBLIC, 3 extensions in public | ws1-security | done (wave 1, 5274252) |
| PS-08 | P1 | Delivery OTP is an unkeyed sha256 of a 4-digit code (offline brute force) with an in-memory attempt limit | ws1-security | done (wave 1, 5274252) |
| PS-09 | P1 | Branch-restricted admins can invite or update members with all-branch or out-of-scope branch access | ws1-security | done (wave 1, 5274252) |
| PS-10 | P1 | Outbox claim has no lease: concurrent worker loops re-claim in-flight events (duplicate handler side effects) | ws1-security | done (wave 1, 5274252) |
| PS-11 | P1 | OAuth state not bound to the initiating browser/user (account-linking CSRF on ads integrations) | ws7a-meta | planned |
| PS-12 | P1 | Demo loader writes auth.users/auth.identities directly (and re-passwords on every staging boot); use the Supabase Admin Auth API | lead | done (lead 63ce9e6) |
| PS-13 | P1 | Rate limits are in-memory, keyed on a spoofable req.ip (trust proxy 1), with no Retry-After header | ws1-security | partial (wave 1; remainder in follow-ups) |
| PS-14 | P1 | Ad campaign launch calls the provider before locking or moving state; send/launch accept no Idempotency-Key | ws7a-meta | planned |
| PS-15 | P1 | Request IDs are not validated or propagated (no access log; nothing passed to worker, providers, AI or MCP) | ws1-security | done (wave 1, 5274252) |
| PS-16 | P1 | API connects as the table owner / BYPASSRLS role: 66 platform-mode call sites run with no RLS; migrations use the same credentials | ws10-data-quality | planned |
| PS-17 | P1 | Security headers: web has no CSP or frame-ancestors (token in localStorage); API has no HSTS and no no-store on authenticated JSON | ws1-security | done (wave 1, 5274252) |
| PS-18 | P1 | Signed media URLs are created one HTTP call per image, inside open DB transactions (public menu latency and pool exhaustion) | ws6-perf | planned |
| PS-19 | P2 | No OpenAPI document; almost no typed responses | ws10-data-quality | planned |
| PS-20 | P2 | Error contract inconsistencies (http_error codes, 400 vs 422, missing requestId, constraint names leaked, no code registry) | ws10-data-quality | planned |
| PS-21 | P2 | Runtime validation gaps: negative limit causes a 500; hand-parsed query params; unvalidated body; raw snake_case audit rows | ws10-data-quality | planned |
| PS-22 | P2 | Pagination is fake, unbounded or inconsistent (29 hard-coded nextCursor:null, branch filter after LIMIT, 4 cursor formats) | ws10-data-quality | planned |
| PS-23 | P2 | HTTP semantics and naming: 46 non-creating action POSTs answer 201; mixed resource naming | ws10-data-quality | planned |
| PS-24 | P2 | Idempotency, inbox and outbox retention; rejected webhooks stored in full; refund key race returns 409 instead of a replay | ws2-payments | partial (wave 1; remainder in follow-ups) |
| PS-25 | P2 | Auth details: HS256 accepted next to JWKS, is_anonymous not rejected, weak invite email binding, key reuse for media and guest tokens | ws1-security | partial (wave 1; remainder in follow-ups) |
| PS-26 | P2 | Scheduled jobs hold session advisory locks on pooled connections (session-pooler lock-in, stuck locks) | ws1-security | done (wave 1, 5274252) |
| PS-27 | P2 | Small hardening items: sandbox transport not env-gated, demo loader in production image, LIKE wildcards unescaped, unused config and dependencies | ws1-security | partial (wave 1; remainder in follow-ups) |
| PCL-01 | P0 | Outbox claim has no lease: concurrent/overlapping workers double-process events (duplicate WhatsApp notifications) | ws1-security | done (wave 1, 5274252) |
| PCL-02 | P0 | Supabase 'realtime' grants let every staff member read orders/messages/reservations/delivery PII via PostgREST (bypasses API role, branch and PII rules); realtime is unused | ws1-security | done (wave 1, 5274252) |
| PCL-03 | P0 | fetch cache:'no-store' disables Chromium's CORS preflight cache: every API call (and every poll) costs an extra OPTIONS round-trip | ws3-staff-shell | partial (wave 1; remainder in follow-ups) |
| PCL-04 | P0 | Authenticated API responses carry no Cache-Control (must be private, no-store) and no Vary: Authorization | ws1-security | done (wave 1, 5274252) |
| PCL-05 | P0 | Dashboard shell: refetches org+entitlements on every navigation, a single transient error permanently replaces the whole dashboard, 3-hop serial waterfall | ws3-staff-shell | done (wave 1, 5274252) |
| PCL-06 | P0 | Data-layer foundation: keyed cache/dedup, pending vs loading, error taxonomy, 401 recovery, sign-out clearing (adopt the proposed CACHE POLICY) | ws3-staff-shell | done (wave 1, 5274252) |
| PCL-07 | P0 | Root layout ships all 13 dictionaries in BOTH locales (116 KB gz) and supabase-js (49 KB gz) to every route incl. guest QR/public site | ws3-staff-shell | done (wave 1, 5274252) |
| PCL-08 | P0 | Guest QR / web-order mobile LCP 5.4-5.8 s, CLS up to 0.38 on dashboards: client-only guest menus, generic skeletons, no reserved media sizes | ws4b-guest | planned |
| PCL-09 | P1 | Open-order queries scan whole order history (Orders 5 s poll, overview live, KDS marker/tickets): add partial indexes + enum comparison | ws6-perf | planned |
| PCL-10 | P1 | DB connection safety: JIT on for OLTP (+260-330 ms on KDS query), pool without connect/statement/idle-in-transaction timeouts | ws1-security | done (wave 1, 5274252) |
| PCL-11 | P1 | Provider/Storage network calls inside DB transactions; 5000-recipient campaign dispatch in one transaction on the request path; tx retry re-runs side effects | ws6-perf | planned |
| PCL-12 | P1 | WhatsApp sender: missing/undecryptable credential loops forever (no attempt++), Retry-After ignored, no jitter, campaigns starve other tenants' transactional messages | ws6-perf | planned |
| PCL-13 | P1 | Outbox/jobs operations: no handler timeout, no retention (outbox, handlings, job_runs ~35k rows/day, idempotency_keys), no dead-letter replay, stuck 'running' job_runs, per-process job cadence | ws1-security | partial (wave 1; remainder in follow-ups) |
| PCL-14 | P1 | Menu/site images: signed URL regenerated every request (exp changes each second) so browsers/CDN never reuse them; served private, max-age=300 | ws6-perf | planned |
| PCL-15 | P1 | Public menu/order endpoints have no Cache-Control or versioning; each guest load runs a fresh RLS transaction (+ select * branches) | ws6-perf | planned |
| PCL-16 | P1 | Order detail payments query (OR across LEFT JOIN) seq-scans all payments; polled every 5 s while drawer open | ws6-perf | planned |
| PCL-17 | P1 | Customers list computes a lateral aggregate over every customer's orders per page (409 ms at 60k customers), OFFSET pagination, count repeats the work | ws6-perf | planned |
| PCL-18 | P1 | Guest QR polling (2.5 s, up to 48 req/min/phone) collides with per-IP read limit (240/min) on shared restaurant Wi-Fi | ws4b-guest | planned |
| PCL-19 | P1 | KDS client: no in-flight/sequence guard (station/branch switch can show wrong station until next order change), overlapping 2 s polls, isNew never clears | ws5-ops | planned |
| PCL-20 | P1 | Branch/filter state not persisted or shared (resets on reload) and per-user prefs not cleared on sign-out (shared tablets) | ws5-ops | planned |
| PCL-21 | P1 | Unprotected mutation buttons (no pending/disable/error handling) and sparse idempotency keys in UI | ws5-ops | planned |
| PCL-22 | P1 | Static /public assets served max-age=0; fonts are 1.13 MB of TTF (no woff2, subsetting, or preload) | ws6-perf | planned |
| PCL-23 | P2 | Realtime is polling-only; add push 'change ticks' with reconnect reconciliation | ws6-perf | planned |
| PCL-24 | P2 | No API response compression and no conditional GET for polls | ws6-perf | planned |
| PCL-25 | P2 | Server in-memory caches are per-instance and incoherent; entitlements cache unbounded; 429 lacks Retry-After header | ws6-perf | planned |
| PCL-26 | P2 | Analytics over long ranges scan raw orders/lines (365-day products 1.5 s, on-disk sort) | ws6-perf | planned |
| PCL-27 | P2 | Landing and public restaurant site HTML are not CDN-cacheable (private, no-store) because locale/host are read from cookies/headers | ws4a-public | planned |
| PCL-28 | P2 | SELECT * on polled list/detail endpoints and full-table admin counters | ws6-perf | planned |
| DF-06 | P0 | Arabic UI renders Arabic-Indic digits (٠-٩) on 25 of 31 pages scanned; ~25 formatters + 52 hard-coded literals; sentences mix both digit sets | lead | done (lead d660d21) |
| DF-08 | P0 | The full menu photo sprite (a grid of Olive Room dishes) is shown as the photo of every dish without an image; the Smash & Co ordering hero uses the Olive dining room | ws4a-public | planned |
| DF-09 | P0 | Restaurant site hero is empty when no hero media is set (no template fallback); 'Chef's favourites' can show a dish from another concept or branch | ws4a-public | planned |
| DF-07 | P0 | User-entered names, phones and addresses are not direction-isolated outside the driver portal, dispatch board, KDS and inbox | ws3-staff-shell | partial (wave 1; remainder in follow-ups) |
| DF-01 | P1 | One is_available flag means both 'not sold at this branch' and 'temporarily unavailable'; a kitchen 86 hides the dish instead of showing it sold out, and staff and guest labels are inverted | ws5-ops | planned |
| DF-02 | P1 | KDS 'Out for delivery' marks a delivery order delivered (terminal, fulfilled) when there is no active driver job | ws5-ops | planned |
| DF-03 | P1 | Restocking leaves the low-stock AI insight open for up to an hour; same-day re-breach is suppressed; a continuing breach creates a duplicate insight each day with stale quantities | ws8-features | planned |
| DF-04 | P1 | P&L double-counts COGS when ingredient purchases are recorded as 'Ingredients' (cogs) expenses alongside item-cost COGS; provider fees plus 'fees' expenses double-count with no warning | ws8-features | planned |
| DF-05 | P1 | The forecast API says isSyntheticData:false for the demo restaurant (generated history); the UI shows no demo or synthetic label; fallback reason is raw English | ws8-features | planned |
| DF-10 | P1 | Local demo data is inconsistent: stock history negative and stamped at load time, expenses cover only 3 of 8 weeks, stale live fixtures (443 h tickets, visit open 14 days, past reservations still confirmed) | ws10-data-quality | planned |
| DF-11 | P1 | Repo demo loader books fixed monthly costs into partial months: the first month gets payroll only against 7 days of revenue, the current month gets no payroll; reconciliation period ends in the future | ws10-data-quality | planned |
| DF-14 | P1 | WhatsApp sends 'Order is on the way' twice per delivery (on both picked_up and en_route) | ws5-ops | planned |
| DF-12 | P2 | Intermittent Vercel staging 502s on static JS chunks: root cause unproven (Vercel edge vs sandbox egress proxy); harness lacks header capture; app lacks chunk-load recovery | ws10-data-quality | planned |
| DF-13 | P2 | Every poller and the KDS board restart (and the KDS blanks) whenever the session value changes, such as a Supabase token refresh | ws10-data-quality | planned |
| DF-15 | P2 | English strings in Arabic UI: unit codes (kg/pcs/l), server-generated insight titles and bodies, raw fallback reasons | ws3-staff-shell | partial (wave 1; remainder in follow-ups) |
| NR-01 | P1 | KDS handoff with an active driver job, and pickup handoff, do not mark the order delivered or paid | lead | not reproduced |
| NR-02 | P1 | Closed visits stay closed after guest and staff reload | lead | not reproduced |
| NR-03 | P1 | Polling does not loop or reopen sheets and drawers | lead | not reproduced |
| NR-04 | P1 | No payroll double-count; no future-dated expenses, orders, payments or movements; no negative current stock; not-offered dishes hidden on every public menu | lead | not reproduced |
| CR-01 | P0 | Reconcile the audit backlog before implementing: merge lead/p0-digits, dedupe overlapping items, settle priority conflicts, apply corrections | lead | done (lead) |
| CR-02 | P0 | CI never runs the web unit tests (including the lead's Western-digits guard); there is no dependency audit and no lint | lead | done (lead 544bf7d) |
| CR-03 | P0 | Error and not-found UX foundation is missing: unbranded English 404 in Arabic, no error or global-error boundaries, and soft-404 (HTTP 200) for unknown restaurants and tokens | ws3-staff-shell | partial (wave 1; remainder in follow-ups) |
| CR-04 | P0 | Western digits: residual sources the lead fix and its guard do not cover (legacy copy to port, demo data, raw guest inputs, server side) | ws3-staff-shell | done (wave 1, 5274252) |
| CR-05 | P1 | Account lifecycle missing: no password reset, no email-confirmation callback, no change password, no Google sign-in (legacy /account had them) | ws8-features | planned |
| CR-06 | P1 | Guest phone entry rejects local Egyptian/Saudi formats and Arabic-Indic digits (an English error), a regression from legacy | ws4b-guest | planned |
| CR-07 | P1 | Staging not fit for provider acceptance or traceable QA: sleeping API and worker, no deployed-commit identity, acceptance harness bypasses the product path | ws10-data-quality | planned |
| CR-08 | P1 | Vulnerable production dependencies: multer DoS reachable on every upload route; postcss advisories via next | lead | done (lead 544bf7d) |
| CR-09 | P1 | Integration setup never shows the merchant's actual webhook URL; activation steps are raw English templates with placeholders | ws2-payments | done (wave 1, 5274252) |
| CR-10 | P1 | No WebKit / iOS Safari coverage anywhere for phone-first guest and driver flows | ws10-data-quality | planned |
| CR-11 | P1 | No visual-fidelity regression gate against legacy: CI ignores snapshots, and the existing baselines encode the non-legacy design | ws10-data-quality | planned |
| CR-12 | P1 | Image pipeline has no resizing or derivatives; up-to-15 MB originals are served to guest menus, and the perf baseline hides this | ws6-perf | planned |
| CR-13 | P2 | Legacy data migration tool unaudited: drops all legacy media and maps the venue QR to a mode 2.0 does not have | ws10-data-quality | planned |
| CR-14 | P2 | No observability for staging QA: no error tracking, structured access log, uptime or queue-lag alerting | ws10-data-quality | planned |
| CR-15 | P2 | Status docs and code comments instruct unsafe or incorrect configuration (beyond PAY-22 and INT-16) | ws10-data-quality | planned |
| CR-16 | P2 | The performance baseline harness exists only in the scratchpad, so before/after measurements cannot be reproduced from the repo | ws6-perf | planned |
