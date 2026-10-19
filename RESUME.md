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
| Grounded audit (visual parity, features, integrations, payments, security, perf, defects) | in progress |
| P0 foundations: Western digits 0-9, verified DB TLS, Admin Auth demo provisioning | done on `lead/p0-digits` (merge pending) |
| P0: original landing/design tokens, core visual fidelity, loading foundations, security blockers | next |
| P1: module workflows, payment safety, Meta/WhatsApp/payment adapters, activation tests | pending |
| P2: remaining integrations, Studio AI, MCP interop, advanced performance, research | pending |
| Staging redeploy + full regression on the final commit | pending |

## Next executable task
Read the audit backlog (`docs/BACKLOG.md` once written), then run the P0 implementation workstreams.

## Owner prerequisites (batched; nothing here blocks internal work)
See `docs/OPEN_BLOCKERS.md` → "Owner actions". Provider credentials (Paymob, Stripe, Moyasar, Meta, TikTok, Snapchat,
Foodics, Odoo, Wafeq, Qoyod, ZATCA/ETA, Gemini) are not available; their acceptance scripts are written to run once
configured and are reported as not yet run.
