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
| Wave 4b: API quality (OpenAPI, errors, validation, pagination, HTTP semantics, least-privilege DB role, shared rate limits) | in progress |
| P2: remaining integrations, Studio AI, MCP interop, advanced performance, research | pending |
| Staging redeploy + full regression on the final commit | pending |

## Next executable task
Finish ws10b-api-quality (PS-13/16/19-23), merge, redeploy, then the final full regression, legacy-vs-new gallery
and handoff report.

## Owner prerequisites (batched; nothing here blocks internal work)
- **Vercel connector**: the owner reconnected it with access to team "ta-nk" (2026-10-21 ~16:00 UTC), but connectors
  are read when a session starts: the session that was running still gets 403 (it lists no teams). A NEW session can
  redeploy the web app (`resuto-2-staging-web`, project `prj_A49JsL4bfIJHEWP0okbReX9uZ0Iq`) from the branch head and
  read its logs; first step there: `get_project` to confirm access, then redeploy and run the staging checks.
- **Deployment Protection**: verified ON (every web URL answers 302 to `vercel.com/sso-api`). The temporary QA
  automation bypass was revoked by the owner; do NOT recreate a bypass without the owner's approval. Browser QA of the
  deployed web needs authorized Vercel access; local builds against local APIs are used otherwise.
- **Supabase**: turn on leaked-password protection; configure SMTP + Site URL (B-14).
See `docs/OPEN_BLOCKERS.md` → "Owner actions". Provider credentials (Paymob, Stripe, Moyasar, Meta, TikTok, Snapchat,
Foodics, Odoo, Wafeq, Qoyod, ZATCA/ETA, Gemini) are not available; their acceptance scripts are written to run once
configured and are reported as not yet run.
