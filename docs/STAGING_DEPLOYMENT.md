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
| `MIGRATION_DATABASE_URL` | optional secret: the schema owner's URI for migrations and the demo loader once `DATABASE_URL` is the restricted `resuto_api` login (see "Least-privilege database role") |
| `DATABASE_PLATFORM_ROLE` | optional, default `resuto_platform`; `off` is an emergency switch (owner connection only) |
| `DATABASE_PLATFORM_FALLBACK` | optional, `off` (default) or `log-and-retry` (staging soak only: a denied platform transaction is re-run as the owner; see PS-16 below) |
| `RATE_LIMIT_STORE` | optional, `memory` (default) or `postgres` for limits shared across instances (PS-13) |

Start command: `node scripts/deploy/start-api.mjs` (migrations, then the API, then the optional demo loader).

**Web (`resuto-2-staging-web`)**: `NEXT_PUBLIC_API_URL`, `API_INTERNAL_URL`, `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY` (publishable key), `NEXT_PUBLIC_APP_ORIGIN`, `NEXT_PUBLIC_DEMO_SLUG`,
`NEXT_PUBLIC_MCP_URL`, `NEXT_PUBLIC_AUTH_EMAIL_DELIVERY=limited` (no SMTP sender yet; see Supabase Auth below),
`APP_HOSTS=resuto-2-staging-web.vercel.app,.vercel.app`. Optional guest-address forwarding (REM-A11): the same
`CLIENT_IP_FORWARD_SECRET` as the API plus `WEB_TRUST_PROXY=x-real-ip` (Vercel overwrites X-Real-IP); with either
unset nothing is forwarded and guest pages share the web server's rate-limit bucket at the API. Only `NEXT_PUBLIC_*`
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

## Least-privilege database role (PS-16)

Migrations `20261022030001_runtime_roles.sql` and `20261022030002_rate_limit_windows.sql` create two roles **without
LOGIN and without a password** (no credentials ever live in a migration):

| Role | What it is | Can do |
|---|---|---|
| `resuto_api` | the runtime identity for the API | nothing on its own (`NOINHERIT`, `NOBYPASSRLS`, owns nothing); it may `SET ROLE` to the three execution roles below |
| `resuto_member` / `resuto_tenant` | existing RLS execution roles (staff in one restaurant / guest, webhook or job in one restaurant) | what their RLS policies allow |
| `resuto_platform` | cross-tenant lookups and platform work (QR, slug, host and token lookups, webhook inbox, outbox claim, memberships, scheduled jobs, platform admin) | only the tables and commands granted to it with explicit `platform_*` policies, plus `EXECUTE` on four owner-defined `SECURITY DEFINER` functions (`app.notification_recipient_emails`, `app.analytics_discover_days`, `app.analytics_refresh_day`, `app.reconcile_customer_stats`; fixed `search_path`, revoked from `PUBLIC`). Never DDL, never other tables, never `auth.users` on Supabase |

Platform mode runs as `resuto_platform` (`DATABASE_PLATFORM_ROLE`, default `resuto_platform`) on today's single
owner `DATABASE_URL` too, so a platform statement the role was not granted fails. On an owner connection that is a
guard against mistakes, **not an enforced boundary**: the owner session can `SET ROLE` back to itself, so SQL injected
into a platform path would still run with owner rights. PS-16 is complete only once `DATABASE_URL` is the restricted
`resuto_api` login (steps below); until then the boot log says `owner/privileged`.

`DATABASE_PLATFORM_FALLBACK` (default `off`) controls what happens when the platform role is denied:

- `off`: the request fails with the permission error (a missing grant is a bug to fix with `app.grant_platform`).
- `log-and-retry` (opt-in, for a staging soak before the switch; owner connections only, ignored on `resuto_api`): the
  denial is logged at error level (`platform role lacks a grant`) and the whole transaction is re-run as the owner,
  callback included. While it is on, the platform role restricts nothing; the boot log says
  `platform mode runs as resuto_platform, NOT enforced`. Do not set it in production.

**Switching the API to the restricted login (owner steps, Supabase dashboard; nothing here is automated):**

1. Supabase → SQL editor, as `postgres`, generate a long random password locally (for example
   `openssl rand -base64 36`) and run, pasting it in place of the placeholder (never commit or share it):
   `alter role resuto_api with login password '<generated password>';`
   Optionally cap its connections: `alter role resuto_api connection limit 20;`.
