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

## Free-plan behaviour (accepted for staging) and the always-on decision

- Render free services **sleep after 15 minutes without traffic**; the first request after that takes
  about 20–60 seconds (a cold `/v1/health` measured 22.9 s, the AI service 23.7 s). The web app shows its
  loading state meanwhile.
- Render's free plan has no background workers, so the outbox/job loop runs **inside the API process**
  (`RUN_WORKER_IN_PROCESS=true`). Events and scheduled jobs run only while the API is awake: reservation-hold
  expiry, checkout expiry, 30-second delivery offers and outbox notifications stall while it sleeps, and
  provider webhooks reach a sleeping API (providers retry). A paid plan would run `node dist/worker.js` as a
  separate background worker (no code change).
- Supabase free projects pause after a week without activity (restore from the dashboard).

**Always-on is an owner cost decision (CR-07).** For provider acceptance windows the API (and its in-process
worker) must stay awake. The supported options are a paid Render instance for the API (and a background worker),
or the owner scheduling traffic for the window. This repository deliberately ships **no keep-alive pinger**:
working around the free plan's sleep would bypass Render's free-plan terms. Until the owner decides, expect the
cold starts above and say so in QA results.

## Build identity on every service (CR-07)

Each QA result must name the code it tested:

| Service | Where | What |
|---|---|---|
| API | `GET /v1/health` → `build { commit, branch, builtAt, startedAt }`; `X-Build: api@<sha12>` on every response | Render's `RENDER_GIT_COMMIT` / `RENDER_GIT_BRANCH` |
| AI | `GET /v1/health` → `build`; `X-Build: ai@<sha12>` | same |
| MCP | `GET /health` → `build`; `/health?deep=1` also reports the API's `X-Build`; `X-Build: mcp@<sha12>` | same |
| Web | `GET /api/version` → `{ commit, branch, builtAt }` (rendered at build time); `X-Build: web@<sha12>` | Vercel's `VERCEL_GIT_COMMIT_SHA` |

`builtAt` is `BUILD_TIME` when the build sets it, otherwise the build time of the compiled code. A service that
reports `commit: null` / `X-Build: …@local` was not built by the platform. `node scripts/staging/smoke.mjs` prints
every service's build and fails with `EXPECT_COMMIT=<sha>` when one of them runs another commit;
`SMOKE_REPORT=<file>` writes the results with the builds as JSON. Record that block in every QA row of
`docs/TEST_RESULTS.md`.

## Observability without a paid service (CR-14)

- **Access log**: one JSON object per response on stdout in staging and production (`LOG_FORMAT=json` is the
  default there): `ts, level, type: "access", service, build, requestId, method, route` (the route *pattern*,
  never the raw path, which can hold guest or payment tokens), `status, ms, orgId, actor, ip`. Render's log
  stream shows it; any log drain can parse it. The request id is the validated `X-Request-Id` (PS-15).
- **Error tracking (optional)**: set `ERROR_TRACKING_DSN` to a Sentry-compatible DSN (Sentry's free tier, or a
  self-hosted GlitchTip) on each service that should report: the API (and worker), the AI service, the MCP server
  and the web app (Vercel, server-only variable; server render/route errors through `instrumentation.ts`,
  `onRequestError`). Unset = off. Unexpected 500s and crashes are sent in the Sentry envelope format with no
  new dependency, carrying only the error type, a scrubbed message and stack, the route pattern, the request id,
  the commit and the environment — never bodies, headers, query strings, user ids, emails, phone numbers or
  tokens (`apps/api/src/common/observability/error-tracking.ts`). A process crash (API or worker) always writes
  one `{"level":"fatal","msg":"process crash",…}` JSON line on stderr (kept by the log stream even without a DSN),
  waits up to 2 s for the error tracker, then exits 1 as Node would.
- **Operational detail**: `GET /v1/health/details` returns `status: ok | degraded` with reasons, the outbox
  backlog and the age of the oldest unpublished event, running/failed/dead event handlers, the last run and 24-hour
  failures of every scheduled job, and webhook receipts and failures per provider in the last 24 hours (counts only).
  It answers 404 unless called with `Authorization: Bearer <HEALTH_DETAILS_TOKEN>` (a secret of 24+ characters
  set in Render) or by a platform admin.
