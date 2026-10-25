# POS 0.2.0 staging readiness — read-only review

Refreshed 25 October 2026 at 16:02 UTC. **Not deployed or authenticated end-to-end verified.** No shared source, database, infrastructure, production or Claude branch changes were made. This is the native track's handoff for Claude and the staging owner.

Evidence: `evidence/staging-readiness-ux-review.json`. Earlier review at `806a4c2` found nine pending migrations; the refreshed branch adds preferences and onboarding. Counts below are scoped metadata observations, not credential discovery or authenticated acceptance.

## Observed staging state

- Claude branch reviewed at `48f5eeba38649cee4ea447b4a0982a803f71434d`; targeted POS integration/compatibility documentation and implementation remain compatible with the pinned `69ec75e` native draft adapter.
- Supabase staging project `skvnznyfxpxfuzvuipju`: last applied migration `20261023040002_counter_legacy_revoke`; all six POS tables are absent and a name-filtered native/iPad QA organization count is zero (a differently named approved QA tenant would require owner identification). Existing restricted runtime roles are present.
- Render API service `srv-dbaa8hqjnfac73ev3kjg`: live deployment `dep-dbebvru7bikc73fulm2g`, build `5c359d5`. Public health returns staging/sandbox. Cold starts can time out; a later healthy response does not verify authenticated operations.
- No approved owner/staff credentials are available in this execution environment. There is no callable connector for approved Supabase Auth user creation. Connected infrastructure access is not staff authorization.

## Rollout scope to review before deployment

Claude's current `start-api` path applies **all eleven** pending migrations, not just the two POS changes:

1. `20261024210001_pos_devices_feed`
2. `20261025100000_change_sets`
3. `20261025120001_module_enabled_free_fallback`
4. `20261025120002_organization_social_links`
5. `20261025200000_mcp_groups_sessions`
6. `20261025210001_pos_require_staff`
7. `20261025300001_inbox_workspace`
8. `20261025400001_user_preferences`
9. `20261025410001_platform_provider_apps`
10. `20261025410002_channel_routing`
11. `20261026100001_onboarding_wizard`

Pin the approved backend revision, review backup/rollback and run disposable-database migration/RLS/POS staff-flow checks before the staging owner deploys through the existing schema-owner `MIGRATION_DATABASE_URL` entrypoint. Do not reset the database, elevate the API role, bypass Auth or deploy the branch tip under the assumption that only POS schema changes will run. Production remains outside this rollout.

Old device rows default to `require_staff=false`; the native paired workflow requires **true** at pairing and session validation. Do not authorize device-only operation to make tests pass.

## Dedicated QA setup

An authorized staging owner must supply normal staging Supabase Auth identities via the approved signup/admin workflow, respecting email confirmation and MFA. Never insert password hashes into `auth.users`, use production accounts, or enable development authentication.

1. Create the synthetic native QA restaurant through owner-authorized `POST /v1/orgs` with the required name, slug, country and branch input.
2. Confirm an approved staging plan/trial permits two branches; create branch B through `POST /o/{orgId}/branches`.
3. Invite dedicated manager, cashier, kitchen and host staff using `POST /o/{orgId}/invitations` with explicit `email`, `role`, `branchIds`. Staff accept through `POST /v1/invitations/accept` with their invitation token. Respect privileged-role step-up/MFA requirements.
4. Add one branch-restricted account and a separate synthetic tenant for negative tests. Seed synthetic menu/modifiers, tables and stock using normal platform APIs/UI.
5. Deliver credentials through an approved secure channel; keep passwords, bearer tokens, pairing codes and invitation links out of chat, commits, screenshots and test artifacts. Authorize the separate protected web staging session normally.

See `STAGING.md` for the native guarded lifecycle probe. It has **not** been run authenticated. Run first with limited read permissions, then explicitly authorized synthetic writes only after restaurant/branch allowlists match.

## Contract coordination and acceptance

Preserve the separate staff bearer and device bearer, `X-Resuto-Staff-Authorization`, tenant/branch/staff-role identity checks and permission intersection. Use the existing event epoch/sequence and permanent `clientOrderId` lookup; do not substitute invented endpoints.

Before switching native writes from staff routes: verify quote/price consent, ambiguous order reconciliation, revocation/permission narrowing, gap/reset snapshot recovery and the documented service-day read-only shadow gate. POS submit support for promotions, customer IDs and delivery remains an additive backend dependency. Order amendments/table moves/merge and authorized item/customer splits remain unsupported. A payment record is not terminal authorization. Shared print claims do not prove physical paper output. Truncated open-order snapshots must remain visible as incomplete.

Record **one actual order ID** across native → API → Web Orders → KDS → status synchronization → verified payment ledger, stock and analytics, including authorization negatives and lost-ack retry tests. Until that evidence exists, integration is pending even when synthetic tests and CI pass.