2. Check the role: `select rolname, rolsuper, rolbypassrls, rolinherit, rolcanlogin from pg_roles where rolname = 'resuto_api';`
   must show `f, f, f, t`.
3. Render → API service → Environment:
   - `MIGRATION_DATABASE_URL` = the current owner URI (the value `DATABASE_URL` has today). Migrations
     (`scripts/db/migrate.mjs`) and the demo loader use it.
   - `DATABASE_URL` = the same pooler URI with the user `resuto_api.<project-ref>` (session pooler, port 5432) and the
     new password. Keep `DATABASE_SSL_CA`.
4. Deploy. The boot log line `database role resuto_api (restricted)` confirms the switch
   (`owner/privileged` means the API still uses the owner). Run `node scripts/staging/smoke.mjs`.
5. Rollback: set `DATABASE_URL` back to the owner URI (remove `MIGRATION_DATABASE_URL`); no migration is involved.
   Emergency only: `DATABASE_PLATFORM_ROLE=off` makes platform mode use the connection's own role (works on an owner
   connection only).

Proof that nothing needs `BYPASSRLS`: `cd apps/api && TEST_DATABASE_URL=... npx vitest run -c vitest.restricted.config.ts`
runs the whole API suite with the API connected as `resuto_api` (the test setup gives it a per-run random password on
the disposable local cluster), and `supabase/tests/runtime-roles.test.mjs` checks the roles and grants.

## Shared rate limits (PS-13)

`RATE_LIMIT_STORE=memory` (default) counts fixed windows per API process. With several API instances set
`RATE_LIMIT_STORE=postgres`: counters are shared through `public.rate_limit_windows` (keyed by a SHA-256 of the limiter
key, which contains the client IP that `TRUST_PROXY` resolves, or a token hash; rows expire with their window).
Two paths (`apps/api/src/common/http/rate-limiter.ts`):

- **Authoritative** (`await limiter.guard()`): one atomic upsert-and-read per request, so all instances together admit
  exactly the limit, bursts included. Used for every brute-force or abuse limit: dev sign-in/sign-up/password,
  delivery OTP, organisation creation, sales inquiries, reservation holds, web order placement and rating,
  WhatsApp/Meta webhook verification, the integrations OAuth callback, MCP client registration, tracking context.
- **Batched** (`limiter.hit()`): high-volume public reads and polling (limits of 60 per minute and more) and the
  per-phone budgets checked inside a tenant transaction. Each instance flushes its increments at once on the first hit
  of a window and then about every 200 ms, deciding with the shared count it last read plus its own unflushed hits;
  a burst that lands on several instances inside one flush interval can exceed the limit by what the others admitted
  in that interval.

If the database is unreachable both paths keep counting in memory (fail open, logged) rather than refusing traffic.

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
   `node scripts/staging/browser-check.mjs` (environment variables listed at the top of each script), then the three
   flow checks below (`eid-check.mjs`, `onboarding-check.mjs`, `pos-check.mjs`).

## Flow checks: the "Eid offers" change set, the Free onboarding and the POS device API (2.1, plan §12.3)

Three scripts that write labelled test data, so they refuse any host that is not loopback or does not name itself staging
(`staging`/`stg` in the host name; `ALLOW_NON_STAGING=1` overrides). Rows print as `✓` passed, `✗` failed, `⊘` blocked
(the step could not run here; the reason is printed, nothing is faked) and `·` notes. Exit code **0** all passed,
**1** a check failed, **3** nothing failed but a step was blocked, **2** missing configuration. Both print the deployed
builds, honour `EXPECT_COMMIT=<sha>` and write `{ at, title, builds, results, notes, … }` to `SMOKE_REPORT=<file>` like
`smoke.mjs`. They never print passwords, tokens or the MCP key (details are redacted). Pure helpers:
`scripts/staging/lib/check-kit.mjs`, unit-tested by `node --test scripts/staging/test/*.test.mjs` (CI runs it).

### `scripts/staging/eid-check.mjs`

