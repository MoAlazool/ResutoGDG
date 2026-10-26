# Resuto 2.1 threat model and security assessment (phase 1D)

Branch `ws/21-sec` from `ebc0b00`, assessed 2026-10-25. STRIDE per surface for what Resuto 2.1 added or changed
(plan §1 "Security", §6.6, §6.8, §8 1D, §9). It complements, and does not repeat, `docs/SECURITY_AUTH.md`
(sign-in, sessions, MFA), `docs/architecture/SECURITY_MODEL.md` (tenancy, roles, RLS), `docs/security/FUNNEL_BEACONS.md`,
`docs/CACHE_POLICY.md` and `docs/api/IPAD_COMPATIBILITY.md`.

**Limits of this assessment.** It is a code review plus targeted probes run against a local, freshly migrated database.
No staging or production system was touched, no external penetration test was done, and no provider (Meta, payment
providers, Foodics, MCP clients other than the SDK) was called. Passing tests are evidence that one stated threat is
handled on the tested path; they are not proof that the system is secure. Where this document says "Mitigated" it
means "a control exists in the cited code"; whether it is also tested is stated separately.

## Status legend

| Status | Meaning |
|---|---|
| Mitigated (tested) | A control exists and an automated test exercises the threat (cited `file:line`). |
| Mitigated (untested) | A control exists in code; no test drives the threat. |
| Gap fixed in this branch | A confirmed issue, fixed with a regression test on `ws/21-sec` (commit cited). |
| Accepted risk — needs owner sign-off | Known residual risk or product decision; behaviour unchanged here. Listed in §12. |
| Open (owner prerequisite) | Needs an owner action or input before it can be closed. Listed in §13. |

Paths are repository-relative; `t:` means `apps/api/test/`, `db:` means `supabase/tests/`.

## 1. Findings of this assessment

Confirmed means reproduced by a failing test before the fix. Severity is for this product (multi-tenant restaurant
SaaS); the three confirmed authorization issues are **inside one restaurant** (branch scope or role), none crosses tenants.

| # | Severity | Surface | Finding | Confirmed? | Status | Commit | Test |
|---|---|---|---|---|---|---|---|
| F-1 | Medium | MCP approvals | `GET /o/:orgId/mcp/approvals`, `GET …/:approvalId` (with its live preview of the data) and `POST …/reject` ignored the approver's branch scope: a manager limited to one branch listed and opened requests changing another branch and could reject them (approve was already refused). | Yes | Gap fixed in this branch | `59334cf` | `t:security-2-1.test.ts:60`, `:73` |
| F-2 | Low | Change sets, MCP approvals | Reject did not check the permission each op (or tool) needs: a role with `changes:approve` but without, e.g., `menu:write` (marketing) could veto a price change it may not approve. | Yes | Gap fixed in this branch | `59334cf` | `t:security-2-1.test.ts:102` |
| F-3 | Low | MCP management | `POST /o/:orgId/mcp/clients/:id/test/:tool` runs a read tool with the connection's scope; a branch-limited member with `mcp:manage` could read every branch through an all-branch connection. | Yes | Gap fixed in this branch | `3a45570` | `t:security-2-1.test.ts:89` |
| F-4 | Low | RLS coverage | `mcp_sessions` (2.1) had no database-level negative test; no schema-wide check that every public table has RLS on. (RLS itself was correct.) | n/a (test gap) | Gap fixed in this branch | `b6a3d48` | `db:security-2-1.test.mjs:51`, `:57`, `:71` |
| F-5 | Low | MCP management reads | `GET …/mcp/clients`, `…/calls`, `…/clients/:id/usage` are not filtered by the caller's branches (only owners/admins hold `mcp:manage`). | Suspected (code reading) | Accepted risk — needs owner sign-off | — | — |
| F-6 | Low | Approvals inbox | A role with `changes:read` sees every op of a visible change set, including ops it holds no read permission for (marketing sees order-status ops and payment-link amounts). | Yes (code reading) | Accepted risk — needs owner sign-off | — | — |
| F-7 | Low | WhatsApp stepper | `POST …/connect/channels/:id/test-template` sends any approved template (`templateName`) to any phone number, 10 per hour per restaurant, outside the campaign consent rules. Needs `connect:manage`. | Yes (code reading) | Accepted risk — needs owner sign-off | — | — |
| F-8 | Low | Integrations OAuth (web) | `redirectAfter` (contract regex `^\/(?!\/)[^\s]*$`, `packages/contracts/src/integrations.ts:69`) admits `/\host`; the callback page (`apps/web/app/dashboard/oauth/[provider]/page.tsx:38`) would turn it into `//host`. Only the signed-in person can set it for themselves (the start call needs their bearer token, no cookie), so it is not reachable by a third party. | Suspected (code reading) | Accepted risk — needs owner sign-off (fix suggested) | — | — |
| F-9 | Info | POS pairing | Creating a pairing code (a device credential acting as waiter/cashier/kitchen) has no MFA step-up, unlike MCP keys and integration credentials. | Yes (code reading) | Accepted risk — needs owner sign-off | — | — |

