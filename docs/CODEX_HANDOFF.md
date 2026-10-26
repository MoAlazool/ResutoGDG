# Resuto 2.1 unified branch — handoff for independent end-to-end testing (Codex)

Branch: `integration/resuto-2.1-ipad-qa` — https://github.com/MoAlazool/ResutoGDG/tree/integration/resuto-2.1-ipad-qa
Head at handoff: the commit that adds this file (verify with `git rev-parse HEAD`; the exact SHA is also in the owner's
handoff message). It contains Claude's branch at `304d8dc` and Codex's branch at its PR #3 head as of 2026-10-26.

This branch = `claude/relaxed-mayer-omkl3f` (Resuto 2.1: backend, Supabase migrations, Next.js dashboard, MCP, AI
service, POS API 0.2.0) **plus** a history-preserving merge of `codex/ipad-pos-native-client` (Draft PR #3, native
SwiftUI app in `apps/ipad-pos/`). The merge added only `apps/ipad-pos/**` and `.github/workflows/ipad-pos.yml`; no
shared backend/web/contract file came from the iPad branch. One integration commit regenerates
`apps/ipad-pos/Sources/ResutoCore/Permissions.swift` for the 2.1 roles (`changes:*`, `devices:manage`) and adds
`integration/**` to both workflows' push triggers. PR #3 stays Draft and unmerged; `main`, `legacy/`, production and
`feature/ipad-pos` are untouched. Nothing here is a release.

**What Claude verified vs. what is yours to verify.** Claude ran builds, unit/integration suites, browser E2E on a local
stack, the native workflow on GitHub's macOS runner (synthetic transport) and staging smoke/MCP checks. None of the
following has been verified end to end by anyone yet: native app ↔ real staging backend, device pairing on staging,
iPad orders appearing in the web dashboard/KDS, cross-client status sync, payments/inventory/analytics consistency from
iPad orders, offline recovery against staging, physical devices or printers. Do not treat CI results as those passes.

## 1. Repository structure

| Path | What |
|---|---|
| `apps/api` | NestJS API (`/v1`), worker (in-process on staging), POS device API under `/v1/pos/*` |
| `apps/web` | Next.js 15 dashboard, guest pages (`/r`, `/m`, `/t`, `/order`, `/reserve`, `/pay`), admin console |
| `apps/mcp-server` | MCP server (Streamable HTTP) proxying to the API |
| `apps/ai-service` | Python forecasting/insights service |
| `apps/ipad-pos` | Native SwiftUI iPad POS (iPadOS 17+, Xcode 16+), `Package.swift` core + generated `ResutoPOS.xcodeproj` |
| `packages/contracts` | Shared TypeScript contracts (`src/pos.ts`: `POS_CONTRACT_VERSION = '0.2.0'`) |
| `packages/ui`, `packages/integrations` | Design system; provider adapters |
| `supabase/migrations`, `supabase/tests` | Schema + RLS; DB security tests |
| `docs/api/openapi.json`, `docs/api/IPAD_INTEGRATION.md`, `docs/api/IPAD_COMPATIBILITY.md`, `docs/api/CHANGELOG.md` | API contract and the iPad integration contract |
| `apps/ipad-pos/{README.md,STATUS.md,API_DEPENDENCIES.md,docs/}` | Native app docs (status, staging probe, verification matrix) |

## 2. Versions

API / web / MCP / contracts packages `0.1.0`; POS device API contract **0.2.0** (`packages/contracts/src/pos.ts`,
`docs/api/IPAD_INTEGRATION.md`). Node ≥ 22.12, pnpm 10.28.0, Postgres 16 locally (staging Supabase PostgreSQL 17).
Native: Xcode 16+ (CI used the `macos-15` runner image), iPadOS 17+ simulator.

## 3. Authentication and device pairing

- **Staff (web and native today):** Supabase Auth password grant → bearer access token → `/v1/me` (memberships: restaurant,
  role, allowed branches) → `/v1/o/{orgId}`. The API re-checks membership, permissions, entitlements and branch scope on
  every call; RLS enforces tenant isolation in the database. The native app currently uses the **staff routes**
  (`/v1/o/{orgId}/orders`, `…/kitchen/{branchId}`, payments, floor…); see `apps/ipad-pos/API_DEPENDENCIES.md`.