The change-set flow end to end on a **dedicated test tenant, never the demo restaurant**: MCP connection key → MCP
`list_menu` / `get_website_draft` → `propose_changes` with one set (an `offers` section "Eid offers" with three dishes
and `product.discount.set` 15 % on each) → `approval_required`; the staff API shows `pending_approval` (origin `mcp`,
before/after prices) and the canvas preview diff (one added section, three repriced dishes); prices are unchanged →
the owner approves through `POST /o/:orgId/change-sets/:id/approve` → `applied`: prices at 85 % with the original as the
was-price (`compareAtMinor`), the draft has the section, `get_approval_status` says executed → MCP
`publish_website_revision` → `/v1/public/sites/<slug>` (and `WEB_URL/r/<slug>` when given) shows the section → the
change set's audit trail has every transition and op, and `GET /mcp/calls` links the proposal and its approved
execution → cleanup.

| Variable | Staging | Notes |
|---|---|---|
| `API_URL`, `MCP_URL` | required | |
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` | required | |
| `STAGING_CHECK_EMAIL`, `STAGING_CHECK_PASSWORD` | required | a dedicated staging account, **not** a demo account: create it once (Supabase → Authentication → Add user, auto-confirm), or let the check create it confirmed when `SUPABASE_SERVICE_ROLE_KEY` is set |
| `STAGING_CHECK_TOTP_SECRET` | optional | the base32 secret of that account's authenticator, only if it enrolled one: approving and creating MCP keys then need aal2, and the check verifies a TOTP code through Supabase (challenge + verify). Without it such a step is reported **blocked**, never bypassed |
| `SUPABASE_SERVICE_ROLE_KEY` | optional | only to create the dedicated account on first use |
| `WEB_URL`, `VERCEL_BYPASS` | optional | the rendered `/r/<slug>` check; without the bypass the private web app answers 401/302 and that row is blocked |
| `EID_TENANT_PREFIX` (`stg-check-eid`), `EID_PLAN` (`pro`) | optional | |

**Data it creates and keeps:** the dedicated account; one restaurant `stg-check-eid-<yyyymmddhhmm>-<hex>` named
"Staging check: Eid (test data)" on a 14-day **paid trial** (`EID_PLAN`; the flow needs the Studio and MCP modules); a
category "Staging check (test data)" with three dishes "Eid check: … (test)". Later runs **reuse** that restaurant while
its trial is live and create a new one (same prefix) once it has lapsed to Free; lapsed ones are left as they are
(a user may own at most 10 restaurants). Per run, kept as history: the two change sets and their audit rows, the
revoked MCP connection ("Staging Eid check <run> (temporary)") and its call log, and three website revisions (publish,
cleanup republish).
**Cleanup per run:** the MCP key is revoked (and checked refused), the Eid section is deleted and the site republished,
the discounts are ended through a second change set the owner approves (original prices back, no was-price). A run
that stops early still revokes its key; the next run first ends leftover discounts and removes a leftover Eid section.
If the approval is blocked (MFA without the secret) the set stays pending and expires by itself after 24 h. Lapsed
Eid tenants can be removed with the SQL shown for the onboarding leftovers below, using `'stg-check-eid-%'` (checked on
a local database: the delete cascades through change sets, audit rows and MCP connections).
**MFA, honestly:** the result says which session approved (from the audit row's `aal`). A staging account without a
verified factor approves on a password session (`aal1`), because MFA is opt-in on the Free plan; the note says so.

Local stack (development issuer, the way it was verified):
`AUTH_MODE=local API_URL=http://127.0.0.1:4681 MCP_URL=http://127.0.0.1:7381 WEB_URL=http://localhost:3681 node scripts/staging/eid-check.mjs`
(the account `stg-check-eid-owner@example.test` is created on first use; `STAGING_CHECK_EMAIL`/`_PASSWORD` override).

### `scripts/staging/onboarding-check.mjs`

