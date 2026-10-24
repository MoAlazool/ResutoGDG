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
- The local runs above use the dev issuer with Supabase's claim shape. Real Supabase Auth (GoTrue, ES256
  JWKS) is covered by the staging runs below.
- AI metrics come from synthetic data only (`research/`).
- In CI the Playwright job runs with `--ignore-snapshots`, because the pixel baselines were recorded on
  this container's fonts.

## Staging (deployed services, 2026-10-19)

Run against the live staging environment (`docs/STAGING_DEPLOYMENT.md`): Vercel `resuto-2-staging-web`,
Render `resuto-2-staging-api` / `-ai` / `-mcp`, Supabase project `resuto-staging`. Real Supabase Auth,
Supabase Storage and Postgres; payments and WhatsApp in sandbox mode. Synthetic demo tenant only.

| Check | Command | Result |
|---|---|---|
| Migrations on Supabase | API boot (`scripts/deploy/start-api.mjs`) | 22 / 22 applied; 115 `public` tables, all with RLS; bucket `tenant-media` present |
| Demo data load | API boot with `DEMO_SEED_ON_BOOT=1` | ✅ exit 0; 409 orders, staff, menu photos in Supabase Storage, deliveries, marketing, finance, Studio site |
| Service smoke | `node scripts/staging/smoke.mjs` | **40 / 40**: health (API, worker, AI, MCP); Supabase sign-in, wrong password, ES256 + issuer, refresh, tampered and missing tokens, dev login disabled, sign-out; role boundaries; public pages leak no private fields; signed storage URLs; payment link → sandbox checkout → server-side confirmation; unsigned webhook refused (401); AI forecast; CORS; Vercel redirects anonymous visitors to login |
| MCP over HTTPS | `node scripts/staging/mcp-check.mjs` | **7 / 7**: scoped key, initialize, `tools/list` limited to the key, allowed call, other tool refused, revoke, revoked key refused |
| Browser (real login form, EN/AR, desktop/mobile) | `node scripts/staging/browser-check.mjs` | **102 pages, 0 API errors, 0 broken pages**. Owner, platform admin and both drivers signed in through the form. 7 pages logged a Vercel **502 on a static JS chunk** (the page rendered, but that chunk did not run until reload); re-checking those pages gave 13 / 15 clean, then 13 / 13. See `OPEN_BLOCKERS.md` B-13 |
| API suite after the staging fixes | `cd apps/api && npx vitest run` (local) | **373 / 373** (adds deployment-config and agent-fix tests) |
| Supabase advisors | dashboard / MCP | no errors; warnings tracked as B-14 and B-15 |

Not covered on staging: real payment, WhatsApp, ads or tax providers (sandbox only); email confirmation
and password reset (Supabase SMTP is not configured, B-14); load testing (free plans).

## Continuation wave 1 — integrated (2026-10-20)

Security hardening, payments authenticity/activation and the restored staff shell, merged at `9d2aa9b` and
followed by `5274252` (small integration follow-ups). Local container, own test databases.

| Suite | Commit | Result |
|---|---|---|
| API integration (51 files) | `9d2aa9b` | **473 / 473** |
| Database security | `9d2aa9b` | **28 / 28** |
| MCP server (official SDK client, end to end) | `9d2aa9b` | **19 / 19** |
| Integrations adapters + acceptance runner | `9d2aa9b` | **170 / 170** |
| Contracts | `9d2aa9b` | **22 / 22** |
| AI service | `9d2aa9b` | pass |
| Legacy migration tool | `9d2aa9b` | **9 / 9** |
| Web unit (incl. digits, bidi, dialogs, tokens, CSP, cache policy guards) | `5274252` | **132 / 132** (2 failed at `9d2aa9b`; fixed in `5274252`) |
| Web typecheck / production build | `9d2aa9b`, `5274252` | pass / pass |
| API tests touched by `5274252` (inventory, customers, studio, MCP lockdown, MCP) | `5274252` | **66 / 66** |
| Dependency audit (`pnpm audit --prod --audit-level high`) | `9d2aa9b` | no known vulnerabilities |
| Provider acceptance checks without credentials | `9d2aa9b` | 16 listed, all **not run** (not configured) — as designed |

