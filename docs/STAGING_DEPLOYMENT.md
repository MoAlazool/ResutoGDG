# Staging deployment (Vercel + Render + Supabase)

The private staging environment for Resuto 2.0. **Staging only**: synthetic demo data, sandbox
providers, no production resources. The legacy application (Render `ResutoGDG`, Vercel `resuto`,
Firebase) and the `main` branch are not touched by anything below.

## Resources

| Component | Provider | Name / identifier | Plan |
|---|---|---|---|
| Database, Auth, Storage | Supabase | project `resuto-staging` (ref `skvnznyfxpxfuzvuipju`, eu-central-1) | Free |
| Web (Next.js) | Vercel | project `resuto-2-staging-web` (root `apps/web`) | Hobby |
| API + in-process worker | Render | `resuto-2-staging-api` (Docker `apps/api/Dockerfile`, Frankfurt) | Free |
| AI service (FastAPI) | Render | `resuto-2-staging-ai` (Docker `apps/ai-service/Dockerfile`, Frankfurt) | Free |
| MCP server | Render | `resuto-2-staging-mcp` (Docker `apps/mcp-server/Dockerfile`, Frankfurt) | Free |

All services deploy branch `claude/relaxed-mayer-omkl3f`.

| URL | Access |
|---|---|
| `https://resuto-2-staging-web.vercel.app` | **Private**: Vercel Authentication on every deployment URL (`ssoProtection: all`) |
| `https://resuto-2-staging-api.onrender.com/v1/health` | Public health; every non-public route needs a Supabase access token |
| `https://resuto-2-staging-ai.onrender.com/v1/health` | Public health; every model route needs `AI_SERVICE_TOKEN` (called only by the API) |
| `https://resuto-2-staging-mcp.onrender.com/mcp` | Needs an `rmcp_` client key (created by a restaurant owner, scoped, revocable) |

## Free-plan behaviour (accepted for staging)

- Render free services **sleep after 15 minutes without traffic**; the first request after that takes
  about a minute. The web app shows its loading state meanwhile.
- Render's free plan has no background workers, so the outbox/job loop runs **inside the API process**
  (`RUN_WORKER_IN_PROCESS=true`). Events and scheduled jobs run while the API is awake. A paid plan
  would run `node dist/worker.js` as a separate background worker (no code change).
- Supabase free projects pause after a week without activity (restore from the dashboard).

## Configuration (no secret values here)

**API (`resuto-2-staging-api`)**

| Variable | Value / source |
|---|---|
| `NODE_ENV` | `staging` (refuses `AUTH_DEV_MODE`, requires `SUPABASE_URL` and `CREDENTIALS_KEYS`) |
| `AUTH_DEV_MODE` | `false` |
| `DATABASE_URL` | **secret, set by the owner in Render**: Supabase *session pooler* URI (port 5432) with `?sslmode=no-verify`. Session mode is required (scheduled jobs use session advisory locks). |
| `SUPABASE_URL` | `https://skvnznyfxpxfuzvuipju.supabase.co` (tokens verified with the project JWKS, issuer `<url>/auth/v1`) |
| `SUPABASE_SERVICE_ROLE_KEY` | **secret, set by the owner in Render** (Storage uploads and signed URLs) |
| `SUPABASE_PUBLISHABLE_KEY` | publishable key (demo loader sign-in only) |
| `STORAGE_DRIVER` | `supabase` (private bucket `tenant-media`, signed URLs) |
| `CREDENTIALS_KEYS`, `AI_SERVICE_TOKEN`, `MCP_INTERNAL_TOKEN` | secrets generated for staging, stored only in Render |
| `AI_SERVICE_URL` | `https://resuto-2-staging-ai.onrender.com` |
| `RUN_WORKER_IN_PROCESS` | `true` |
| `PAYMENT_MODE` | `sandbox` (simulated provider only) |
| `APP_ORIGIN`, `API_ORIGIN`, `CORS_ORIGINS` | the staging web URLs and the API URL |
| `DATABASE_POOL_MAX` | `6` (free session pooler) |
| `DEMO_SEED_ON_BOOT`, `DEMO_TARGET`, `DEMO_*_PASSWORD` | demo data on boot (see below); passwords are secrets |

Start command: `node scripts/deploy/start-api.mjs` (migrations, then the API, then the optional demo loader).

**Web (`resuto-2-staging-web`)**: `NEXT_PUBLIC_API_URL`, `API_INTERNAL_URL`, `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY` (publishable key), `NEXT_PUBLIC_APP_ORIGIN`, `NEXT_PUBLIC_DEMO_SLUG`,
`NEXT_PUBLIC_MCP_URL`, `APP_HOSTS=resuto-2-staging-web.vercel.app,.vercel.app`. Only `NEXT_PUBLIC_*`
values reach the browser, and none of them is a secret. Build: `apps/web/vercel.json`.

**AI**: `AI_SERVICE_TOKEN`. **MCP**: `RESUTO_API_URL`, `MCP_PUBLIC_URL`, `MCP_PORT=10000`, `MCP_ALLOW_URL_KEY=false`.

## Reproducing from scratch

1. Supabase: create a project (free plan is enough). Copy the session pooler URI (reset the database
   password in the dashboard to obtain one) and a secret API key; keep both out of chat and Git.
2. Render: create three Docker web services from this repository and branch with the Dockerfiles above
   (API context `.`, AI context `apps/ai-service`, MCP context `.`), region Frankfurt, and the variables
   above. Enter `DATABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in the Render dashboard yourself.
3. The API boot applies `supabase/migrations` in order (`scripts/db/migrate.mjs`, recorded in
   `supabase_migrations.schema_migrations`), then starts. With `DEMO_SEED_ON_BOOT=1` it loads the demo
   tenant once (`scripts/demo/README.md`); later boots skip it.
4. Vercel: create a new project from the repository with root directory `apps/web`, add the variables
   above, enable **Vercel Authentication for all deployments**, deploy the branch, and confirm an
   anonymous request is redirected to Vercel login.
5. Verify: `node scripts/staging/smoke.mjs`, `node scripts/staging/mcp-check.mjs` and
   `node scripts/staging/browser-check.mjs` (environment variables listed at the top of each script).

## Notes and limits

- `sslmode=no-verify` encrypts the database connection but does not verify the pooler certificate
  (Supabase's CA is not in Node's default store). Production should pin Supabase's CA.
- Render did not auto-deploy pushes to this branch during setup; deploys were triggered from the
  dashboard/API. Check the GitHub connection before relying on auto-deploy.
- Supabase security advisors (19 Oct 2026): no errors; warnings for 11 `app.*` functions without a fixed
  `search_path`, three extensions in `public`, and leaked-password protection disabled. Tracked in
  `docs/OPEN_BLOCKERS.md`.