Not found (probed, no issue): cross-tenant access through every 2.1 endpoint listed in §4 (`t:security-2-1.test.ts:152`–`:239`),
SSRF (no new server-side URL fetch in 2.1 API code; integration calls go to fixed provider hosts), `</script>` in
JSON-LD (escaped and tested), XSS through social links or section content (validated, React-escaped), secrets in
browser views (`t:security-2-1.test.ts:248`, `t:provider-apps.test.ts:79`, `:119`).

## 2. MCP actions and approvals (§6.6)

| STRIDE | Threat | Mitigation and evidence | Residual risk | Status |
|---|---|---|---|---|
| S | A stolen or guessed key acts as the restaurant | Keys `rmcp_` hashed (sha256) and looked up active, unexpired, restaurant open (`apps/api/src/common/auth/access.guard.ts:156`); OAuth access tokens audience-bound to `MCP_OAUTH_RESOURCES` and the served resource (`access.guard.ts:200`–`209`); PKCE, single-use codes, refresh rotation with family revocation (`t:mcp-oauth.test.ts:153`, `:189`) | A leaked key works until revoked or expired; OAuth is verified with the MCP SDK client only (no live Claude.ai / ChatGPT test recorded) | Mitigated (tested); live client verification Open (owner prerequisite, O-6) |
| S | Key in a URL (`/mcp/<key>`) leaks through logs | Only with `MCP_ALLOW_URL_KEY=true` (`apps/mcp-server/src/http.ts:277`); staging sets `false` (`docs/STAGING_DEPLOYMENT.md`) | An operator could enable it | Accepted risk — needs owner sign-off (keep off) |
| E | A key reaches REST routes beyond the tool path | Keys only reach `@McpRuntime` routes (`access.guard.ts:80`); route enumeration test (`t:mcp-route-lockdown.test.ts:77`, `:91`) | — | Mitigated (tested) |
| E | A connection does more than its acting role / tools / branches | Allow-list, role and branch confinement (`t:mcp.test.ts:181`, `:324`, `:522`); `propose_changes` limited to the connection's tools (`t:mcp-change-tools.test.ts:190`); OAuth scopes bound per token (`t:mcp-oauth.test.ts:214`) | — | Mitigated (tested) |
| E | A sensitive action runs without a person approving it | Sensitive and change-set tools go through change sets with a policy floor (`apps/api/src/modules/mcp/mcp-execution.service.ts:300`–`305`); approval bound to scope snapshot and preview digest, executed once (`t:mcp.test.ts:435`) | — | Mitigated (tested) |
| E | Approving with a password-only session | `@RequireMfa()` on MCP approve/reject (`apps/api/src/modules/mcp/mcp.controller.ts:116`–`126`) and change-set decisions and policy edits (`apps/api/src/modules/changes/changes.controller.ts:54`, `:63`, `:82`, `:102`), checked in `t:mfa-step-up.test.ts:71` (list at `:90`–`:95`) | **Opt-in**: only users who enrolled a factor are stepped up; an owner without a factor approves on aal1 (plan wanted "approve requires MFA") | Accepted risk — needs owner sign-off (A-1) |
| E | A branch-limited approver sees or decides another branch's request | Requests are filtered like the change-set inbox (`apps/api/src/modules/mcp/mcp-execution.service.ts:44`, `:694`) | — | Gap fixed in this branch (F-1) |
| E | A role rejects a request it could not approve | Reject needs the tool permission (`mcp-execution.service.ts:563`) | — | Gap fixed in this branch (F-2) |
| I | Dashboard test call reads beyond the caller's branches | Refused unless the connection's branches are inside the caller's (`mcp.controller.ts:78`) | — | Gap fixed in this branch (F-3) |
| I | PII leaves through tool output | PII masked unless the acting role may read customers; output caps (`apps/api/src/modules/mcp/tools/read-tools.ts:26`, `:141`, `:174`) | Whatever the role may see, the assistant (a third party) receives | Mitigated (tested: `t:mcp.test.ts`, `t:mcp-data-tools.test.ts`) |
| T | Prompt injection through customer-authored text | Customer text wrapped `{ untrusted: true, text }` (`packages/contracts/src/mcp.ts:401`–`406`, `read-tools.ts:25`), never interpreted server-side; write tools take typed zod input only; `query_data` bounded dimensions (`t:mcp-change-tools.test.ts:382`) | The marking is advisory to the assistant; a client can still follow injected text and propose an action, which then needs approval | Mitigated (tested) |
| D | Call floods, runaway assistants | Per-connection and per-tool rate limits (`access.guard.ts:82`); monthly `mcp_calls_per_month` quota, 402 when set (`t:mcp-change-tools.test.ts:362`); max sessions per connection (`apps/api/src/modules/mcp/mcp-runtime.controller.ts:63`) | No plan seeds the quota yet (O-4: entitlement matrix) | Mitigated (tested); quota values Open (owner prerequisite, O-4) |
| S/T | MCP session hijack across connections | Sessions in the database, bound to one connection (`mcp-runtime.controller.ts:72`–`96`, `t:mcp-change-tools.test.ts:403`); RLS `db:security-2-1.test.mjs:57` | — | Mitigated (tested) |
| R | Who asked, who approved | `mcp_tool_calls`, audit rows per transition (`t:changes.test.ts:484`) | — | Mitigated (tested) |