First integration run caught one real defect: both migrations created the same retention index; fixed in `9d2aa9b`
before anything reached staging.

### Staging after wave 1 (Render API/AI/MCP at `5274252`)

| Check | Result |
|---|---|
| Migrations | 7 new migrations applied over verified TLS (Supabase root CA); API booted |
| `node scripts/staging/smoke.mjs` | **39 / 39** (the Vercel bypass check is not run: no bypass is used) |
| `node scripts/staging/mcp-check.mjs` | **7 / 7** |
| Supabase security advisor | no errors; warnings: 3 extensions kept in `public` (documented), leaked-password protection off (owner setting) |
| Web on Vercel | **not redeployed**: the Vercel connector lost access to the project's team; the web still serves the previous build. Owner action listed in `RESUME.md`. |

## Continuation wave 2 — integrated (2026-10-20, `85c176e`)

Public pages + Smash & Co storefront, guest ordering/reservations/ratings, measured performance work and Meta growth
integrations, merged with two semantic conflict resolutions (media signing moved outside transactions on the site,
storefront and guest menu; the WhatsApp sender's leased/fair architecture now also carries Messenger/Instagram).

| Suite | Result |
|---|---|
| API integration (67 files) | **610 / 610** (one PCL-11 side-effects guard failure found after merging, fixed in `85c176e`) |
| Database security / read models | **40 / 40** |
| Integrations adapters + acceptance runner | **211 / 211** |
| Web unit | **195 / 195** |
| API typecheck, web typecheck, web production build | pass |

Staging (Render API/AI/MCP at `85c176e`): 16 new migrations applied; `smoke.mjs` **39 / 39**; `mcp-check.mjs` **7 / 7**.
The staging demo tenant predates the storefront seed, so the Smash & Co storefront exists only after a fresh demo load.
The web app on Vercel is still not redeployed (connector access, see `RESUME.md`).
Performance before/after numbers: `docs/PERFORMANCE.md` (local, not production capacity).

## Continuation wave 3 — integrated (2026-10-21, `93abad9`)

Operations UI (legacy KDS lanes, floor overview, front desk, visits, order board, 8-step setup, menu & inventory
table, stocktake, 86/sold-out), module features (loyalty ledger, notifications, AI quota, insight templates,
opening hours + delivery zones, P&L policy, journals, billing costs, delivery tracking, account lifecycle) and
Studio/MCP (menu extraction with review/commit, food-photo enhancement pipeline, approved-copy publishing, new MCP
tools with approval binding and OAuth 2.1). Each lane was reviewed independently; the review findings (ws5: 2 major,
5 minor; ws8: 4 major; ws9: 2 major, 3 minor) were fixed before merging. Two cross-lane fixes after merging:
`list_menu` treats a sold-out (86) dish as unavailable (`e591548`); the INT-22 audience dry-run test no longer
depends on row order (`93abad9`).

| Suite | Result |
|---|---|
| API integration | **727 / 727** |
| Database security / read models | **57 / 57** |
| Contracts | **56 / 56** |
| Integrations adapters + acceptance runner | **211 / 211** |
| MCP server | **23 / 23** |
| Web unit | **239 / 239** |
| API typecheck, web typecheck, web production build | pass |

Staging (Render API/AI/MCP at `93abad9`, deployed 2026-10-21 07:17 UTC): 15 new migrations applied
(`20261021010001` … `20261021030006`); `smoke.mjs` **39 / 39**; `mcp-check.mjs` **7 / 7**.
Partial items (remainders tracked in `docs/BACKLOG.md`): VS-25 mobile parity, VS-31 shared ops classes, FT-07
service modes, PCL-21 optimistic actions, VS-26 AI floor-plan import.
The web app on Vercel is still not redeployed (connector access, see `RESUME.md`).

## Continuation wave 4 (integrations, demo data, QA) — integrated (2026-10-21, `a0dfda0` / `d207114`)

Integrations (ws7b): TikTok Events API + Snap CAPI sinks, Foodics OAuth (+ fail-closed menu webhook), accounting push
(Wafeq, Qoyod, Odoo JSON-2 with a /jsonrpc fallback for Odoo 17/18), ZATCA Phase-2 and ETA e-receipt (implemented,
not certified, never run against a sandbox), custom domains on the Public Suffix List, Resend/Twilio channels with
consent, quiet hours and unsubscribe, driver Web Push (RFC 8291/8292, node:crypto), optional Google Routes, one Gemini
client. Demo data and QA (ws10a): demo re-timed relative to load time with a post-load integrity check and a resumable
loader lease, deployed build identity on every service, JSON access log, optional error tracking DSN, health details,
stable session call (DF-13), legacy migration media + venue QR, WebKit/visual/bundle CI gates. Independent reviews:
ws7b 5 major + 4 minor, ws10a 2 major + 5 minor findings, all fixed or explained before merging.

After merging, the bundle gate failed on 4 routes. Root cause (older than wave 4): the landing copy hook and the
website editor's preview imported every dictionary into the browser. Fixed in `a0dfda0`: `/` 377 → 220 kB,
`/pricing` 356 → 199 kB, website editor 371 → 194 kB first-load JS; TikTok/Snap pixel code loads on demand.

| Suite (merged tree) | Result |
|---|---|
| API integration (95 files) | **803 / 803** |
| Database security / read models | **68 / 68** |
| Integrations adapters + acceptance runner | **314 / 314** |
| Contracts | **56 / 56** |
| MCP server | **25 / 25** |
| Web unit | **253 / 253** |
| Demo loader / UI script tests | **38 / 38**, **9 / 9** |
| AI service (pytest) | pass |
| API + web typecheck, web production build, bundle budget gate | pass |
| Provider acceptance without credentials | 40 not_run, 4 blocked, none passed or failed (expected) |

Staging (Render API/AI/MCP): `a0dfda0` applied 8 migrations (`20261022010001` … `20261022020001`); every service
reports its commit in `/health` and `X-Build`. The first boot's integrity check failed 2 assertions on the demo
tenant (rows from the 2026-10-19 loader: 9 Smash & Co dishes without photos, 75 checkout sessions stamped at load
time). `d207114` repairs them on refresh (demo tenant only, nothing deleted); boot log: "repair: 9 dish photo(s)
added, 75 order timeline(s) … re-dated", "all assertions hold". `smoke.mjs` **40 / 40**, `mcp-check.mjs` **7 / 7** at
`d207114`. The Smash & Co storefront is now published on staging (`/r/the-olive-room/smash-and-co`).
The web app on Vercel is still not redeployed (connector access, see `RESUME.md`).

## Continuation wave 5 (auth hardening, API quality) — integrated (2026-10-21, `7400bb6`, `23f0a99`, `688bb4b`)

Auth hardening for the Supabase Free plan (ws11): breached/common password checks (Pwned Passwords k-anonymity range
API; a client-side compensating control because leaked-password protection is a paid feature), TOTP MFA with aal2
step-up for enrolled users on platform-admin, payment/integration credential, MCP and role-grant routes, email flows
completed and labelled unverified without SMTP, `docs/SECURITY_AUTH.md`. API quality (ws10b): one error contract with
a code registry and request ids, validated list queries and keyset pagination with real cursors, 200 for
non-creating actions, OpenAPI 3.1 at `/v1/openapi.json` (487 operations) with a CI drift/style gate, NOLOGIN
least-privilege roles (`resuto_platform`, `resuto_api`; platform mode runs as `resuto_platform`), shared rate limits.
Independent reviews: ws11 2 major + 2 minor, ws10b 4 major + 1 minor; all fixed before merging.

Cross-branch defects found while merging and fixed in `23f0a99`: the MFA guard read `auth.mfa_factors` in platform
mode, which now runs as `resuto_platform` (no rights in Supabase's auth schema) — every MFA-protected route would
have failed on staging; replaced by the owner-defined `app.user_has_verified_mfa(uuid)` (migration `20261022030003`),
proven by running the MFA suite as the restricted `resuto_api` login. The error-code registry gained the two MFA codes.

| Suite (`23f0a99`) | Result |
|---|---|
| API integration (101 files, owner connection) | **864 passed, 4 skipped / 868** |
| API MFA + error contract + roles + pagination + rate limits as restricted `resuto_api` | pass (23/23 for the merge fixes) |
| Database security / roles | **76 / 76** |
| Contracts | **59 / 59** |
| Integrations | **314 / 314** |
| MCP server | **25 / 25** |
| Web unit | **308 / 308** |
| Demo loader / UI scripts | **47 / 47** |
| API + web typecheck, web production build, bundle budget gate | pass |

Staging checks done against the real Supabase project before deploying (read-only or rolled back): PostgreSQL 17.11;
the non-superuser `postgres` role can create a NOLOGIN role, grant it to itself and `SET ROLE` to it (probe in a
rolled-back transaction, nothing left behind); pgcrypto lives in `extensions`, but the API computes every hash in
Node, not SQL; `postgres` can read `auth.mfa_factors` (0 factors enrolled).

Staging deployment:
- API/AI/MCP (Render) at `23f0a99`: migrations `20261022030001..3` applied; boot log
  `platform mode runs as resuto_platform, NOT enforced: DATABASE_PLATFORM_FALLBACK=log-and-retry` (staging soak, see
  `docs/STAGING_DEPLOYMENT.md`); no `platform role lacks a grant` / permission-denied lines since.
- The demo integrity check on that boot failed `no_stale_reservations` (a booking an earlier run made two days ahead
  had passed); fixed in `688bb4b` (every refresh retires past-due bookings), reproduced and verified locally first;
  staging boot log at `688bb4b`: "reservations: 1 earlier booking(s) whose time passed marked no-show", "all
  assertions hold".
- Web (Vercel CLI, production deployment of the staging project) at `23f0a99`: `dpl_GPhmxSXDAHunyhM6RPpZqDTkARG1`,
  aliased to https://resuto-2-staging-web.vercel.app; Deployment Protection on (`ssoProtection: all`, 0 bypasses);
  every URL answers 302 to Vercel login.
- `smoke.mjs` **40 / 40**, `mcp-check.mjs` **7 / 7** at `688bb4b` (API) / `23f0a99` (web, AI, MCP).

## Continuation wave 6 (visual parity with the original Resuto) — integrated (2026-10-22/23, `867e124` … `aaec04e`)

A legacy-vs-new gallery (160 captures: 20 screens x desktop/phone x EN/AR, both apps run locally from the same demo)
found the remaining visual gaps; ws12 closed them: floor room architecture (walls, window strip, service bar,
entrance), Smash & Co open status / today's hours / pickup ETA / district, menu Portions from ingredient stock,
`/orders` opens on the board, managers' KDS inside the staff shell, Arabic details (isolated order references, Arabic
wordmark, Arabic ingredient names, money never wraps), cart total + Confirm in view on phones with `.00` guest prices,
inventory opens on dish availability, settings on the service model. Independent review: 1 major + 7 minor findings,
fixed before merging. A test that compared a Cairo-local date with a UTC date (failing nightly 21:00–24:00 UTC) was
fixed in `145156d` and proven at 23:50 UTC.

| Suite (`145156d`) | Result |
|---|---|
| API integration (101 files) | **867 passed, 4 skipped / 871** (run at 00:00 UTC) |
| Database security / roles | **76 / 76** |
| Contracts | **59 / 59** |
| Integrations | **314 / 314** |
| MCP server | **25 / 25** |
| Web unit | **348 / 348** |
| Demo loader / UI scripts | **57 / 57** |
| API + web typecheck, web production build, bundle budget gate | pass |

Staging:
- All services at `145156d` (web `dpl_FBE425ZhnVig6QF26XETi1L6LUfq`); migration `20261022050001_branch_district`
  applied; `smoke.mjs` 40/40, `mcp-check.mjs` 7/7; no `platform role lacks a grant`, permission-denied or fatal lines
  in the API log 2026-10-22 00:09 → 2026-10-23 11:05.
- The boot-time demo refresh then failed twice (00:10 UTC 10-22, 11:04 UTC 10-23):
  `duplicate key ... orders_branch_id_business_date_number_key` while back-dating history orders onto a day whose
  numbers were taken. Fixed in `d137414` (a back-dated order takes the next free number on its new day; the old
  statement reproduced the exact key violation on a local copy, the new one moved the order as the next number). The
  next boot completed the history (17 orders for 10-21..22) and stopped at the live QR visit: T2 was held for a
  booking starting soon (`409 table_unavailable`, correct API behaviour). Fixed in `aaec04e` (T2 or the next free
  table).
- API at `aaec04e`: boot log "a QR visit on T1 …", "floor: legacy room architecture added …", "storefront: Smash & Co
  district, districtAr, timezone, openingHours …", "inventory: Arabic names for 10 ingredient(s)", **"all assertions
  hold."**; `smoke.mjs` **40 / 40**, `mcp-check.mjs` **7 / 7**. Web/AI/MCP stay at `145156d` (the later commits only
  change the demo loader, which runs in the API container).

