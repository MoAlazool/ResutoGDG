# RESUME — Resuto 2.1 (product experience redesign) on top of the 2.0 continuation

Short, current state for whoever picks this up next. Details live in `docs/` (linked below).

## Resuto 2.1 — state (2026-10-26, `d4305a3`)
- Plan: `docs/plans/RESUTO_2_1_PLAN.md`. All 1A/1B/1C workstreams merged; 1D done except the owner-gated staging
  flow checks. Results: `docs/TEST_RESULTS.md` → "Resuto 2.1"; security: `docs/security/THREAT_MODEL_2.1.md`;
  performance: `docs/PERFORMANCE.md` → "Resuto 2.1 before/after" + "Fixes after 1D measurement".
- GitHub CI run 122 green at `d4305a3`. Staging (all four services) at `d4305a3`: smoke 43/43, MCP 7/7, demo integrity holds.
- Render services do NOT auto-deploy on push: use Render `trigger_deploy` per service and the Vercel CLI
  (`vercel api /v13/deployments … --input <json>` with the full sha, target production).
- iPad (Codex, Draft PR #3, branch `feature/ipad-pos`, never modified here): contracts in `docs/api/IPAD_INTEGRATION.md`
  and `IPAD_COMPATIBILITY.md` (POS API 0.2.0). Not staging-verified until `scripts/staging/pos-check.mjs` passes on
  staging, and not "stable" until the real iPad app has run the flow there.

### Next executable task
Owner input first: a dedicated confirmed staging check owner + waiter account (or the staging service-role key) →
run `eid-check.mjs`, `pos-check.mjs`, `onboarding-check.mjs` on staging (`docs/STAGING_DEPLOYMENT.md` "Flow checks") →
if pos-check passes, post the "0.2.0 verified on staging with a simulated client" note on PR #3.
Owner decisions open: threat-model accepted risks A-1…A-13 (§12), G-WA (QR mode; recommendation: close it, use official
coexistence, `research/wa-qr/README.md`), O-2 Turnstile key, O-3 staging `resuto_api` role, O-4 plan matrix (Free still
includes ordering QRs; pinned known gap), PDPL cross-border legal advice, review of the re-recorded visual baselines
(`docs/ui/visual-baselines.json`, "pending owner review"), optional new Vercel bypass for staging browser QA.
Internal follow-ups (not blocking): start `/me` + org + entitlements before hydration; split `ds.css` for guest pages;
enforce the `--web` HTML budgets in CI; intermittent `perf-plans` plan choice on the shared test DB.

## Where things are (2.0)
- Branch: `claude/relaxed-mayer-omkl3f` (Resuto 2.0). `main` and `legacy/` are the original Resuto and are not modified.
- Private staging: web https://resuto-2-staging-web.vercel.app (Vercel login required), API/AI/MCP on Render
  (`resuto-2-staging-*`), Supabase project `resuto-staging`. Setup and access: `docs/STAGING_DEPLOYMENT.md`.
- Deployed SHAs and test results: `docs/TEST_RESULTS.md` (every result names its commit).

## Current programme (started 2026-10-19)
Owner brief: restore the original Resuto UI/UX on the new stack, complete every MVP workflow, make every agreed
integration ready for provider acceptance tests, secure payments/callbacks, improve caching/loading/performance with
measurements, redeploy staging and re-verify.

| Stage | State |
|---|---|
| Grounded audit (227 items; `docs/BACKLOG.md`, `docs/FEATURE_MATRIX.md`) | done |
| P0 foundations: Western digits 0-9, verified DB TLS, Admin Auth demo provisioning, data layer, loading states | done |
| Wave 1: security hardening, payments authenticity + activation, legacy staff shell | done, on staging (API) at `5274252` |
| Wave 2: public pages + Smash storefront, guest ordering/reservations, performance, Meta growth | done, on staging (API) at `85c176e` |
| Wave 3: operations UI (KDS, floor, host, setup), module features (loyalty, notifications, hours/zones…), Studio AI + MCP | done, on staging (API) at `93abad9` |
| Wave 4: other integrations (TikTok/Snap, Foodics, accounting, ZATCA/ETA, domains, notifications, maps, Gemini, push), demo data integrity, observability, QA gates | done, on staging (API) at `d207114` |
| Wave 5: auth hardening (Free plan, no SMTP) + API quality (OpenAPI, errors, validation, pagination, HTTP semantics, least-privilege DB roles, shared rate limits) | done |
| Wave 6: visual parity with the original Resuto (gallery-driven PAR-01..09) + demo loader fixes | done, on staging: web/AI/MCP `145156d`, API `aaec04e` |
| Wave 7: ws13 polish (POL-01..03), ws14a API remainders, ws14b web remainders, ws14c legacy counter / venue QR session (FT-07); demo-loader stale-visit fix, graceful in-process worker shutdown | done, on staging: web/AI/MCP `e711f39`, API `435f602` (smoke 43/43, MCP 7/7, demo integrity holds) |
| Wave 8: ws15 guest repeat-visit LCP race (PERF-01): repeat LCP 1.4 s → 0.3 s | done |
| Final deploy + regression + handoff (`docs/HANDOFF.md`) | done: all four services at `424687d` (smoke 43/43, MCP 7/7, demo integrity holds) |
| CI repair (DB role race, zod/body-parser audit, E2E isolation incl. WebKit, visual DB + baseline recording, action updates) | done: GitHub CI run 61 green at `5c359d5`; all four services redeployed at `5c359d5` (smoke 43/43, MCP 7/7, demo integrity holds) |

## Next executable task
Nothing internal is blocked. Owner-dependent next steps, in order (details in `docs/HANDOFF.md` §7): provider TEST
credentials → run `scripts/providers/acceptance.mjs` per provider and record; switch staging `DATABASE_URL` to the
`resuto_api` login and drop `DATABASE_PLATFORM_FALLBACK`; SMTP to verify email flows; Supabase password settings.
Internal follow-ups if time allows: partial items in `docs/BACKLOG.md` marked "deliberately scoped" (PS-19 response
schemas, PCL-24 render on 304, CR-12 WhatsApp ordering link srcset, VP-17 guest titles, VS-26 AI floor import).
Gallery (v3): https://claude.ai/artifact/PybNvTkVh4jW45QcJ93hZL. Handoff report (Claude Doc, private): https://claude.ai/artifact/9pbcgAUuj4pmYUkwTf1WQJ (repository copy: `docs/HANDOFF.md`).

## Owner prerequisites (batched; nothing here blocks internal work)
- **Vercel**: the claude.ai Vercel connector still has no grant for team "ta-nk", so deploys use the Vercel CLI,
  signed in from the session container through Vercel's device login (owner-approved, 2026-10-21 19:00 UTC; the login
  lives only in that container, so a new container needs `npx vercel login` again). The Git integration builds every
  push to `claude/relaxed-mayer-omkl3f` as a PREVIEW; the staging URL serves PRODUCTION deployments of the staging
  project, created with `vercel api "/v13/deployments?teamId=team_94CSDkNmtVRWYsvcabiFqRSs" --method POST --input <json>`
  (gitSource MoAlazool/ResutoGDG, ref `claude/relaxed-mayer-omkl3f`, full sha, target `production`). Web at
  `7400bb6`: `dpl_BtC8UnscDhMKmUKrqnSNVayoy3MT`, aliased to https://resuto-2-staging-web.vercel.app.
- **Deployment Protection**: verified ON (project `ssoProtection.deploymentType = all`, no password protection, no trusted IPs, 0 protection bypasses; every web URL answers 302 to `vercel.com/sso-api`). The temporary QA
  automation bypass was revoked by the owner; do NOT recreate a bypass without the owner's approval. Browser QA of the
  deployed web needs authorized Vercel access; local builds against local APIs are used otherwise.
- **Supabase** (Free plan, owner decision): Site URL and redirect URL set to the staging origin (no extra callback URLs
  are needed by the code: every redirect is same-origin `/auth/callback?next=…`). Leaked-password protection is a paid
  feature and stays off (compensated client-side, AUTH-01). No SMTP: real email delivery is unverified (B-14). Owner
  dashboard settings still to confirm: minimum password length 10 + required characters, secure email/password change.
See `docs/OPEN_BLOCKERS.md` → "Owner actions". Provider credentials (Paymob, Stripe, Moyasar, Meta, TikTok, Snapchat,
Foodics, Odoo, Wafeq, Qoyod, ZATCA/ETA, Gemini) are not available; their acceptance scripts are written to run once
configured and are reported as not yet run.