## 3. Change-set engine and external effects (§6.8)

| STRIDE | Threat | Mitigation and evidence | Residual risk | Status |
|---|---|---|---|---|
| E | A proposer without the op permission, or for another branch | Every op checked for permission and entitlement (`apps/api/src/modules/changes/changes.service.ts:206`–`210`), branch rules in the op handlers (`ops/menu.ops.ts:90`, `ops/promotion.ops.ts:31`, `ops/operations.ops.ts:45`, `ops/effect.ops.ts:31`); `t:changes.test.ts:143` | Branch-scoped staff may change org-wide records (product prices) when their role allows it, as in the REST menu | Mitigated (tested) |
| E | Approver without permission / branch, self-approval with two approvers, owner threshold | `approveTx` (`changes.service.ts:420`–`467`); `t:changes.test.ts:381`, `:427`, `t:studio-workspace.test.ts:221` | — | Mitigated (tested) |
| E | Reject by a role that could not approve | Reject now needs each op's permission and branch (`changes.service.ts:484`) | — | Gap fixed in this branch (F-2) |
| T | Stale target: approving something that changed after review | Targets re-read under advisory locks + `FOR UPDATE`, digest recomputed, set `invalidated`, never merged (`changes.service.ts:352`–`383`); `t:changes.test.ts:227`, `:243`, `:256` | — | Mitigated (tested) |
| T | Double apply under races and retries | Conditional transitions under the set's advisory lock (`changes.service.ts:290`, `:535`); `t:changes.test.ts:193`, `:214` | — | Mitigated (tested) |
| T | External effect lost or repeated | Transactional outbox (`change_effects` written in the apply transaction), leases, provider idempotency key `<changeSetId>:<opId>` (`changes.service.ts:571`, `:597`), unknown outcomes flagged `needs_attention`, never retried (`:741`); `t:changes.test.ts:281`, `:303`, `:331` | A provider without idempotency support could still double-execute after a lease loss; such effects are flagged, not retried | Mitigated (tested) |
| R | Reporting "done" before the provider confirms | Roll-up `applied / partially_applied / failed` (`changes.service.ts:662`–`682`); reversible vs follow-up compensation (`t:changes.test.ts:354`) | — | Mitigated (tested) |
| I | Cross-tenant op or id | Org filter + RLS on every read and write; `t:changes.test.ts:444`; IDOR sweep on get/audit/approve/reject/apply/reverse (`t:security-2-1.test.ts:152`) | — | Mitigated (tested) |
| I | Approvals inbox shows ops the reader may not read | Branch filter on list/get (`changes.service.ts:803`, `:860`) | Not filtered per op permission (F-6) | Accepted risk — needs owner sign-off (A-6) |
| I | Payment URL stored and re-shown | Deliverable handed to the approver once, not stored (`t:changes.test.ts:345`) | — | Mitigated (tested) |
| D | Proposal floods | Idempotency key per proposal; MCP limits | Staff proposals have no dedicated rate limit (staff are authenticated members) | Accepted risk — needs owner sign-off (A-12) |

## 4. Tenant isolation and RLS

Every request runs as `resuto_member` (membership-checked RLS), `resuto_tenant` (one restaurant) or the narrow
`resuto_platform` role (`apps/api/src/common/db/db.service.ts:166`–`191`); RLS is created by `app.enable_tenant_rls`
(`supabase/migrations/20261017000100_foundation.sql:200`). The whole API suite also runs as the restricted login
(`apps/api/vitest.restricted.config.ts`). A schema-wide test now fails if any public table lacks RLS
(`db:security-2-1.test.mjs:51`).

### Tables added in 2.1 (migrations 20261024210001 … 20261027210001)