## Continuation wave 7 (polish, remainders, counter session) — integrated (2026-10-23, `72fb1e7` … `435f602`)

ws13 closed the last gallery gaps (POL-01 landing floor architecture on phones and in the sample room, POL-02 guest
dock at 390 px, POL-03 reservation hold note in the first viewport). ws14a/b closed the internal follow-ups earlier
lanes had left open (webhook inbox lease/backoff/dead letters/replay, accounting health checks, real idempotent
status, admin counts from rollups, Arabic for API-generated text, MCP 403 scope challenge, shared per-phone limits,
guest IP forwarding, responsive dish photos, ETag revalidation from the browser, error codes in EN/AR, staff labels,
inline-style ratchet, E2E specs on the current UI). ws14c ported the legacy counter / venue QR session (FT-07). Each
stream had an independent review (ws14a 1 major + 3 minor, ws14b 4 minor, ws14c 1 major + 4 minor), all addressed.
Merge fixes on the line: EN/AR text for the three counter error codes; Floor Studio and the QR sheet load on their
tabs and the booking page imports only the toast hook (floor 220.6 → 210.9 kB, reserve 170.0 → 168.8 kB).

| Suite (merged head `7c9001b`/`e711f39`) | Result |
|---|---|
| API integration (110 files) | **914 passed, 4 skipped / 918** |
| Database security / roles | **82 / 82** |
| Contracts | **59 / 59** |
| Integrations | **320 / 320** |
| MCP server | **27 / 27** |
| Web unit | **442 / 442** |
| Demo loader / staging / UI scripts | **60 / 60** |
| OpenAPI drift check | **5 / 5** |
| API + web typecheck, web production build, bundle budget gate | pass (staff max 218.5/220 kB, public 221.4/226, guest within ratchets) |
| E2E Chromium (ws14b, own stack) | 56 passed, 4 failed: scenario-driver ×2 and scenario-whatsapp ×2 answer `branch_closed` at night (wall-clock opening hours; same on the base) |

