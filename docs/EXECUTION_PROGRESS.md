# Execution progress

Branch: `claude/relaxed-mayer-omkl3f` (parallel migration; `main` and the
legacy deployments are untouched). Nothing has been deployed.

## Milestones

| Stage | Status | Evidence |
|---|---|---|
| A — Snapshot & audit | ✅ Done | Legacy moved to `legacy/` unchanged (76/77 tests pass, 1 skipped needs the Firebase emulator — same as before). Audit docs in `docs/architecture/`, UI inventory + baseline screenshots in `docs/ui/`. |
| B — Foundation | ✅ Done | pnpm/turbo monorepo; 22 migrations, RLS on every tenant table, `supabase/tests/rls.test.mjs`; API core (auth, tenancy, RBAC, entitlements, audit, outbox, idempotency, storage, credential encryption, event dispatcher, worker); kernel (pricing, orders, payment ledger); cross-module ports. |
| C/D — Module MVPs | ✅ Done | Nine module agents (A, B1, B2, C, D1, D2, E1, E2, F) merged per `docs/architecture/MODULE_CONTRACTS.md`; status per module in `MODULE_STATUS.md`. |
| E — AI & MCP | ✅ Done | FastAPI AI service (forecasting, segments, churn, recommendations, routing; synthetic-data evaluation only), owner assistant (rules mode), ResutoMCP (17 tools, approvals, scoping) + MCP server tested with the official SDK client. |
| F — End-to-end scenarios | ✅ Done | 10 API-level business scenarios (`docs/qa/SCENARIOS.md`), browser journeys against the real API (`docs/qa/BROWSER_E2E.md`), load smoke (`docs/qa/LOAD_SMOKE.md`). All 9 defects found (G-01, G-02, H-1…H-7) fixed with regression tests. |
| G — QA & staging | 🟡 Local QA done; staging blocked | CI green on GitHub; staging/production blocked on B-1 (no Supabase project) and owner approval — see `OPEN_BLOCKERS.md`, `DEPLOYMENT_READINESS.md`. |

Current test counts: `docs/TEST_RESULTS.md`.

## Log

- 2026-10-17 — Repository inspected; baseline verified; legacy preserved; architecture audit.
- 2026-10-17 — Database schema, RLS and security tests; API core; contracts; web shell; kernel.
- 2026-10-17 — CI workflow, Dockerfiles, compose; module agents launched.
- 2026-10-17 — Module agents merged one by one; integration fixes (port wiring, name collisions, deposit-credit ledger ownership, deposit refunds, web attribution, plan limits on order placement).
- 2026-10-17 — Scenario QA (Agent G): 10 scenarios, defects G-01/G-02 fixed. Load smoke passed.
- 2026-10-17 — Browser QA (Agent H): 60 real-API browser tests; defects H-1…H-7 fixed by the lead; all specs now plain regression tests.