| Table | Migration | RLS | Negative test (DB) | API-level negative test |
|---|---|---|---|---|
| `pos_device_pairings` | 20261024210001 | branch-scoped; code hash not readable | `db:pos-devices.test.mjs:70`, `:83`, `:94`, `:103` | `t:pos-flow.test.ts:535`, `t:security-2-1.test.ts:190` |
| `pos_devices` | 20261024210001 | branch-scoped; token hash not readable | `db:pos-devices.test.mjs:70`, `:103`, `:187` | `t:pos-flow.test.ts:585`, `t:security-2-1.test.ts:190`, `:248` |
| `pos_event_heads`, `pos_events` | 20261024210001 | branch-scoped; no session writes | `db:pos-devices.test.mjs:70`, `:117` | `t:pos-flow.test.ts:418` |
| `pos_order_submissions` | 20261024210001 | branch-scoped | `db:pos-devices.test.mjs:70`, `:83` | `t:pos-flow.test.ts:456` |
| `pos_print_jobs` | 20261024210001 | branch-scoped | `db:pos-devices.test.mjs:70`, `:138` | `t:pos-flow.test.ts:255` |
| `change_sets`, `change_ops`, `change_effects`, `change_decisions`, `change_policies` | 20261025100000 | tenant; members cannot write effects or rewrite decisions | `db:change-sets.test.mjs:53`, `:63`, `:77`, `:88`, `:99` | `t:changes.test.ts:444`, `t:security-2-1.test.ts:152` |
| `mcp_sessions` | 20261025200000 | tenant; members read only | `db:security-2-1.test.mjs:57`, `:71` (new) | `t:mcp-change-tools.test.ts:403` |
| `conversation_tags`, `conversation_tag_assignments` | 20261025300001 | tenant; assignments restricted to visible conversations; same-org trigger | `db:inbox.test.mjs:68`, `:79`, `:96`, `:107`, `:132` | `t:inbox.test.ts:217`, `t:security-2-1.test.ts:174` |
| `saved_replies` | 20261025300001 | branch-scoped (null = org-wide); same-org trigger | `db:inbox.test.mjs:68`, `:96`, `:107` | `t:inbox.test.ts:294`, `t:security-2-1.test.ts:174` |
| `user_preferences` | 20261025400001 | own row only (`auth.uid()` + membership) | `db:user-preferences.test.mjs:56`, `:69`, `:82`, `:93`, `:117` | `t:home.test.ts:394`, `:402` |
| `platform_provider_apps` | 20261025410001 | RLS on, no tenant policy, platform role only | `db:platform-provider-apps.test.mjs:49`, `:65` | `t:provider-apps.test.ts:47`, `:119` |
| `theme_presets` | 20261026100001 | read-only reference data | `db:onboarding-wizard.test.mjs:114` | — |
| `onboarding_progress` | 20261026100001 | own row only; org link only to own active membership | `db:onboarding-wizard.test.mjs:47`, `:65`, `:83` | `t:onboarding-wizard.test.ts:81` |
| `saved_reports` | 20261026300001 | own + shared, analytics readers only, branch-pinned hidden | `db:saved-reports.test.mjs:63`, `:79`, `:88`, `:107`, `:126`, `:148` | `t:reports.test.ts:109`, `:129`, `t:security-2-1.test.ts:166` |

Columns added to existing tables (covered by the table's existing RLS): `messages` notes (`kind='note'`, `direction='internal'`,
check constraint: `db:inbox.test.mjs:139`), `organizations.social_links` (`db:social-links.test.mjs:76`),
`customers.first_touch` and `attribution_events` beacon columns (`db:crm-first-touch.test.mjs:61`, `:131`),
`products.compare_at_price_minor` and new section kinds (`db:studio-workspace.test.mjs:70`),
`messaging_channels.routing` (`db:platform-provider-apps.test.mjs:88`), `mcp_clients.permission_groups/policy_overrides`
(`db:studio-mcp.test.mjs:93`), `websites.theme_preset_id` (`db:onboarding-wizard.test.mjs:149`).

### 2.1 endpoints probed for cross-tenant access (IDOR)

Another restaurant's ids in our own `:orgId` path and our token on their path — all 404 and no change on their side
(`t:security-2-1.test.ts`): change sets incl. audit/approve/reject/apply/reverse (`:152`), change policies (`:152`), saved
reports (`:166`), notes, tags, tag assignments, saved replies (`:174`), Customer 360, POS devices, pairings for a foreign
branch, a foreign device on our routes, our staff on their device (`:190`), menu QR, social links, attention, search,
preferences (`:209`), funnel/retention branch filter (`:223`), payments `?mode` (`:239`). Existing suites cover the same
endpoints for roles and branches (`t:inbox.test.ts:137`, `t:customer-360.test.ts:119`, `t:home.test.ts:343`,
`t:search.test.ts:152`–`:165`, `t:funnels.test.ts:341`, `t:reports.test.ts:129`, `t:studio-workspace.test.ts:98`, `:196`).