- **POS device API 0.2.0 (implemented, deployed to staging, native adapter present but write cutover NOT activated):**
  an owner/manager creates a one-time pairing code for one branch and an acting role → the device exchanges it for an
  `rpos_…` device credential → staff sign in on the device and send `X-Resuto-Staff-Authorization: Bearer <staff
  token>`; effective permissions = staff role ∩ device acting role; `401 pos_staff_required` without the header on a
  staff-only device, `403 pos_staff_not_allowed` for staff outside the branch, `401 device_revoked` after revocation.
  Sync: menu/floor/orders deltas with cursors; idempotent `POST /v1/pos/orders` keyed by `clientOrderId`
  (`Idempotent-Replayed: true` on replay, `409 client_order_id_reused` for a different body), `GET
  /v1/pos/orders/by-client-id/{clientOrderId}`, `409 pos_price_changed` with per-line details, `409 stale_order`,
  ordered event feed with `seq`/epoch (`409 resync_required`). Exact schemas: `docs/api/IPAD_INTEGRATION.md` §4–§5.
- **Do not activate native POS write cutover** until the staging acceptance in `docs/api/IPAD_INTEGRATION.md` §8 and
  `apps/ipad-pos/docs/POS_API_MIGRATION.md` passes.

## 4. Environments

| Service | URL |
|---|---|
| API | `https://resuto-2-staging-api.onrender.com/v1` (`/v1/health` reports `build.commit`) |
| AI | `https://resuto-2-staging-ai.onrender.com` |
| MCP | `https://resuto-2-staging-mcp.onrender.com` (`/health`) |
| Web (private, Vercel Authentication) | `https://resuto-2-staging-web.vercel.app` — needs an authorized Vercel login; no automation bypass exists (do not create one without the owner) |
| Supabase | project `resuto-staging`, origin `https://skvnznyfxpxfuzvuipju.supabase.co`, public publishable key from the project settings (never a service-role key in the app) |

Staging is the isolated demo environment; payments run in sandbox mode. Never use production.

**Staging deployment status:** API, AI and MCP on Render and the web app on Vercel run Claude commit `304d8dc` (2026-10-26 22:32 UTC; this
branch adds only `apps/ipad-pos/**`, the native workflow and this document on top, none of which is deployed).
`/v1/health` reports `build.commit = 304d8dc…`. Boot log: `[migrate] database is up to date` and the demo data
integrity check `all assertions hold.` `scripts/staging/smoke.mjs` **43 / 43** (commit pinned on API/AI/MCP) and
`scripts/staging/mcp-check.mjs` **7 / 7** passed against it. The POS device API 0.2.0 is deployed but has **not** been
exercised on staging with real accounts (`pos-check.mjs` needs dedicated accounts, see §6).

## 5. Mac / Xcode setup

```sh
git clone https://github.com/MoAlazool/ResutoGDG.git && cd ResutoGDG
git checkout integration/resuto-2.1-ipad-qa
# Web/API toolchain (only needed to run the stack locally)
corepack enable && pnpm install --frozen-lockfile
pnpm --filter @resuto/contracts build && pnpm --filter @resuto/integrations build && pnpm --filter @resuto/ui build
# Native app
python3 apps/ipad-pos/scripts/generate_permissions.py
python3 apps/ipad-pos/scripts/generate_project.py
python3 apps/ipad-pos/scripts/check_contracts.py
python3 apps/ipad-pos/scripts/check_pos_contracts.py
python3 apps/ipad-pos/scripts/check_ui_transport.py
swift test --package-path apps/ipad-pos
open apps/ipad-pos/ResutoPOS.xcodeproj   # Xcode 16+, pick an iPad simulator (iPadOS 17+)
xcodebuild -project apps/ipad-pos/ResutoPOS.xcodeproj -scheme ResutoPOS \
  -destination 'platform=iOS Simulator,id=<installed-iPad-UDID>' \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual AppIdentifierPrefix=RESUTOTEST. test
```

