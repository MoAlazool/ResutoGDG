# Deployment readiness

Status legend: ✅ verified here · 🟡 prepared, not executed here · ⛔ blocked (see OPEN_BLOCKERS.md)

## Environments

| | Development | Staging | Production |
|---|---|---|---|
| Database / Auth / Storage | Local Postgres 16 + auth shim ✅, or `supabase start` 🟡 | Supabase project `resuto-staging` ⛔ B-1 | Supabase project `resuto-prod` ⛔ B-1 |
| API + worker | `node dist/main.js`, `node dist/worker.js` ✅ | Container (`apps/api/Dockerfile`) on a managed platform (Render / Fly.io / Railway / Cloud Run) 🟡 | same, ≥2 instances 🟡 |
| Web | `next dev` / `next start` ✅ | Vercel project for `apps/web` (separate from the legacy `resuto` project) or container 🟡 | same 🟡 |
| AI service | uvicorn | container (`apps/ai-service/Dockerfile`) 🟡 | same 🟡 |
| MCP server | node | container, HTTPS only 🟡 | same 🟡 |
| Payments | `PAYMENT_MODE=sandbox` ✅ | provider sandboxes ⛔ B-3 | merchant live accounts ⛔ B-3 |

Nothing in this branch deploys anything. The legacy production app (Render +
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
   redirect URLs to the web origin; copy the JWT secret (HS256 projects) or rely on
   JWKS (asymmetric signing keys). API env: `SUPABASE_URL`, `SUPABASE_JWT_SECRET`
   (if HS256), `AUTH_DEV_MODE=false`.
5. Storage: bucket `tenant-media` is created by migration `…000700` when the storage
   schema exists; API env `STORAGE_DRIVER=supabase`, `SUPABASE_SERVICE_ROLE_KEY`
   (server only).
6. Realtime: enable on `orders`, `order_lines`, `dining_tables`, `service_requests`,
   `reservations`, `delivery_jobs`, `conversations`, `messages` (RLS restricts
   subscribers to their tenants; clients get no write access).
7. Backups: enable PITR on production; schedule logical dumps (`pg_dump --schema=public`)
   to separate storage; quarterly restore drill into a scratch project.

## Secrets (per environment, never committed)

API: `DATABASE_URL` (Supavisor pooler works in transaction mode: every request runs in one
transaction and all role/claim settings are `SET LOCAL`/`set_config(..., true)`; the `pg`
driver uses unnamed statements), `SUPABASE_URL`, `SUPABASE_JWT_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `CREDENTIALS_KEYS`
(32-byte keys, rotate by prepending), `AI_SERVICE_TOKEN`, `MCP_INTERNAL_TOKEN`,
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