| STRIDE | Threat | Mitigation | Residual risk | Status |
|---|---|---|---|---|
| I/T | Tenant A reads or writes tenant B | Guard resolves `:orgId` to an active membership, 404 otherwise (`access.guard.ts:223`–`233`); RLS in every mode | Code that uses the platform role must filter by org itself (reviewed: 2.1 platform-role reads are lookups by hash/slug or job scans followed by `withTenant`) | Mitigated (tested) |
| I | Branch-scoped staff see other branches | RLS branch predicate on branch tables plus `branchFilter` in queries | Tables without a branch column (change sets, MCP approvals) rely on code filters — F-1 was such a gap | Mitigated (tested); F-1 fixed |
| E | Database owner connection bypasses RLS | Restricted runtime login `resuto_api` (NOINHERIT, NOBYPASSRLS) exists and the suite passes as it | **Staging still connects as the owner** | Open (owner prerequisite, O-3) |

## 5. POS device API (21-POSAPI, `docs/api/IPAD_COMPATIBILITY.md`)

| STRIDE | Threat | Mitigation and evidence | Residual risk | Status |
|---|---|---|---|---|
| S | Guessing a pairing code | ~50-bit single-use codes, ≤ 1 h, hashed; 30 attempts / 10 min per address on the shared limiter (`apps/api/src/modules/pos/pos.controller.ts:62`); `t:pos-flow.test.ts:152` | Distributed guessing across many addresses is bounded only by code entropy and lifetime | Mitigated (tested) |
| S | Device token theft | `rpos_` + 256-bit token, sha256 at rest, never readable by sessions (`db:pos-devices.test.mjs:103`); TTL; revocation effective on the next request (`access.guard.ts:190`, `t:pos-flow.test.ts:585`, `t:pos-staff.test.ts:175`) | A stolen token works until revoked or expired; there is no device binding (no hardware attestation) | Mitigated (tested) |
| E | Device credential used elsewhere / staff token on device routes | Device tokens only on `@PosDevice` routes and vice versa (`access.guard.ts:69`, `:75`); `t:pos-flow.test.ts:162`, `:638` | — | Mitigated (tested) |
| E | Staff on a device exceeding the device's role | `X-Resuto-Staff-Authorization`: active membership in the device's restaurant and branch (`access.guard.ts:136`–`141`), role bounded by the device's acting role (`ceilingRole`, `access.guard.ts:144`); `t:pos-staff.test.ts:119`, `:135`, `:153` | — | Mitigated (tested) |
| E | Branch or tenant escape | Device context is one branch; foreign orders 404 (`t:pos-flow.test.ts:535`; `t:security-2-1.test.ts:190`) | — | Mitigated (tested) |
| E | Issuing a device credential without step-up | Pairing needs `devices:manage` (owner/admin/manager), audited | No MFA step-up on pairing (F-9) | Accepted risk — needs owner sign-off (A-9) |
| D | A device floods the API | 600 requests/min per device incl. staff requests (`access.guard.ts:21`, `t:pos-staff.test.ts:185`) | — | Mitigated (tested) |

## 6. OAuth and provider credentials, operator console

| STRIDE | Threat | Mitigation and evidence | Residual risk | Status |
|---|---|---|---|---|
| S/T | OAuth CSRF / code injection | State bound to user, organisation and a browser nonce (only its hash at the API), PKCE where supported; callback forwards and completes nothing (`t:oauth-binding.test.ts:48`, `:54`, `:71`) | Provider-side behaviour unverified until live runs | Mitigated (tested); live verification Open (O-6) |
| I | Tokens and app secrets readable | AES-GCM key ring (`apps/api/src/common/crypto/secret-box.ts`), member sessions cannot read credentials (`db:payments-authenticity.test.mjs:80`); console app secrets sealed, masked hint only, audits names not values (`t:provider-apps.test.ts:79`) | Keys live in environment variables of the API host | Mitigated (tested) |
| E | Tenant reaches platform provider apps | `/v1/admin/providers` `@PlatformAdmin` + `@RequireMfa` (`apps/api/src/modules/integrations/provider-apps.controller.ts:20`–`45`); writes superadmin only; no tenant policy on the table (`t:provider-apps.test.ts:47`, `db:platform-provider-apps.test.mjs:49`) | — | Mitigated (tested) |
| E | Credentials replaced on a password-only session | `@RequireMfa` on create/update connection, OAuth start/complete, account selection (`t:mfa-step-up.test.ts:71`) | Opt-in MFA (A-1) | Mitigated (tested) |
| T | Open redirect after OAuth | `redirectAfter` must start with one `/` | Backslash form (F-8), self-only | Accepted risk — needs owner sign-off (A-8) |

## 7. Payments and webhooks