In the app: **Configure connection** → API `https://resuto-2-staging-api.onrender.com/v1`, the Supabase origin above and
its public publishable key → sign in with a staging staff account → choose restaurant and branch. Real-device runs need
the owner's Apple team for signing. Staging probe without credentials: `swift run --package-path apps/ipad-pos
ResutoStagingProbe --public-only`; authenticated read-only/write probes: `apps/ipad-pos/docs/STAGING.md`.

Run the web/API stack locally (optional): see `docs/STAGING_DEPLOYMENT.md` and `tests/e2e` (Playwright starts API,
worker and a built web app against a local Postgres; `pnpm e2e`).

## 6. Test credentials and QA roles

Credentials are **never** in this repository, docs, PR comments or logs. Obtain them from the owner through the approved
secret store. Needed for a complete run:

- An owner/manager account on a dedicated staging QA restaurant (the iPad docs ask for `Resuto Native QA` with ≥ 2
  branches; it does not exist yet) — or the owner's explicit decision to use the existing demo restaurant
  (`the-olive-room`, sandbox data; its owner account exists and is held by the owner).
- Staff accounts with roles cashier, waiter, kitchen, host, with realistic branch restrictions.
- A second-tenant account for negative isolation tests.
- An authorized Vercel login for the staging web dashboard/KDS.
- Optional: the staging Supabase service-role key **for the flow-check scripts only** (never in the app).

## 7. Existing results (what has actually run)

| Check | Commit | Result |
|---|---|---|
| GitHub CI (Database, API and web; Browser E2E Chromium + WebKit; Visual parity; Legacy) | `c21b66b` (this branch, before the 304d8dc refresh) | green — run 40395407741 |
| Native iPad POS workflow (`macos-15`): generated sources + API contract checks, portable core tests, Release build, Xcode UI tests | `c21b66b` | green — run 40395407789; **21 / 21 UI tests** (synthetic transport, real Keychain/AES) |
| GitHub CI on Claude's branch | `304d8dc` | see the owner's handoff message for the final run |
| Local: contracts 108/108; web unit 974/974; API integration 1149 passed, 4 skipped; web build + bundle budget pass | `304d8dc` | Linux container, local Postgres 16 |
| Local: `check_contracts.py` (23 routes) and `check_pos_contracts.py` (9 adapter operations vs API 0.2.0) | this branch | PASS (Python; `check_ui_transport.py` needs `swiftc`, runs on macOS CI) |
| Staging smoke 43/43, MCP 7/7, migrations up to date, demo integrity holds | `304d8dc` | see §4 |

Not run by anyone yet: the native app against staging with a real account; device pairing on staging; iPad orders on
the web dashboard/KDS; cross-client status sync; payments/inventory/analytics reconciliation from iPad orders; offline
recovery against staging; physical iPads and printers. `pos-check.mjs` (37/37 locally against a local stack) has not
run on staging.

## 8. Known issues and limitations

- **Write cutover is not active.** The native app writes through the staff routes; the POS 0.2.0 adapter is read-only
  shadow + pairing. Do not switch it on (gates: `docs/api/IPAD_INTEGRATION.md` §8, `apps/ipad-pos/docs/POS_API_MIGRATION.md`).
- **POS contract limitations (0.2.0):** no line amendments on an existing order, no table move/merge, no staff bill
  split, no external card terminal or offline card authorisation, no fiscal receipts, no cash-drawer/vendor printer
  SDK. Kitchen sync is polling (`/v1/pos/events` long-poll `wait`), not push.
- **Staging web is private** (Vercel Authentication). Without an authorised Vercel login the dashboard/KDS half of the
  joint test cannot run; no automation bypass exists and none is created without the owner.
- **Accounts:** the `Resuto Native QA` restaurant and the per-role staff accounts do not exist yet (§6).
- **Pairing page:** dashboard › Settings › **iPad devices** (`/dashboard/<orgId>/settings/devices`, also ⌘K "Pair a new
  iPad"). It creates one-time codes with a countdown, lists devices and revokes with a reason; it never shows the device
  credential. Verified locally (E2E `tests/e2e/devices.spec.ts`), not yet on staging.
- **Web visual baselines** re-recorded during the 2.1 refinement are pending the owner's visual review.
- **Intermittent local test:** `apps/api/test/perf-plans.test.ts › Orders page` failed once locally (planner choice on
  a shared test DB); not reproduced since; failure message now prints the plan. Not a native issue.
- Native `STATUS.md` lists the app-side gaps (VoiceOver audit, real-device Keychain, printer certification, signing/
  TestFlight).

## 9. Suggested end-to-end test sequence (native + dashboard together)

1. Staging health: `/v1/health` commit matches the branch head (or the deployed commit stated above).
2. Native sign-in (staff routes) → restaurant/branch selection; confirm role restrictions per role account.
3. Menu: categories, items, modifiers (required/optional limits), real images; availability toggle reflected on web.
4. Cart → order creation (pickup and dine-in table) → confirm the same order number/totals on web Orders and Overview.
5. KDS (web `/kitchen/<orgId>` with an authorized Vercel session) receives the ticket; advance statuses from KDS and
   from the iPad; both clients converge (iPad polls ~5 s; web Orders board).
6. Cash collection (sandbox ledger) incl. partial amounts; refund request path; check payments list, finance overview,
   analytics deltas and inventory depletion for the order's lines.
7. Offline: create drafts offline, relaunch, reconnect, review refreshed prices, submit; replay the same client id;
   kill the app mid-submit and confirm no duplicate order (staff routes: `Idempotency-Key`).
8. POS 0.2.0 device API (only as a shadow/adapter test; do not cut writes over): pairing code from the dashboard
   (Settings › iPad devices), device credential, staff header, permission intersection, event feed resume, revocation.
   `scripts/staging/pos-check.mjs` automates the API side (needs dedicated accounts; see `docs/STAGING_DEPLOYMENT.md`).
9. Arabic/English UI on iPad and web (RTL, Western digits), accessibility sizes, rotation.
10. Performance/reliability: large menu, long sessions, network loss, server errors.

Record evidence per step (IDs, timestamps, screenshots) and mark anything not executed as not executed.