A brand-new owner through the wizard's API calls: signup → `GET/PUT /onboarding/progress` after each step →
web-address availability → `POST /orgs` on **Free** → service mode → theme preset (`PUT /o/:orgId/brand`) → one
category and two dishes → `POST /o/:orgId/brand/publish` → `GET /o/:orgId/menu-qr` (view-only: opens `/m/<slug>`, no
table or venue token; the PNG and SVG are saved to a temporary folder whose path is printed) → wizard done → plan is
`free` and the full Studio answers 402 → `/v1/public/menu/<slug>` and `/v1/public/sites/<slug>` (no tokens) → with
`WEB_URL`, `/m/<slug>` renders the dishes and the "This menu is for browsing" notice with **no cart or ordering UI**
(no Add/stepper/dock classes, no Add button, no checkout, no ordering assistant, no `/t/`, `/v/` or `/order/` link) and
`/r/<slug>` renders the site. The PDF posters are made in the browser and are not checked here. The known gap that a
Free owner can still open the ordering-QR routes (pinned by `apps/api/test/onboarding-free.test.ts`) is printed as a
note and not asserted either way.

| Variable | Staging | Notes |
|---|---|---|
| `API_URL`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` | required | |
| `SUPABASE_SERVICE_ROLE_KEY` | needed to run past signup | staging has "Confirm email" ON and no SMTP sender, so the public signup returns no session (or the built-in sender refuses the address). The check then confirms **its own throwaway** through the Admin Auth API and says so in the row. Without the key the signup row is **blocked** (exit 3) |
| `DEMO_ADMIN_PASSWORD` (+ `DEMO_EMAIL_DOMAIN`) or `ADMIN_EMAIL`/`ADMIN_PASSWORD` | optional | a superadmin to suspend the throwaway tenant; an admin with an authenticator gets a blocked row instead |
| `WEB_URL`, `VERCEL_BYPASS` | optional | the rendered `/m` and `/r` checks |
| `ONBOARDING_PREFIX` (`stg-onb`), `ONBOARDING_EMAIL_DOMAIN` (`DEMO_EMAIL_DOMAIN`, else `olive-room.demo.test`) | optional | |

**Data it creates:** per run one account `stg-onb-<yyyymmddhhmm>-<hex>@<domain>` (random password, never printed) and
one Free restaurant with the same slug, named "Staging check: onboarding (throwaway)", with two "(test)" dishes and a
published site. **Cleanup:** Resuto has no account or restaurant deletion API (the account lifecycle covers password,
email and sign-in only), so the check neutralises and lists what remains: the owner deactivates the branch (the public
menu answers 404), a platform admin suspends the tenant when credentials are given (the site answers 404, staff access
ends; it also drops out of `/me`), and with the service-role key the Supabase user is **banned** for ten years and its
name cleared (not deleted: rows such as `created_by` still reference it). To remove the leftovers for good, a platform
operator runs in the Supabase SQL editor, after checking the list:
`select id, slug, status from organizations where slug like 'stg-onb-%';` then
`delete from organizations where slug like 'stg-onb-%';` (organization deletion cascades, migration `20261022020001`)
and deletes the `stg-onb-…` users under Authentication → Users.

Local stack: `AUTH_MODE=local API_URL=http://127.0.0.1:4681 WEB_URL=http://localhost:3681 [ADMIN_EMAIL=… ADMIN_PASSWORD=…] node scripts/staging/onboarding-check.mjs`
(the development issuer signs up without confirmation and has no account lifecycle, so the account stays in the
local database).

### `scripts/staging/pos-check.mjs`

The POS device API 0.2.0 (`docs/api/IPAD_INTEGRATION.md` §4, §5, §8) with a **simulated iPad** (a scripted HTTP client,
as `tests/e2e/pos-ipad.spec.ts` does locally) on a **dedicated test tenant, never the demo restaurant**. Each step is a
row: the owner pairs a staff-only (`requireStaff`) waiter iPad for branch A (code → `rpos_` credential) → `GET
/v1/pos/session` works and returns only the credential's prefix → without `X-Resuto-Staff-Authorization` every other
route is `401 pos_staff_required`, a malformed staff header `401 unauthorized`, and the credential on a staff route
`403 pos_device_only` → the waiter signs in on the iPad (staff on the session, waiter ∩ waiter permissions) → menu,
floor and orders sync with cursors (`unchanged: true` / `mode: delta`) → quote, submit with a `clientOrderId` (201,
channel `pos`), replay (same order, `Idempotent-Replayed: true`), the same id with another body (`409
client_order_id_reused`), `GET /v1/pos/orders/by-client-id/:id` (accepted; unknown → 404) → the event feed applied as
the app must (dedupe by `seq`, each new event exactly the last `seq` + 1, same epoch) → a kitchen iPad: the waiter there
gets waiter ∩ kitchen permissions and cannot submit (403 `forbidden`) → the kitchen bumps the order from the **staff
API**: the device's long-poll (`wait=10`) delivers `ticket.status_changed` and the orders delta shows `preparing` → a
second bump while the device is "offline", then it resumes from its last `seq`; re-reading applies nothing twice; a
foreign epoch is `409 resync_required` → a branch price change while the device was offline: `409 pos_price_changed`
with per-line details and nothing created, then the reviewed resubmit of the same `clientOrderId` is 201 → a stale
`version` is `409 stale_order` → cash payment with a `clientPaymentId` (paid; the replay returns the same payment;
`payment.captured` in the feed) → a branch-B device gets 404 on branch A's order (read, pay, reconcile) and the
A-scoped waiter on it is `403 pos_staff_not_allowed` → cleanup → every device of the run revoked, then `401
device_revoked`.

