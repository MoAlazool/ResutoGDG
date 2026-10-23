# Resuto 2.0 — handoff report

Branch `claude/relaxed-mayer-omkl3f`. `main`, `legacy/` and every legacy production resource are untouched.
Detailed evidence lives in the documents linked from each section; this page is the summary the owner asked for.

## 1. What is deployed

<!-- DEPLOYED-COMMITS -->

Private staging (Vercel Deployment Protection on; sign in with a Vercel account of team "ta-nk"):

| Service | Where | Commit |
|---|---|---|
| Web | https://resuto-2-staging-web.vercel.app (production deployment of project `resuto-2-staging-web`) | _filled at deploy_ |
| API (+ in-process worker) | Render `resuto-2-staging-api` | _filled at deploy_ |
| AI service | Render `resuto-2-staging-ai` | _filled at deploy_ |
| MCP server | Render `resuto-2-staging-mcp` | _filled at deploy_ |
| Database | Supabase `resuto-staging` (Free plan, PostgreSQL 17) | migrations up to the deployed API commit |

Every API, AI and MCP response carries `X-Build: <service>@<commit>`; `/health` reports the build.
Protection was verified on 2026-10-23: `ssoProtection.deploymentType = all`, no password protection, no trusted IPs,
no protection bypass; every web URL answers 302 to `vercel.com/sso-api` without a Vercel session. The temporary QA
bypass was revoked by the owner and was not recreated.

## 2. Visual comparison with the original Resuto

Gallery (private artifact): https://claude.ai/artifact/PybNvTkVh4jW45QcJ93hZL. It holds 160 captures: 20 screens × desktop
1440 and phone 390 × English and Arabic, with legacy and new side by side, both apps running locally on the same demo
data. Verdicts at `d137414`: 2 match, 18 close, 0 differ. Wave 7 (POL-01..03) addresses the remaining gaps: the
landing floor demo's room architecture, the guest dock badge at 390 px, and the reservation hold note below the fold.
Known remaining differences are listed in the gallery notes. Staff screens add structure that legacy did not have
(new modules); login shows a DEV badge only in local builds.

## 3. Feature-by-feature status

Source of truth: `docs/BACKLOG.md` (227 audited items) and `docs/FEATURE_MATRIX.md` (107 feature rows with route,
controller, persistence, permission, tests).

_Counts filled after wave 7._

Partial items and why (each one names the missing piece):

- **Needs provider credentials or regulator onboarding** (code done, external verification pending): payments
  PAY-21/PAY-22/INT-05/INT-06/INT-16/FT-26 (Paymob, Stripe, Moyasar; Stripe is restricted for EG/SA entities), Meta
  INT-22 (Custom Audience terms, App Review), ZATCA/ETA INT-26/FT-24 (FATOORA/ETA onboarding, ZATCA SDK), Gemini
  INT-30.
- **Needs an owner setting or decision:** PS-16 (switch staging `DATABASE_URL` to the `resuto_api` login), AUTH-03
  (SMTP for real email delivery), CR-07 (always-on API is a paid plan), CR-11 (approve visual baselines from CI),
  VP-24 (a public demo table token), PAY-19 (manager confirmation for large transfers).
- **Needs hardware or services this environment lacks:** CR-10 (real iPhone / WebKit pass), DF-12 (GitHub runner and
  Vercel log access for the edge 502 root cause), B-2 (Docker).
- **Deliberately scoped:** PS-19 describes request schemas and list envelopes but not every response body; PS-13 and
  PCL-25 shared state across API instances (single instance on staging); FT-03 guest loyalty redemption needs phone
  OTP, which needs an SMS/WhatsApp provider.

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
customer-entered reference. Missing verification configuration fails closed. Sandbox transports are gated by
environment and cannot settle live payments or send production tracking events. Details:
`docs/INTEGRATION_READINESS.md`.

## 5. Performance evidence

Same machine, same data, same harness (`scripts/perf/`), baseline `f2b232c` vs after `50ed79b`/`ed4501d`;
full tables and raw JSON in `docs/PERFORMANCE.md` and `docs/perf-results/`.

| Measure | Before | After |
|---|---|---|
| analytics.summary 365 d, p50 | 4,553 ms | 224 ms |
| analytics.summary 30 d, p50 | 697 ms | 61 ms |
| order detail (polled every 5 s), p50 | 453 ms | 9.5 ms |
| KDS full (polled every 2 s), p50 | 127 ms | 10.4 ms |
| customers page 1, p50 | 513 ms | 23 ms |
| orders.active query plan | 36 ms / 121,582 rows | 0.8 ms / 33 rows |
| public menu statements per request | 14 | 4 (ETag 304 on revalidation) |
| guest QR menu, repeat visit | 341 KB | 24 KB |
| web order, repeat visit | 240 KB | 18 KB |
| polled order list on the wire | 4,601 B | 1,114 B (Brotli) |
| landing `/` first-load JS | 377 kB | 220 kB |
| `/pricing` first-load JS | 356 kB | 199 kB |
| website editor first-load JS | 371 kB | 194 kB |

A bundle-budget gate in CI (`scripts/ui/bundle-budget.mjs`) keeps the public, staff and guest groups under budget.

## 6. Test results

_Filled from the final regression run on the deployed commit (see `docs/TEST_RESULTS.md` for every run)._

## 7. Remaining external prerequisites (owner)

None of these block the code; each one turns a "pending" item into a verified one.

1. **Provider test credentials** for the acceptance runs in section 4 (B-3 to B-9, B-17 to B-21).
2. **SMTP** (or another email provider) to verify sign-up confirmation, password reset and email change with real
   inboxes (B-14). Until then these flows are complete but marked unverified. Email verification is never bypassed.
3. **Supabase Auth settings** (free): minimum password length 10 with lower/upper/digit required, Confirm email ON,
   Secure email change ON, Secure password change ON. Leaked-password protection is a paid feature and stays off; a
   client-side check compensates (AUTH-01, `docs/SECURITY_AUTH.md`).
4. **Least-privilege database login**: set a password for `resuto_api` in Supabase and switch the API's
   `DATABASE_URL` to it, keeping the owner URL in `MIGRATION_DATABASE_URL`; then remove `DATABASE_PLATFORM_FALLBACK`
   (steps in `docs/STAGING_DEPLOYMENT.md`). The staging soak showed no missing-grant lines.
5. **Vercel connector grant** for team "ta-nk" in claude.ai (deploys currently use the Vercel CLI login of the
   session container).
6. Optional: `ERROR_TRACKING_DSN` and an uptime monitor; an always-on Render plan for acceptance windows (paid, so not
   done); a real-iPhone pass; approve the CI visual baselines (CR-11).
7. Production: nothing was created or deployed. Production needs a separate approval, a cutover plan and a
   legacy data export (B-10).

## 8. How to resume

`RESUME.md` has the current state and the next task. `docs/OPEN_BLOCKERS.md` lists every blocker with the exact
environment variable names.
