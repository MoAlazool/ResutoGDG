# Authorized staging verification

## Read-only access checked on 2026-10-24

- GitHub: repository/PR/Actions access works. PR #3 stays Draft, base `feature/ipad-pos`.
- Supabase: `resuto-staging` (`skvnznyfxpxfuzvuipju`), ACTIVE_HEALTHY, PostgreSQL 17.11. Project origin and enabled public publishable key were verified through the connector. No secret/service-role key is used by native code. Read-only schema/migration inspection confirms the existing organizations, memberships, branches, orders, payments and idempotency tables; native device enrollment is absent.
- Render: staging API service `srv-dbaa8hqjnfac73ev3kjg`, `https://resuto-2-staging-api.onrender.com/v1`. Public health reports staging/sandbox. No service, environment, deployment or production setting was changed.
- Vercel: `resuto-2-staging-web` uses deployment protection (SSO). Read-only environment metadata (`decrypt=false`) contains public client/API configuration, with no approved test staff credential source. Protection was not bypassed or changed.
- Cloud credential readiness: no injected runtime secrets or outbound identity. Repository demo scripts require externally supplied passwords; they are not a credential source. The demo loader was not run because it resets shared accounts/data.
- Dedicated QA identity search: no `Resuto Native QA` restaurant was found. The shared `the-olive-room` demo has staff memberships but no approved native QA password/session. No user password was read, reset or created, and no production account/data was used.

These checks establish access to staging metadata and unauthenticated endpoints. They do not verify an authenticated order, browser screen, payment or inventory effect.

## Exact owner setup required

Through the existing platform's approved staging administration process, provide:

1. A **staging-only** restaurant named exactly `Resuto Native QA`, its organization UUID and at least two active branches. Keep it isolated from shared demo operations and production. The probe now resolves branch timezone with restaurant fallback; avoid the midnight boundary and concurrent QA writes during that probe.
2. Normal Supabase staging staff identities with owner/manager, cashier, kitchen and host roles, realistic branch restrictions, and a second-tenant account for negative authorization tests. Existing API guards and RLS remain enabled. The automated write probe needs one manager with `orders:write`, `orders:read`, `kitchen:operate`, `payments:collect`, `analytics:read`, menu and floor access for the selected branch.
3. A staging-approved native password sign-in account compatible with the deployed Auth policy. If MFA/SSO is mandatory, agree its supported native flow before verification; do not disable that policy to make a test pass. Share credentials using the approved secret store or masked CI secret mechanism, never chat, source, command arguments or committed `.env` files.
4. One explicitly identified available test product (UUID), required modifier options, pricing/tax rules, and optionally a known recipe/stock fixture. Enable appropriate sandbox entitlements. The probe records a real **sandbox cash ledger** transaction; it does not move physical cash or invoke a card provider. Preserve records for audit/reconciliation rather than deleting them to rerun.
5. An authorized Vercel SSO/browser session for staging web and KDS. This is separate from Supabase staff authentication. Verify matching order ID/number/totals in actual web UI and native UI, plus inventory and financial analytics. The API-only probe cannot certify browser rendering or web subscriptions.

No schema, shared backend or infrastructure change is necessary or authorized as part of this setup document. Claude owns missing API contracts in `../API_DEPENDENCIES.md`.

## Native client probe

`swift run --package-path apps/ipad-pos ResutoStagingProbe --public-only` runs real URLSession health and unauthenticated `/me` checks without credentials.

For an authorized **read-only authenticated** run, inject these environment variables securely, then run `swift run --package-path apps/ipad-pos ResutoStagingProbe`:

| Variable | Required value / purpose |
|---|---|
| `RESUTO_API_URL` | Optional; only `https://resuto-2-staging-api.onrender.com/v1` is accepted |
| `RESUTO_SUPABASE_URL` | `https://skvnznyfxpxfuzvuipju.supabase.co` |
| `RESUTO_PUBLISHABLE_KEY` | Verified project's public client key; never service-role |
| `RESUTO_STAFF_EMAIL`, `RESUTO_STAFF_PASSWORD` | Dedicated approved staff identity, injected as secrets |
| `RESUTO_TEST_ORG_ID`, `RESUTO_TEST_BRANCH_ID` | Dedicated QA context, verified against `/me` and `/o/{orgId}` |
| `RESUTO_EVIDENCE_PATH` | New local output path, outside the repository; never reuse an existing file |

Mutations are disabled unless `RESUTO_STAGING_WRITE=1` is explicitly set and `RESUTO_TEST_PRODUCT_ID` selects the dedicated test product. Write runs require `RESUTO_EVIDENCE_PATH`. Run only after owner setup and sandbox-data approval. Missing credentials exit 78 with variable **names**, never values. Tokens are transient, not written or printed. The transport refuses redirects and retains normal certificate validation.

The write path checkpoints operation and payment keys before their network calls; replays each key once; checks same order in Orders/KDS read models, kitchen transitions, authoritative paid state and analytics order/net/paid deltas. It never automatically repeats an entire run or replaces an ambiguous operation. If interrupted, preserve the evidence file and reconcile those IDs in the platform before choosing any next action. A rerun refuses to overwrite an existing evidence file. The probe's write path remains **unexecuted** until credentials/setup are supplied.

Outputs explicitly separate API read-model checks from browser/physical-device checks. Do not label synthetic SwiftUI fixtures or public-only probes as authenticated staging success. Use `VERIFICATION.md` for multi-client, failure, tenant, hardware and release acceptance beyond this narrow happy-path probe.

For the later 0.2.0 shadow phase, an authorized manager must create a one-use code for the exact QA branch and waiter/cashier/kitchen acting role with **`requireStaff: true`**. No device-only fallback is accepted by the native adapter. At the latest read-only check the staging POS tables were still absent and health still reported build `5c359d5`; deploy/merge belongs to Claude and the platform owner. Native pairing UI activation awaits that gate.