No 2.1 change to verification; 2.1 added the payment-link effect (change sets), its reversal (`apps/api/src/modules/payments/checkout.service.ts:90`, org-filtered) and the `?mode=test|live` filter (parameterised, tenant-scoped; `t:security-2-1.test.ts:239`).

| STRIDE | Threat | Mitigation and evidence | Residual risk | Status |
|---|---|---|---|---|
| S/T | Forged or replayed webhook | Raw-body signature verification with the connection secret, dedupe, leases (`t:payments.test.ts:124`, `:224`, `t:webhook-inbox-leases.test.ts:38`) | Real providers not yet exercised (B-3) | Mitigated (tested); live Open (O-6) |
| T | Over-payment, double refund | Ledger invariants, one provider attempt per session, refund keys (`t:payments-safety.test.ts:74`–`:212`; `db:payments-authenticity.test.mjs:52`, `:61`) | — | Mitigated (tested) |
| I | Webhook payload retention | Rejected deliveries keep a reason, hash and redacted excerpt; purge after retention (`t:payments-safety.test.ts:256`, `:266`) | — | Mitigated (tested) |

## 8. Public endpoints

| Surface | Threat | Mitigation and evidence | Residual risk | Status |
|---|---|---|---|---|
| Table / venue QR (`/v1/public/tables/:qrToken`, venue) | Guessing or leaking QR tokens | Long random tokens, never in public payloads (`t:public-surface.test.ts:51`, `:67`; `t:venue-qr.test.ts:23`, `:58`) | Printed QR codes are visible to anyone at the table (by design) | Mitigated (tested) |
| Menu QR `/m/<slug>` and `GET /v1/o/:orgId/menu-qr` | Ordering through a view-only QR; foreign branch code | URL carries no token; branch code resolved in the caller's restaurant and scope (`apps/api/src/modules/platform/onboarding.service.ts:100`–`113`; `t:onboarding-free.test.ts:192`, `t:security-2-1.test.ts:209`) | — | Mitigated (tested) |
| Public menu / site JSON | Cost, stock or private data leak | Public read models (`t:public-surface.test.ts:51`, `t:studio-workspace.test.ts:132`) | — | Mitigated (tested) |
| Funnel beacon `POST /v1/public/funnel/beacon` | Personal data, oracle, floods | No identifiers stored, 204 for unknown restaurants, 512-byte JSON, 600/min per address + 30/min per tab id (`apps/api/src/modules/analytics/funnel-beacon.ts:27`, `t:funnels.test.ts:45`–`:138`, `:357`) | Anyone can inflate a restaurant's funnel counts within those limits (rotating tab ids); no retention job; the text/plain reader keeps reading (discarding) an over-long chunked body | Accepted risk — needs owner sign-off (A-5) |
| Search `GET /v1/o/:orgId/search` | Cross-tenant hits, LIKE injection, scraping | Member + role + branch scoped, wildcards escaped, 20 hits, per-member limit (`t:search.test.ts:73`, `:152`–`:173`) | — | Mitigated (tested) |
| Web ordering, reservations, ratings | Abuse, phone spam | Shared-store limits on placement and holds, per-phone budgets (`t:phone-budget-shared.test.ts:41`, `t:rate-limit-store.test.ts:89`) | No CAPTCHA (O-2) | Mitigated (tested); CAPTCHA Open (O-2) |
| Slug availability `GET /v1/orgs/slug-availability` | Enumerating restaurants | Signed-in people only, per-user limit (`apps/api/src/modules/platform/onboarding.controller.ts:25`–`29`; `t:onboarding-free.test.ts:261`, `:282`) | Sign-up is open, so anyone can create an account and test slugs (slugs are public URLs anyway) | Accepted risk — needs owner sign-off (A-11) |
| Public plans `GET /v1/public/plans` | Scraping | Public information, 120/min per address (`apps/api/src/modules/billing/billing.controller.ts:24`–`29`) | — | Mitigated (untested for abuse) |
| POS pairing `POST /v1/pos/pair` | see §5 | | | |

## 9. Inbox, Customer 360 and Studio content