Staging:
- `e711f39` on web (`dpl_6wAam4UoTkeQYL8KsoS1Tr1mP86a`, aliased to the staging URL, Deployment Protection still
  302 → Vercel SSO), API, AI and MCP; migrations `20261023020001..3` and `20261023040001..2` applied at boot;
  `smoke.mjs` **43 / 43** (commit identity pinned for all three Render services), `mcp-check.mjs` **7 / 7**.
- The boot-time demo refresh then failed `no_stale_open_visits`: a QR visit from 11:49 UTC was 5.5 h old when the
  17:21 boot created a fresh live set and was never retired afterwards. Fixed in `c0bbe20` (every refresh completes
  items older than the cutoff); reproduced and verified locally on a copy of the demo. API at `c0bbe20`:
  "refresh: completed stale live fixtures — 3 order(s), 1 visit(s)", **"all assertions hold."**
- The old instance logged `Cannot use a pool after calling end on the pool` while shutting down (the in-process
  worker was mid-tick when Nest ended the pool). Fixed in `435f602` (the signal drains the worker before closing);
  three local SIGTERM runs: no errors, 200-300 ms.
- Open: repeat-visit LCP on `/order/<slug>` regressed from ~0.3 s to ~1.35 s (a pre-existing Suspense reveal race
  that the responsive-photo change tipped; `/t/<qr>` already had it). Being fixed in ws15 (PERF-01).

