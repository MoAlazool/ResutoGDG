# Resuto 2.0 — handoff report

Branch `claude/relaxed-mayer-omkl3f`, deployed commit **`5c359d5`** (2026-10-24; GitHub CI run 61 green on it). `main`, `legacy/` and every legacy
production resource are untouched. Detailed evidence lives in the documents linked from each section; this page is the
summary the owner asked for.

## 1. What is deployed

Private staging (Vercel Deployment Protection on; sign in with a Vercel account of team "ta-nk"):

| Service | Where | Commit |
|---|---|---|
| Web | https://resuto-2-staging-web.vercel.app (production deployment `dpl_3zK3oCMFqb6eJAFY5jNjkgR7ECNG` of project `resuto-2-staging-web`) | `5c359d5` |
| API (+ in-process worker) | Render `resuto-2-staging-api` | `5c359d5` |
| AI service | Render `resuto-2-staging-ai` | `5c359d5` |
| MCP server | Render `resuto-2-staging-mcp` | `5c359d5` |
| Database | Supabase `resuto-staging` (Free plan, PostgreSQL 17) | migrations through `20261023040002_counter_legacy_revoke` |

Every API, AI and MCP response carries `X-Build: <service>@<commit>`; `/health` reports the build, and the staging
smoke check fails if any service runs another commit. Protection verified on 2026-10-23: `ssoProtection.deploymentType
= all`, no password protection, no trusted IPs, no protection bypass; every web URL answers 302 to `vercel.com/sso-api`
without a Vercel session. The temporary QA bypass was revoked by the owner and was not recreated.

## 2. Visual comparison with the original Resuto

Gallery (private artifact): https://claude.ai/artifact/PybNvTkVh4jW45QcJ93hZL. 160 captures: 20 screens × desktop 1440
and phone 390 × English and Arabic, legacy and new side by side, both apps running locally on the same demo data.
Verdicts: **2 match, 18 close, 0 differ**. The three gaps the gallery still showed (landing floor demo without its room
on phones, guest dock badge clipped at 390 px, reservation hold note below the fold) were fixed in wave 7 and those
screens were recaptured (gallery version 3). Remaining differences are listed per screen in the gallery notes: staff
screens add structure legacy did not have (new modules), the new app uses Western digits in Arabic where legacy used
Arabic-Indic digits (owner requirement), and local builds show a DEV badge on login.

## 3. Feature-by-feature status

Source of truth: `docs/BACKLOG.md` (232 items: the 227 audited plus AUTH-01..04 and PERF-01) and
`docs/FEATURE_MATRIX.md` (feature rows with route, controller, persistence, permission and tests).

| Status | Items |
|---|---|
| Done | **198** |
| Partial (named missing piece) | **25** |
| Deferred by plan | **5** |
| Did not reproduce | **4** |

Every agreed module workflow runs end to end on staging, including the legacy counter / venue QR session (FT-07,
wave 7). Partial items and why:

- **Need provider credentials or regulator onboarding** (code done, verification pending): PAY-21, PAY-22, INT-16
  (payments: Paymob, Stripe, Moyasar; Stripe is restricted for EG/SA entities), INT-22 (Meta Custom Audience terms and
  App Review), INT-26 / FT-24 (ZATCA FATOORA and ETA onboarding, ZATCA SDK; labelled "not certified"), INT-30 (Gemini).
- **Need an SMS/WhatsApp or email provider:** FT-03 (guest loyalty redemption needs phone OTP; staff redemption works),
  FT-06 (notifications are in-app; email/WhatsApp delivery needs a provider), AUTH-03 (real email delivery, SMTP).
- **Need an owner setting or decision:** PS-16 (switch staging `DATABASE_URL` to the `resuto_api` login), CR-07
  (always-on API is a paid plan), CR-11 (approve visual baselines from CI), VP-24 (a public demo table token), PAY-19
  (manager confirmation for large transfers).
- **Need hardware or access this environment lacks:** CR-10 (real iPhone / WebKit pass), DF-12 (GitHub runner and
  Vercel log access for an intermittent edge 502).
- **Deliberately scoped:** PS-19 (OpenAPI describes requests and list envelopes, not every response body), PS-25
  (session-revocation check), PCL-03 / PCL-24 (polls revalidate with ETag/304 but still re-render on start/end),
  PCL-25 (cache coherence across several API instances; staging runs one), CR-12 (the WhatsApp ordering link still
  serves one image size), VP-17 (some guest page titles), VS-26 (AI floor-plan import).

