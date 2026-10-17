# Test results

Integrated branch `claude/relaxed-mayer-omkl3f`, run on 2026-10-17 in the development container
(local Postgres 16 on `127.0.0.1:54329` with the Supabase auth shim; sandbox providers only).
Nothing is skipped to make a suite green. The one skip is the legacy Firebase emulator test, which
was skipped before this work too.

| Suite | Command | Result |
|---|---|---|
| Database security (RLS, grants, constraints) | `node --test supabase/tests/*.test.mjs` | **14 / 14** |
| API integration (37 files, incl. 10 business scenarios with 77 steps) | `cd apps/api && npx vitest run` | **365 / 365** |
| Browser end-to-end (Playwright, real API + worker + built web app) | `pnpm e2e` (see `docs/qa/BROWSER_E2E.md`) | **60 / 60**: 58 in the full run, plus the 2 specs fixed afterwards and re-run (H-2 assertion label, H-3 reload) |
| Web unit | `cd apps/web && npx vitest run` | **25 / 25** |
| Web production build (type-checks every page) | `pnpm --filter @resuto/web build` | ✅ |
| Contracts (money, payments) | `pnpm --filter @resuto/contracts test` | **11 / 11** |
| Integration adapters (signatures, mappers) | `pnpm --filter @resuto/integrations test` | **73 / 73** |
| MCP server (official SDK client against the API) | `pnpm --filter @resuto/mcp-server test` | **19 / 19** |
| AI service | `cd apps/ai-service && .venv/bin/python -m pytest` | **33 / 33** |
| Legacy → Postgres migration tool | `node --test tools/legacy-migration/test/*.test.mjs` | **9 / 9** |
| Legacy application (unchanged) | `cd legacy && npm test` | **76 / 77**, 1 skipped (needs the Firebase emulator, as before) |
| Load smoke (local only) | `scripts/load/load-smoke.mjs` (see `docs/qa/LOAD_SMOKE.md`) | ✅ 2000 menu reads p95 128 ms, 300 concurrent orders with unique numbers, limited stock sold exactly 50 / 100, no 5xx |

## Defects found by QA, all fixed

| Id | Found by | Fix and regression test |
|---|---|---|
| G-01, G-02 | API scenarios (`docs/qa/DEFECTS.md`) | Scenario steps S05 #8 and S10 #4 |
| H-1 … H-7 | Browser QA (`docs/qa/BROWSER_DEFECTS.md`) | The matching Playwright specs, plus API tests for H-1 (`floor.test.ts`) and H-6 (`delivery.test.ts`) |

## What these results do not cover

- No real provider was called: payments, WhatsApp, ads, ZATCA/ETA, accounting, POS and Gemini all ran in
  sandbox or rules mode (`OPEN_BLOCKERS.md` B-3…B-8).
- Supabase Auth (GoTrue) and the JWKS path are untested. Auth used the dev issuer with Supabase's claim
  shape (B-1, B-12).
- AI metrics come from synthetic data only (`research/`).
- In CI the Playwright job runs with `--ignore-snapshots`, because the pixel baselines were recorded on
  this container's fonts.