## Continuation wave 8 (guest first paint) — integrated (2026-10-23, `424687d`)

ws15 fixed PERF-01: `/order/<slug>` and `/t/<qr>` no longer stream their content behind a `loading.tsx` boundary,
so the heading and menu are in the first HTML; a cold menu read past 1.2 s renders the heading and the branded
skeleton and the browser loads the menu (independent review: 1 major — a table not taking orders stayed on the
skeleton when the menu read was slow — fixed and browser-verified; 2 minor, fixed). Measured A/B, 5 runs per build:
repeat-visit LCP web-order 1,440 / 1,380 → 312 / 312 ms, guest QR 1,356 / 1,536 → 300 / 296 ms; first-visit LCP and
CLS not worse (details and raw JSON in `docs/PERFORMANCE.md`, `docs/perf-results/2026-10-23-perf01-*`).

| Suite (`424687d`) | Result |
|---|---|
| Web unit | **463 / 463** (21 first-paint guards; they fail when a loading boundary is restored) |
| Web typecheck, production build, bundle budget | pass (`/order/[slug]` 167.8/170 kB, `/t/[qr]` 177.6/178 kB ratchet) |
| Demo loader / staging / UI scripts | **60 / 60** |
| E2E Chromium `guest-first-paint.spec.ts` (ws15 stack) | **2 / 2** |
| API, DB, contracts, integrations, MCP | unchanged since wave 7 (914+4 skipped, 82, 59, 320, 27) |