Deferred by plan: FT-18 (collecting platform subscriptions needs a billing provider), PCL-23 (push change-ticks;
polling with ETag/304 is in place), PCL-27 (CDN-cacheable public HTML needs locale-in-path routing), VP-14, VP-23.

## 4. Integrations: ready for acceptance, none verified live

Every adapter, configuration screen, webhook check, retry path and acceptance script is implemented and tested
locally against scripted provider responses and published signature vectors. **No provider has been called with
real credentials. No integration is marked verified, and simulated connections are never shown as live.** The
integrations catalog computes each capability's state; with no acceptance run recorded, the state is "Implemented;
external verification pending" (or "Not configured").

| Area | Providers (`--provider` id) | Needs |
|---|---|---|
| Payments | Paymob HMAC (`paymob`), Stripe (`stripe`), Moyasar (`moyasar`): 16 checks | TEST accounts, keys, webhook secrets (B-3) |
| Meta | Graph version pin (`meta`), WhatsApp Cloud (`whatsapp_cloud`), Pages: Messenger + Instagram (`meta_pages`), Pixel + CAPI (`meta_capi`), Ads (`meta_ads`) | Tech Provider app, WABA test number, test Page/IG, test Pixel, sandbox ad account (B-4, B-5) |
| Ads / tracking | TikTok Events API (`tiktok_events`), Snap CAPI (`snap_capi`) | test pixels and tokens (B-20) |
| POS / accounting | Foodics (`foodics`), Wafeq (`wafeq`), Qoyod (`qoyod`), Odoo (`odoo_accounting`) | developer app / test organisation keys (B-7) |
| Tax | ZATCA Phase 2 (`zatca_fatoora`), ETA e-receipt (`eta_ereceipt`) | FATOORA sandbox OTP + SDK; ETA preprod POS + eSeal (B-6). Labelled "not certified" |
| Domains | Vercel domains API (`vercel_domains`) | token + test zone (B-9) |
| Notifications | Resend (`resend`), Twilio SMS (`twilio_sms`), Web Push (no provider account; VAPID pair) | keys, VAPID pair (B-17, B-18) |
| Maps / AI | Google Routes (`google_routes`), Gemini (`gemini`) | restricted keys (B-19, B-8) |

Run: `node scripts/providers/acceptance.mjs --provider <id>` (`--list` prints every check with its environment
variable names and the manual step before it); record a run with `scripts/providers/record-acceptance.mjs`. Today
every check reports `not_run (not configured)`.

Payment safety, as implemented: a payment is settled only by a verified provider event or a provider re-read with
the merchant's key, never by a redirect, a frontend flag, an SDK message, an unsigned webhook, a screenshot or a
customer-entered reference. Missing verification configuration fails closed. Webhooks are claimed under a lease,
retried with backoff and dead-lettered with an audited replay. Sandbox transports are gated by environment and cannot
settle live payments or send production tracking events. Details: `docs/INTEGRATION_READINESS.md`.

## 5. Performance evidence

Same machine, same data, same harness (`scripts/perf/`); full tables and raw JSON in `docs/PERFORMANCE.md` and
`docs/perf-results/`.

| Measure | Before | After |
|---|---|---|
| analytics.summary 365 d, p50 | 4,553 ms | 224 ms |
| analytics.summary 30 d, p50 | 697 ms | 61 ms |
| order detail (polled every 5 s), p50 | 453 ms | 9.5 ms |
| KDS full (polled every 2 s), p50 | 127 ms | 10.4 ms |
| customers page 1, p50 | 513 ms | 23 ms |
| orders.active query plan | 36 ms / 121,582 rows | 0.8 ms / 33 rows |
| public menu statements per request | 14 | 4 (ETag 304 on revalidation) |
| guest QR menu, repeat visit transfer | 341 KB | 24 KB |
| web order, repeat visit transfer | 240 KB | 18 KB |
| guest dish photos on a phone (srcset) | 218 KB | 91 KB |
| guest pages, repeat-visit LCP (web order / QR menu) | 1,440 / 1,356 ms | 312 / 300 ms |
| polled order list on the wire | 4,601 B | 1,114 B (Brotli) |
| landing `/` first-load JS | 377 kB | 220 kB |
| `/pricing` first-load JS | 356 kB | 199 kB |
| website editor first-load JS | 371 kB | 194 kB |

