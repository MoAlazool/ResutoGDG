# Deployment readiness

Status legend: ✅ verified here · 🟡 prepared, not executed here · ⛔ blocked (see OPEN_BLOCKERS.md)

## Environments

| | Development | Staging | Production |
|---|---|---|---|
| Database / Auth / Storage | Local Postgres 16 + auth shim ✅, or `supabase start` 🟡 | Supabase `resuto-staging` (free): 22 migrations, real Supabase Auth (ES256/JWKS), private Storage ✅ | Supabase project `resuto-prod` ⛔ B-10 (owner approval) |
| API + worker | `node dist/main.js`, `node dist/worker.js` ✅ | Render `resuto-2-staging-api` (free; worker loop in-process; default image target `staging`, which includes the demo loader) ✅ | separate API and background worker, ≥2 instances; image built with `--target production` (no demo loader, fixtures or media) 🟡 |
| Web | `next dev` / `next start` ✅ | Vercel `resuto-2-staging-web` (private: Vercel Authentication on all URLs) ✅ | same 🟡 |
| AI service | uvicorn | Render `resuto-2-staging-ai` (free) ✅ | same 🟡 |
| MCP server | node | Render `resuto-2-staging-mcp` (free, HTTPS, key required) ✅ | same 🟡 |
| Payments | `PAYMENT_MODE=sandbox` ✅ | provider sandboxes ⛔ B-3 | merchant live accounts ⛔ B-3 |

Staging is live and documented in `docs/STAGING_DEPLOYMENT.md` (verification in `docs/TEST_RESULTS.md`). Nothing deploys to production. The legacy production app (Render +
Vercel `resuto` project + Firebase) is untouched and still deploys from `main`.

## Provisioning a Supabase environment (staging first)

1. Create the project (region close to users: `eu-central-1` Frankfurt is the closest
   generally-available region to Cairo/Riyadh; check current Supabase region list,
   including Middle East availability, before choosing).
2. Link and push migrations: `supabase link --project-ref <ref>` then `supabase db push`
   (migrations are CLI-compatible; history table `supabase_migrations.schema_migrations`).
   Do **not** apply `supabase/local/auth-shim.sql` — Supabase provides the `auth` schema.
3. Run `supabase/tests/rls.test.mjs` against a **branch/staging** database only
   (it resets the schema — never point it at production).
4. Auth: enable email/password (and phone OTP later for drivers); set Site URL and
   redirect URLs to the web origin; rely on JWKS (asymmetric signing keys, preferred)
   or, for a project still on the legacy JWT secret, set `SUPABASE_JWT_SECRET` **and**
   `AUTH_ALLOW_HS256=true` (HS256 is refused next to a JWKS project otherwise). API env:
   `SUPABASE_URL`, `AUTH_DEV_MODE=false`. Keep anonymous sign-ins off (the API refuses
   `is_anonymous` sessions) and turn on leaked-password protection in the dashboard.
5. Storage: bucket `tenant-media` is created by migration `…000700` when the storage
   schema exists; API env `STORAGE_DRIVER=supabase`, `SUPABASE_SERVICE_ROLE_KEY`
   (server only).
6. Realtime / Data API: not used. The web app uses supabase-js for Auth only; client
   roles (`anon`, `authenticated`) hold no privilege on any table (migrations
   `20261020020001`/`…0002`), so do not add tables to the Realtime publication.
7. Backups: enable PITR on production; schedule logical dumps (`pg_dump --schema=public`)
   to separate storage; quarterly restore drill into a scratch project.

## Secrets (per environment, never committed)

API: `DATABASE_URL` (Supavisor pooler works in transaction mode: every request runs in one
transaction and all role/claim settings are `SET LOCAL`/`set_config(..., true)`; the `pg`
driver uses unnamed statements), `SUPABASE_URL`, `SUPABASE_JWT_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `CREDENTIALS_KEYS`
(32-byte keys, rotate by prepending), `AI_SERVICE_TOKEN`,
`WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `GEMINI_API_KEY` (optional).
Web: `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
Provider credentials are **per restaurant** in `integration_connections` (encrypted),
not environment variables.

## Release checklist (staging → production)

- [ ] CI green on the release commit (database security, API, web build, legacy, AI service, MCP).
- [ ] `supabase db push` on staging; smoke tests; Playwright scenarios against staging.
- [ ] Security review of changed endpoints (public routes, webhooks, MCP tools).
- [ ] Provider sandbox verification for every integration being enabled (record evidence).
- [ ] Data migration rehearsal on a sanitized export; reconciliation report clean.
- [ ] Backups verified (restore drill) before production cutover.
- [ ] Owner approval for production deployment and cutover window.
- [ ] Rollback plan: keep legacy running; DNS/feature switch back; `--rollback` per migrated tenant.

## Observability

- Request ids (`X-Request-Id`) on every response; API errors logged with request id.
- Health: API `GET /v1/health` (DB latency), container healthchecks.
- Operational views (platform admin): outbox backlog, failed/dead event handlers,
  webhook inbox failures, scheduled job runs.
- To add before production: structured JSON logs shipped to a log store, error
  tracking (e.g. Sentry), uptime checks, metrics on queue lag and webhook failures.