Staging: web (`dpl_8j4jkXKJfwCkFs8K22nEbfdAQQAB`, aliased to the staging URL, Deployment Protection 302 → Vercel
SSO), API, AI and MCP all at `424687d`; `smoke.mjs` **43 / 43** with the commit pinned on API/AI/MCP,
`mcp-check.mjs` **7 / 7**; boot demo refresh **"all assertions hold."**; no pool, grant or permission errors in the
API log, including the previous instance's shutdown (`435f602`, graceful worker drain).

## CI repair and redeploy (2026-10-24, `f70bb16` … `5c359d5`)

GitHub-hosted CI run 58 (`1644745`) failed four jobs. Root causes and fixes:

| Failure | Root cause | Fix |
|---|---|---|
| Database security, 4 tests | Parallel test files migrate several databases on one cluster; roles are cluster-wide, so two `create role` statements raced (`pg_authid_rolname_index`) | `scripts/db/migrate.mjs` retries a migration step that lost that race |
| Dependency audit, 2 high | zod 4.1.13 (GHSA-mrhx-c7xc-m3w5, memory exhaustion on oversized constrained collections; fixed in 4.6.6), body-parser DoS | zod 4.6.7, lockfile refresh (body-parser 2.4.0, fast-uri 3.1.9), multer override 2.5.0. `pnpm audit --prod`: no known vulnerabilities |
| Browser E2E, 429 | All fixture tenants came from one client IP and hit the 30/IP/hour org-create limit | Each fixture tenant uses its own documentation-range client IP (X-Forwarded-For is trusted from loopback outside production/staging only); fixture branches are open 24 h so ordering specs do not depend on the clock |
| Visual parity, `resuto_e2e` missing | The CI service container is reached as `postgres`, not localhost, so the e2e starter refused to create/reset the database | Opt-in `RESUTO_DISPOSABLE_DB=1` on that job only; a remote/Supabase URL is still refused |

