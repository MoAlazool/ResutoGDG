# RESUME — Resuto 2.0 continuation

Short, current state for whoever picks this up next. Details live in `docs/` (linked below).

## Where things are
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