- **Uptime check the owner can enable** (free tiers of UptimeRobot, Better Stack or Cronitor): an HTTP monitor
  every 5 minutes on `https://resuto-2-staging-api.onrender.com/v1/health/details` with the header
  `Authorization: Bearer <HEALTH_DETAILS_TOKEN>`, alerting when the status code is not 200 **or** the body does not
  contain `"status":"ok"`. On the free Render plan a monitor this frequent keeps the API awake, which is the
  always-on question above: enable it only once the owner has accepted that (or point it at a paid instance).
  A monitor on `/v1/health` (no token) checks reachability only.

## Configuration (no secret values here)

**API (`resuto-2-staging-api`)**

| Variable | Value / source |
|---|---|
| `NODE_ENV` | `staging` (refuses `AUTH_DEV_MODE`, requires `SUPABASE_URL` and `CREDENTIALS_KEYS`) |
| `AUTH_DEV_MODE` | `false` |
| `DATABASE_URL` | **secret, set by the owner in Render**: Supabase *session pooler* URI (port 5432). The API holds no session state (per-transaction settings, transaction-scoped advisory locks only, scheduled jobs claimed through the `job_leases` table), so the transaction pooler (port 6543) also works. |
| `DATABASE_SSL_CA` | **required in staging and production**: the PEM of Supabase's CA (`scripts/db/certs/supabase-prod-ca-2021.crt`), so the API verifies the pooler's certificate and host name. The API refuses to start with an unverified connection (`sslmode=no-verify` or no CA); any `sslmode` in the URL is ignored once the CA is set. |
| `SUPABASE_URL` | `https://skvnznyfxpxfuzvuipju.supabase.co` (tokens verified with the project JWKS, issuer `<url>/auth/v1`) |
| `SUPABASE_SERVICE_ROLE_KEY` | **secret, set by the owner in Render** (Storage uploads and signed URLs) |
| `SUPABASE_PUBLISHABLE_KEY` | publishable key (demo loader sign-in only) |
| `STORAGE_DRIVER` | `supabase` (private bucket `tenant-media`, signed URLs) |
| `CREDENTIALS_KEYS`, `AI_SERVICE_TOKEN` | secrets generated for staging, stored only in Render (`MCP_INTERNAL_TOKEN` is no longer read; it can be deleted) |
| `SIGNING_KEY` | optional secret (32+ characters; comma-separated, newest first) for delivery-code and media-URL HMACs. Unset: derived from `CREDENTIALS_KEYS`. Every listed key (and every `CREDENTIALS_KEYS` entry) still verifies, so setting or rotating it never invalidates outstanding delivery codes; drop an old entry only after its codes and URLs have expired (a day is plenty). |
| `AI_SERVICE_URL` | `https://resuto-2-staging-ai.onrender.com` |
| `RUN_WORKER_IN_PROCESS` | `true` |
| `PAYMENT_MODE` | `sandbox` (simulated provider only) |
| `APP_ORIGIN`, `API_ORIGIN`, `CORS_ORIGINS` | the staging web URLs and the API URL |
| `DATABASE_POOL_MAX` | `6` (free session pooler) |
| `DEMO_SEED_ON_BOOT`, `DEMO_TARGET`, `DEMO_*_PASSWORD` | demo data on boot (see below); passwords are secrets. The staging database is shared: the loader must run with `--demo-tenant-only` (it refuses otherwise) and only creates or updates the demo tenant |
| `LOG_FORMAT` | `json` (default in staging) |
| `ERROR_TRACKING_DSN` | optional Sentry-compatible DSN; unset = error tracking off. The same variable turns it on for the AI service, the MCP server and the web app (Vercel, server-only) |
| `HEALTH_DETAILS_TOKEN` | optional secret (24+ characters) for the uptime monitor on `/v1/health/details` |

Start command: `node scripts/deploy/start-api.mjs` (migrations, then the API, then the optional demo loader).