Contract notes: a waiter on a **cashier** device *can* take payment (both roles hold `payments:collect`), so the
intersection is shown with the kitchen device; a device of another branch answers **404** (not 403) for that branch's
orders, as the contract says.

| Variable | Staging | Notes |
|---|---|---|
| `API_URL`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` | required | |
| `STAGING_CHECK_EMAIL`, `STAGING_CHECK_PASSWORD` | required | the same dedicated owner account as `eid-check.mjs` (it owns at most 10 restaurants across both checks) |
| `STAGING_CHECK_STAFF_EMAIL`, `STAGING_CHECK_STAFF_PASSWORD` | required | a second dedicated account (not a demo account), created once like the owner, or by the check when `SUPABASE_SERVICE_ROLE_KEY` is set. The owner invites it as a **waiter scoped to branch A** (invitation link, no email) and it accepts through the API |
| `STAGING_CHECK_TOTP_SECRET` | optional | only if the owner enrolled an authenticator: inviting or re-scoping a member needs aal2 (pairing does not). Without it those steps are **blocked** |
| `SUPABASE_SERVICE_ROLE_KEY` | optional | only to create the two dedicated accounts on first use |
| `POS_TENANT_PREFIX` (`stg-check-pos`), `POS_PLAN` (`pro`) | optional | |

**Data it creates and keeps:** the waiter account; one restaurant `stg-check-pos-<yyyymmddhhmm>-<hex>` ("Staging check:
POS (test data)") on a 14-day paid trial with branch A ("POS check branch A (test)") and branch B ("POS check branch B
(test)"), a category "POS check (test data)" with two "(test)" dishes, a floor with table T1, and the waiter's
membership. It is reused while the trial is live, as for the Eid tenant. Per run, kept as history: two pickup orders
named "staging POS check (test)" (one paid in cash and handed over, one cancelled), their kitchen tickets, print jobs
and event-feed rows, one cash payment in that tenant's ledger and analytics, and three revoked devices ("Staging check
… <run>"). **Cleanup per run:** the branch price override is removed right after the conflict step (and at the start of
the next run if a run stopped there), the paid order is moved to `picked_up` (no longer open), the unpaid order is
cancelled through the staff route (devices have no `orders:cancel`), and every device paired in the run is revoked
(checked: `401 device_revoked`). Pairing is limited to 30 codes per address per 10 minutes; a run uses 3.

Local stack: `AUTH_MODE=local API_URL=http://127.0.0.1:4681 node scripts/staging/pos-check.mjs` (the owner
`stg-check-pos-owner@example.test` and the waiter `stg-check-pos-waiter@example.test` are created on first use; the
`STAGING_CHECK_*` variables override them). Only the API (+ worker) is needed.

**Local stack used to verify them** (from a worktree): migrate a fresh database
(`scripts/db/ensure-db.mjs` + `scripts/db/migrate.mjs`, as `tests/e2e/start-api.mjs` does), build the API
(`tsc -p tsconfig.build.json`) and run `dist/main.js` + `dist/worker.js` with `NODE_ENV=development AUTH_DEV_MODE=true`
and a 32+ character `SUPABASE_JWT_SECRET`; build the MCP server and run it with `MCP_PORT`, `RESUTO_API_URL`; build and
`next start` the web app with `NEXT_PUBLIC_API_URL` and `APP_HOSTS=localhost,127.0.0.1`.

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