| STRIDE | Threat | Mitigation and evidence | Residual risk | Status |
|---|---|---|---|---|
| I | An internal note is sent to the customer | Notes are `direction='internal'`, unrepresentable as sendable (check constraint `messages_note_internal`, `supabase/migrations/20261025300001_inbox_workspace.sql:25`–`29`; `db:inbox.test.mjs:139`); the Cloud API sender job skips them (`t:inbox.test.ts:88`); no outbox event (`t:inbox.test.ts:42`) | — | Mitigated (tested) |
| I | Notes/tags visible to roles or branches that may not see the conversation | `connect:read` + restrictive assignment policy; Customer 360 omits conversations without `connect:read` (`t:customer-360.test.ts:119`, `:139`; `db:inbox.test.mjs:107`) | — | Mitigated (tested) |
| T | Stored XSS through notes, saved replies, guest comments | Rendered as React text; attention items mark guest comments as untrusted (`apps/api/src/modules/home/attention.service.ts:181`) | — | Mitigated (untested for rendering) |
| T | XSS through social links | https only, per-network hosts, no credentials or control characters, re-validated on read (`packages/contracts/src/social-links.ts:39`, `:64`; DB check; `t:onboarding-free.test.ts:133`, `db:social-links.test.mjs:55`) | — | Mitigated (tested) |
| T | `</script>` breaking JSON-LD | `jsonLdScript` escapes `<`, `>`, `&`, U+2028/9 (`apps/web/app/r/[slug]/_components/structured-data.ts:108`–`109`; `apps/web/app/r/[slug]/_components/structured-data.test.ts:89`) | — | Mitigated (tested) |
| T | Section content as markup or foreign references | Section content is typed text, ids only (media, products, categories) checked against the restaurant (`packages/contracts/src/studio.ts:61`–`78`; `t:studio-workspace.test.ts:83`); public render resolves ids within the org | — | Mitigated (tested) |
| T/I | Studio canvas iframe reaching the editor | 22-STUDIO: the canvas is a `srcdoc` frame sandboxed with `allow-same-origin` only — **no scripts can run in it** (no `allow-scripts`), no forms, popups or navigation; the editor renders the owner's own draft into it with React (escaped text) and attaches the listeners itself; there is no message channel to forge and no canvas page URL (the 21-STUDIO `/studio-canvas` route and its `frame-ancestors 'self'` / staff `frame-src 'self'` exceptions are gone: every page is `frame-src 'none'`, `frame-ancestors 'none'`). Replaces the opaque-origin design, whose cross-site subresource requests failed behind cookie-gated deployments (`apps/web/lib/studio-canvas.ts`) | — | Mitigated (tested: `apps/web/lib/studio-canvas.test.ts`, `tests/e2e/studio-workspace.spec.ts` injected script stays inert, frame requests same-origin) |
| T | Uploaded logo as active content | PNG/JPEG/WebP/GIF/PDF by magic bytes, no SVG (`apps/api/src/common/storage/storage.service.ts:14`–`20`) | — | Mitigated (tested in storage suites) |
| I | WhatsApp test template to arbitrary numbers | 10/hour per restaurant, `connect:manage`, audited (`apps/api/src/modules/connect/whatsapp-onboarding.service.ts:25`–`26`) | Any approved template, any number (F-7) | Accepted risk — needs owner sign-off (A-7) |

## 10. Web session, CSP and redirects

| STRIDE | Threat | Mitigation and evidence | Residual risk | Status |
|---|---|---|---|---|
| I | Token theft from `localStorage` by injected script | Per-request nonce CSP with `strict-dynamic`, `script-src-attr 'none'` (`apps/web/lib/csp.ts`, `apps/web/middleware.ts`; `apps/web/lib/csp.test.ts:12`) | Any XSS (including a compromised dependency) can read the token; httpOnly cookie + CSRF token was evaluated in the plan but not adopted | Accepted risk — needs owner sign-off (A-2) |
| I | Exfiltration through images | — | `img-src 'self' data: blob: https:` allows any HTTPS host (tenant image URLs on arbitrary hosts) | Accepted risk — needs owner sign-off (A-3) |
| T | Open redirect after sign-in | `safeNext` parses and requires same origin, no control characters or backslash (`apps/web/lib/safe-next.ts`) | OAuth `redirectAfter` (F-8) | Mitigated (tested); F-8 accepted |
| T | Clickjacking | `frame-ancestors 'none'`, `X-Frame-Options: DENY` except the canvas (same origin) (`apps/web/next.config.ts:56`, `:64`) | — | Mitigated (tested: `apps/web/lib/csp.test.ts:18`) |

## 11. Platform controls

| Control | Current state and evidence | Residual risk | Status |
|---|---|---|---|
| Rate limiter store failure | Falls back to per-instance counting and logs (`apps/api/src/common/http/rate-limiter.ts:73`–`88`; `t:rate-limit-store.test.ts:66`, `:108`) | With N instances, up to N× the limit while the store is down. The routes it protects need the same database, so they fail too during a full outage; the plan's "fail closed for auth-sensitive routes" is not implemented (sign-in itself is Supabase Auth's) | Accepted risk — needs owner sign-off (A-4) |
| Staging database role | Owner connection (`docs/STAGING_DEPLOYMENT.md`, "Least-privilege database role") | RLS bypass possible for code on the owner connection | Open (owner prerequisite, O-3) |
| Password policy | Client-side rules + Pwned Passwords range check; server floor = Supabase dashboard minimum length and characters (`docs/SECURITY_AUTH.md` §3) | Bypassable by calling Supabase Auth directly | Accepted risk — needs owner sign-off (A-10, Free plan decision) |
| CAPTCHA | Not built | Automated sign-ups and public-form abuse limited only by rate limits | Open (owner prerequisite, O-2) |
| Owner MFA | Opt-in for everyone, including owners (`docs/SECURITY_AUTH.md` §4) | See A-1 | Accepted risk — needs owner sign-off (A-1) |