Follow-ups found by the CI runs themselves:
- zod 4.6 emits `$defs`/`$ref` for recursive schemas: hoisted into `components.schemas`; the OpenAPI lint now fails
  on any `$ref` that does not resolve (`docs/api/openapi.json` regenerated).
- The larger zod pushed 18 routes over the bundle budget. Guest, public and shell code now import helpers from the
  zod-free `@resuto/contracts/lite` (a test checks it reaches no zod); guest pages ship no zod at all, `/t/[qr]`
  186.9 → 140.6 kB (its ratchet is removed). No budget was raised.
- WebKit (iPhone 13) scenarios: the driver PWA sent `recordedAt` from WebKit's emulated position timestamp (year
  58783; rejected with 400). `fixTime()` keeps a fix time only inside the window the API stores. Two test races:
  guest B left the QR page before its session join returned; `signIn` wrote the session on `/login`, whose
  redirect interrupted the next navigation. WebKit's "Load request cancelled" is treated like Chromium's
  `ERR_ABORTED` (navigation-cancelled polls only).
- Visual job: Playwright 1.56's `--update-snapshots=missing` writes a missing baseline **and fails the test**, so
  the job could not pass while no docker baseline is committed (CR-11, owner approval). In that job only
  (`E2E_RECORD_MISSING_BASELINES=1`) a missing baseline is recorded and uploaded for approval; committed baselines
  are always compared, and without the flag a missing one still fails.
- Actions: checkout/setup-node/setup-python/upload-artifact v6, pnpm/action-setup v5.

**GitHub CI run 61 (`5c359d5`): all four jobs pass** — https://github.com/MoAlazool/ResutoGDG/actions/runs/40101012201
(Database, API and web: AI pytest, contracts, integrations, DB security, legacy migration tool, demo integrity, script
tests, API typecheck, OpenAPI drift/lint, API integration as owner and as `resuto_api`, MCP, web unit, web build,
bundle budget, audit; Browser E2E Chromium + WebKit iPhone 13; Visual parity in the Playwright image; Legacy).

| Local suite (`5c359d5`) | Result |
|---|---|
| API integration | **914 passed, 4 skipped** |
| Database security | **82 / 82** (fresh cluster with no roles) |
| Contracts | **63 / 63** |
| Integrations | **320 / 320** |
| MCP server | **27 / 27** |
| Web unit | **465 / 465** |
| Demo / staging / UI scripts | **12 / 12** staging+UI, **48 / 48** demo |
| Bundle budget | pass: guest max 164.3 / 170, public 205.7 / 226, staff 216.6 / 220 |

Staging redeployed (application code changed since `424687d`): web `dpl_3zK3oCMFqb6eJAFY5jNjkgR7ECNG` (aliased to
https://resuto-2-staging-web.vercel.app, Vercel SSO 302), API `dep-dbebvru7bikc73fulm2g`, AI
`dep-dbebvs0473hc73cqmji0`, MCP `dep-dbebvscs728c73boef5g`, all at `5c359d5`. `smoke.mjs` **43 / 43** with the commit
pinned on API/AI/MCP, `mcp-check.mjs` **7 / 7**, boot demo refresh **"all assertions hold."**, no error lines in the
new API instance's log.