API figures: baseline `f2b232c` vs `50ed79b`/`ed4501d`. Guest repeat-visit LCP: `e711f39` vs `424687d`, A/B
alternated, 5 runs per build, 4× CPU and 1.6 Mbit/s throttling. A bundle-budget gate in CI keeps the public, staff
and guest groups under budget.

## 6. Test results (deployed commit `5c359d5`)

GitHub-hosted CI run 61 passes all four jobs on `5c359d5`: https://github.com/MoAlazool/ResutoGDG/actions/runs/40101012201
(database security, dependency audit, API as owner and as `resuto_api`, MCP, web, bundle budget, browser E2E on
Chromium and WebKit iPhone 13, visual parity, legacy).

| Suite | Result |
|---|---|
| API integration (110 files, real PostgreSQL) | **914 passed, 4 skipped** |
| Database security / roles / RLS | **82 / 82** |
| Contracts | **63 / 63** |
| Integrations (adapters, signatures, acceptance harness) | **320 / 320** |
| MCP server | **27 / 27** |
| Web unit (incl. Chromium layout and first-paint guards) | **465 / 465** |
| Demo loader / staging / UI scripts | **60 / 60** (48 demo + 12 staging/UI) |
| OpenAPI drift check | **5 / 5** |
| API + web typecheck, web production build, bundle budget | pass |
| E2E Chromium + WebKit iPhone 13 (GitHub CI run 61) | **all pass** (the night-time `branch_closed` failures are fixed: fixture branches are open 24 h) |
| E2E Chromium, guest first paint (ws15 stack) | **2 / 2** |
| Staging smoke (`scripts/staging/smoke.mjs`, commit pinned on API/AI/MCP) | **43 / 43** |
| Staging MCP check | **7 / 7** |
| Staging demo data integrity (boot refresh) | all assertions hold |

Not covered here: a real iPhone (CR-10; WebKit emulation now runs in CI), provider acceptance runs (section 4), real email delivery (AUTH-03).
Every run with its commit: `docs/TEST_RESULTS.md`.

## 7. Remaining external prerequisites (owner)

None of these block the code; each one turns a "pending" item into a verified one.

1. **Provider test credentials** for the acceptance runs in section 4 (B-3 to B-9, B-17 to B-21).
2. **SMTP** (or another email provider) to verify sign-up confirmation, password reset and email change with real
   inboxes (B-14). Until then these flows are complete but marked unverified. Email verification is never bypassed.
3. **Supabase Auth settings** (free): minimum password length 10 with lower/upper/digit required, Confirm email ON,
   Secure email change ON, Secure password change ON. Leaked-password protection is a paid feature and stays off; a
   client-side check compensates (AUTH-01, `docs/SECURITY_AUTH.md`). No extra redirect URLs are needed: every auth
   redirect is same-origin `/auth/callback?next=…`, which Supabase accepts for the Site URL's origin.
4. **Least-privilege database login**: set a password for `resuto_api` in Supabase and switch the API's
   `DATABASE_URL` to it, keeping the owner URL in `MIGRATION_DATABASE_URL`; then remove `DATABASE_PLATFORM_FALLBACK`
   (steps in `docs/STAGING_DEPLOYMENT.md`). The staging soak shows no missing-grant lines.
5. **Vercel connector grant** for team "ta-nk" in claude.ai (deploys currently use the Vercel CLI login of the
   session container).
6. Optional: `CLIENT_IP_FORWARD_SECRET` on the API and web plus `WEB_TRUST_PROXY=x-real-ip` on the web, so guests
   get their own rate-limit buckets; `ERROR_TRACKING_DSN` and an uptime monitor; an always-on Render plan for
   acceptance windows (paid, so not done); a real-iPhone pass; approve the CI visual baselines (CR-11).
7. Production: nothing was created or deployed. Production needs a separate approval, a cutover plan and a legacy
   data export (B-10).

## 8. How to resume

`RESUME.md` has the current state and the next task. `docs/OPEN_BLOCKERS.md` lists every blocker with the exact
environment variable names.