## 12. Accepted risks that need the owner's sign-off

Nothing below was changed in this branch. Each line is a decision, not a guarantee.

| # | Risk | Why it stays for now | Suggested follow-up |
|---|---|---|---|
| A-1 | MFA is opt-in: change-set and MCP approvals (and every other step-up route) accept aal1 from users without an enrolled factor, owners included. | Supabase Free, demo accounts, small restaurants; making it mandatory locks out un-enrolled owners. | A per-restaurant setting "approvals need two-step verification" that refuses aal1 for un-enrolled approvers (`MfaGuard`), default on for new restaurants. |
| A-2 | Session token in `localStorage`. | Mitigated by the nonce CSP; a cookie session needs a CSRF design across web and API origins. | Record the decision; revisit with a BFF/cookie session when the web and API share a site. |
| A-3 | CSP `img-src https:`. | Tenant images may live on any HTTPS host (imports, older menus). | Narrow to the storage host, provider CDNs and custom domains once every image is served from storage. |
| A-4 | Rate limiter falls back to per-instance counting when the shared store is unreachable. | Refusing all traffic on a store hiccup would take guest ordering down. | Fail closed only for OTP / pairing / OAuth token routes. |
| A-5 | Funnel beacons can be inflated by anyone within the limits; no retention; over-long chunked text/plain bodies are read to the end and discarded. | Aggregate, labelled partial/estimate; no personal data. | Per-restaurant daily cap, 400-day retention job, destroy the request past the size limit. |
| A-6 | The approvals inbox shows every op of a visible change set to any `changes:read` role (marketing sees order-status ops and payment-link amounts). | Product decision on who may watch approvals. | Hide or redact ops whose read permission the viewer lacks. |
| A-7 | WhatsApp test template: any approved template to any number, 10/hour per restaurant. | Needed for the stepper; insider with `connect:manage`. | Allow only `WHATSAPP_TEST_TEMPLATE` and/or the caller's own verified phone. |
| A-8 | OAuth `redirectAfter` accepts `/\host` (self-only open redirect). | Not reachable by a third party (start needs the victim's bearer token). | Use `safeNext()` on the callback page and refuse `\` in the contract regex. |
| A-9 | Pairing a POS device has no MFA step-up. | Managers pair tills at shift start; the device role is capped at waiter/cashier/kitchen. | `@RequireMfa()` on `POST /o/:orgId/pos/pairings` (contract change for the iPad app). |
| A-10 | Password policy enforced in the browser only. | Supabase Free has no server hook for it (owner decision 2026-10-21). | Supabase password hook or paid leaked-password protection. |
| A-11 | Slug availability enumerable by any signed-up account. | Slugs are public URLs. | — |
| A-12 | MCP management reads (`clients`, `calls`, `usage`) are not branch-filtered; staff change-set proposals have no dedicated rate limit. | Only owners/admins hold `mcp:manage`; proposals need membership. | Filter by the caller's branches; per-member proposal limit. |
| A-13 | `MCP_ALLOW_URL_KEY` lets keys travel in URLs when enabled. | Off by default and on staging. | Keep off; remove when no client needs it. |

## 13. Open owner prerequisites

| ID | Item | Blocks |
|---|---|---|
| O-2 | Cloudflare Turnstile site key | CAPTCHA on sign-up and public forms (§8, §11) |
| O-3 | Approve switching staging `DATABASE_URL` to `resuto_api` | Least privilege on staging (§4) |
| O-4 | Approve the entitlement matrix | `mcp_calls_per_month` values (§2); pricing/plan enforcement is unchanged here |
| O-6 | Provider apps and test credentials (B-3 … B-21) | Live verification of OAuth, payments, WhatsApp and the MCP OAuth flow with Claude.ai / ChatGPT (§2, §6, §7) |
| — | Sign-off on §12 | Each accepted risk |

## 14. Verification (this branch)

Commands run locally against disposable databases on the shared cluster (names containing `ws21sec`); counts are in the
hand-off report of the 1D security workstream and in `docs/TEST_RESULTS.md` when merged.

```
pnpm --filter @resuto/contracts build && pnpm --filter @resuto/integrations build
cd apps/api && TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54329/resuto_test_ws21sec npx vitest run
cd apps/api && TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54329/resuto_test_ws21sec_r npx vitest run -c vitest.restricted.config.ts
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54329/resuto_test_ws21sec_db node --test --test-concurrency=2 supabase/tests/*.test.mjs
```
