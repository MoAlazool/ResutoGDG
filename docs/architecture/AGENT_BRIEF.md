# Brief for module agents (read before writing code)

You are one of several agents building Resuto 2.0 in parallel, each in its own
git worktree. The lead agent integrates your branch. Read, in order:

1. `docs/architecture/MODULE_CONTRACTS.md` — **your ownership row** and the rules.
2. `docs/architecture/SECURITY_MODEL.md`.
3. The migrations in `supabase/migrations/` that define your tables (the schema
   already exists for every module — extend it only with new migration files).
4. `docs/architecture/CURRENT_STATE.md` and `FEATURE_INVENTORY.md` for legacy
   behaviour to preserve; legacy source is in `legacy/` (read-only).
5. Existing code to imitate: `apps/api/src/modules/platform/*` (controller/service
   style), `apps/api/src/modules/kernel/*` (shared services you must use),
   `apps/api/test/{helpers,platform.test,kernel.test}.ts` (test style),
   `apps/web/app/onboarding/page.tsx` and `components/shell/*` (web style).

## Environment

- A PostgreSQL 16 cluster is **already running** on `127.0.0.1:54329` (user
  `postgres`, trust auth). Do **not** run `pnpm db:up`/`db:down` or stop it.
- Use your own databases: `TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54329/resuto_test_<agent>`
  for tests and `postgres://postgres@127.0.0.1:54329/resuto_dev_<agent>` for any
  manual run (create with `node -e "import('./scripts/db/ensure-db.mjs').then(m=>m.ensureDatabase(process.argv[1]))" <url>`
  then `DATABASE_URL=<url> node scripts/db/migrate.mjs`).
- Setup in your worktree: `pnpm install`, then
  `pnpm --filter @resuto/contracts build && pnpm --filter @resuto/integrations build`.
  **Rebuild contracts/integrations after editing them** — the API and web consume `dist/`.
- API tests: `cd apps/api && TEST_DATABASE_URL=… npx vitest run [file]`.
  Typecheck: `npx tsc -p tsconfig.json --noEmit`.
- Web: `cd apps/web && NEXT_TELEMETRY_DISABLED=1 npx next build` must pass.
- If you start servers, use the ports in your task (never 3000/4000) and stop them.
- Python: `python3` 3.13 with pip; install into a venv inside your owned directory.
- Playwright 1.56 with Chromium at `/opt/pw-browsers` (`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`; never run `playwright install`).
- Outbound internet may work through a proxy, but **no provider credentials exist**:
  implement real adapters against official docs, test them with recorded/constructed
  fixtures and signature vectors, and label readiness `implemented_unverified`.

## Rules

- Edit only files you own (your row in MODULE_CONTRACTS.md). Need a change elsewhere
  (kernel, common, another module, shared shell)? Put the exact request in your report.
  Exception: you may add your module's `@Global()` port binding inside your own module.
- Never edit an existing migration; add new files with your prefix.
- Every endpoint: Zod validation, `@RequirePermission`, `@RequiresModule` for paid
  modules, branch checks, audit for staff mutations, idempotency for retryable writes.
- Every module needs integration tests: happy path, validation, permission denial,
  cross-tenant 404, entitlement denial (paid modules), idempotent retry (where relevant).
  Create tenants with `createTenant(t, { planId })` — `pro` includes every module,
  `free` only `core`.
- UI: reuse `@resuto/ui`, `globals.css` classes and tokens; English **and** Arabic
  strings in your `lib/i18n/dict/<file>.ts`; layouts must work in RTL and at 390px.
  Real loading/empty/error states; no placeholder screens.
- Honesty: never fake provider connectivity, metrics, approvals or model results.
  Sandbox/simulated paths are visibly labelled in API responses and UI.
- Commit small, coherent commits on your worktree branch with messages ending:

  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01KQfDKUJFwBhedYiiCZxAc6
  ```

  Do not push, do not create PRs, do not rewrite history.

## Hand-off report (your final message)

1. Branch name and final commit hash.
2. What works, with the exact test commands and pass counts you observed.
3. Endpoints and pages added (paths).
4. Migrations added.
5. Requests for the lead (changes needed outside your ownership), precisely.
6. Known limitations / what is sandbox-only / activation requirements.
