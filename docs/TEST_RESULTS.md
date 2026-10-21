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