**Web (`resuto-2-staging-web`)**: `NEXT_PUBLIC_API_URL`, `API_INTERNAL_URL`, `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY` (publishable key), `NEXT_PUBLIC_APP_ORIGIN`, `NEXT_PUBLIC_DEMO_SLUG`,
`NEXT_PUBLIC_MCP_URL`, `NEXT_PUBLIC_AUTH_EMAIL_DELIVERY=limited` (no SMTP sender yet; see Supabase Auth below),
`APP_HOSTS=resuto-2-staging-web.vercel.app,.vercel.app`. Only `NEXT_PUBLIC_*`
values reach the browser, and none of them is a secret. Build: `apps/web/vercel.json`.

**AI**: `AI_SERVICE_TOKEN`. **MCP**: `RESUTO_API_URL`, `MCP_PUBLIC_URL`, `MCP_PORT=10000`, `MCP_ALLOW_URL_KEY=false`.

## Supabase Auth (Free plan, no SMTP)

Owner decisions 2026-10-21: the project stays on the Free plan, no SMTP provider is bought, nothing paid is enabled.
Full posture and verification status: `docs/SECURITY_AUTH.md`.

- **Site URL**: `https://resuto-2-staging-web.vercel.app`. **Redirect URLs**: none needed for this origin. Supabase
  accepts a redirect with the Site URL's scheme, host and port before it reads the allow list (`IsRedirectURLValid`
  in `supabase/auth`), and the web sends every email link to `<origin>/auth/callback?next=<path>`. The identical
  entry already added is harmless. Add `https://<host>/**` only for another origin (preview or second Vercel URL,
  custom / production domain, `http://localhost:3000/**` for local work against the project). An invalid redirect is
  not reported: Supabase silently falls back to the Referer or the Site URL. Google sign-in (if enabled): the Google
  Cloud OAuth client's redirect URI is `https://skvnznyfxpxfuzvuipju.supabase.co/auth/v1/callback`.
- **Dashboard settings** (Authentication; all available on Free): Confirm email **ON**; Secure email change ON; Secure
  password change ON; minimum password length **10** with required characters (lower, upper, digits); MFA → TOTP
  enrol and verify enabled; rate limits at defaults or lower; CAPTCHA off unless the owner wants a free provider.
  Leaked-password protection is not available on Free: the web's compensating check (Pwned Passwords range API,
  client-side) is described in `docs/SECURITY_AUTH.md`.
- **Email**: with the built-in sender only the project team's addresses receive confirmation, reset and email-change
  messages (a few per hour). Build the web with `NEXT_PUBLIC_AUTH_EMAIL_DELIVERY=limited` so those screens say so;
  remove it once an SMTP sender is configured and verified. Invitations never use email (the inviter copies the link).
- **MFA**: staff can add an authenticator app on Account → Security. Platform-admin routes, payment / integration
  credentials, MCP keys and grants, and role grants then require the code (aal2). To reset a lost authenticator:
  Authentication → Users → the user → remove the MFA factor, after verifying the person out of band.
- **CSP**: the web allows `https://api.pwnedpasswords.com` in `connect-src` (breached-password check).

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

- Database TLS is verified (`DATABASE_SSL_CA`, `apps/api/src/common/db/pg-tls.ts`). The earlier staging setup used
  `sslmode=no-verify`; that is refused now, so the CA must be set before the next deploy.
- Render did not auto-deploy pushes to this branch during setup; deploys were triggered from the
  dashboard/API. Check the GitHub connection before relying on auto-deploy.
- Supabase security advisors (19 Oct 2026): no errors; warnings for 11 `app.*` functions without a fixed
  `search_path`, three extensions in `public`, and leaked-password protection disabled. The functions are fixed
  (search_path and no PUBLIC execute, migrations `20261020010001`/`…020002`); the extensions stay in `public` on
  purpose and leaked-password protection is an owner dashboard action (B-15 in `docs/OPEN_BLOCKERS.md`).
- Client roles: the Data API and Realtime are not used; `anon`/`authenticated` hold no table privilege and there is
  no member read policy on `storage.objects` (migration `20261020020001`, tests in `supabase/tests`).
