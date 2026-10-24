# Change sets (WS 21-CS)

One engine for every change that someone other than the person doing it should review: MCP clients, Studio AI, the
copilot and staff proposals. Plan: `docs/plans/RESUTO_2_1_PLAN.md` §6.8. Code: `apps/api/src/modules/changes/`,
contracts: `packages/contracts/src/changes.ts`, schema: `supabase/migrations/20261025100000_change_sets.sql`.

## Model

| Table | Holds |
|---|---|
| `change_sets` | origin (`mcp`, `studio_ai`, `copilot`, `staff`), actor and its scope at proposal, status, policy snapshot, approvals required, owner requirement, preview digest, client idempotency key, expiry, decision, error |
| `change_ops` | one typed op per row: type, group, `local` or `effect`, input, target (type, id), the target's version and `before` values at proposal, `after`, preview lines, status, stored result |
| `change_effects` | the transactional outbox for external effects: status, attempts, backoff, lease, provider key `<changeSetId>:<opId>`, compensation |
| `change_decisions` | one approval or rejection per person (role, note, digest, `aal`) |
| `change_policies` | per restaurant and op group: `auto`, `approval` or `blocked`, 1 or 2 approvers, owner discount threshold |

All five use `app.enable_tenant_rls`. Staff sessions cannot write `change_effects` or edit `change_decisions`; the
platform role only reads `change_sets` and `change_effects` (jobs find due work, then write per tenant).
`mcp_approvals.change_set_id` links an MCP request to its set.

## Ops

Each op is a typed handler (`op-handler.ts`, registry `op-registry.ts`): zod input, `validate()` (domain rules,
records exist in this tenant, branch scope), `snapshot()` (target, version, before; `FOR UPDATE` when locking),
`preview()` (summary and before/after lines), `applyLocal(tx)` or `effect()`, and `reverse()` for reversible effects.
The proposer needs each op's permission and the restaurant its module.

| Op | Group | Kind | Notes |
|---|---|---|---|
| `menu.item.update` | menu | local | name, Arabic name, descriptions, listed; version = `products.version` |
| `menu.item.price.set` | prices | local | at most 10x up or down in one change |
| `menu.item.availability.set` | menu | local | the 86 through MENU_AVAILABILITY_PORT |
| `promotion.create` | promotions | local | percent 1–90 %, fixed not above the minimum order or its cap, code free, branches in scope |
| `website.section.add` / `.update` | website_drafts | local | draft only; content references must be this restaurant's |
| `website.publish` | website_publish | local | runs after the set's other local ops; version = draft revision |
| `campaign.send` | messages | effect | CAMPAIGN_SEND_PORT; irreversible (follow-up when the set is partial) |
| `payment_link.create` | payments | effect | CHECKOUT_PORT; reversible (cancel the link); the URL is a deliverable, never stored |

## State machine

`draft → validated → pending_approval → approved → applying → applied | partially_applied | failed`, plus `rejected`,
`expired` and `invalidated`. Every transition is `UPDATE … WHERE status = <current>` under the set's advisory lock
(`change_set:<id>`, then the row lock) and writes `audit_logs` (`change_set.<status>`, entity `change_set`). Ops write
`change_op.proposed`, `change_op.applied`, `change_op.effect_queued`, `change_op.effect_retry_scheduled`,
`change_op.effect_succeeded`, `change_op.effect_failed` and `change_op.reversed` with actor, origin, approver,
before/after, result and the request id. `GET /o/:orgId/change-sets/:id/audit` lists them (and the MCP approval's rows).

- **Proposal**: idempotent per (actor, `Idempotency-Key`): the same body returns the first set, another body is 409.
  Policy: the strictest mode of the set's groups and the caller's floor; `blocked` refuses with 403 `change_blocked`
  and stores nothing; `auto` approves and applies at once; `approval` waits (24 h, then `expired`).
- **Approval**: per-target advisory locks in sorted order (`change_target:<org>:<type>:<id>`), then every target is
  re-read `FOR UPDATE`, re-validated and its version and before-values compared with the proposal; the proposer's role
  and branches must be unchanged and the recomputed digest equal. Any difference sets `invalidated` (409
  `change_set_invalidated`); nothing is merged. A `previewDigest` sent by the approver must match (409 `approval_changed`).
- **Apply**: keyed by the set id. Only the call that moves `approved → applying` does anything; parallel approvals,
  retries, `POST …/apply` and the resume job are no-ops. The same freshness check runs again, then all local ops run in
  one transaction (savepoint: one failing op fails the set and nothing local is kept) and each effect gets a
  `change_effects` row in that same transaction.
- **Effects**: attempted once right after commit, then by the `changes.effects` job (15 s): claim with a 120 s lease,
  execute in its own transaction together with the fenced success mark (an interrupted attempt rolls back and is
  retried), business-rule refusals fail at once, other errors retry 5 times with exponential backoff (30 s base, 1 h
  cap, jitter). The set is `applied` only when every effect succeeded; with a failure it is `partially_applied` when
  anything took effect (local ops, or another effect) and `failed` otherwise. Succeeded effects of a partial set are
  then `available` to undo (`POST …/ops/:opId/reverse`) or `follow_up` (irreversible: a person follows up).
- **Resume**: sets left `approved` or `applying` for 2 minutes (a crash between transactions) are applied or rolled
  up by the job; `changes.expire` (60 s) expires undecided sets.

## Approval policy

Defaults (`DEFAULT_CHANGE_POLICIES`): prices, promotions, outbound messages and payment links need approval; menu edits
and website drafts and publishing are automatic. A percent offer above `ownerAboveBps` (default 3000 = 30 %) needs the
owner among the approvers, even when the promotions group is automatic. `approvers: 2` asks for two different people,
neither of them the proposer. Approve, reject, reverse and policy edits use `@RequireMfa()`: users with a verified
factor need an `aal2` session; users without one are not locked out (MFA is opt-in). The decision row records the
session's `aal`. Approvers (permission `changes:approve`) are notified through the notification centre
(`change_set.approval_requested` → kind `approval_requested`); MCP requests keep their own `mcp.approval_requested`.

Permissions: `changes:read` (inbox), `changes:approve`, `changes:manage` (policy). Owner and admin have all three,
manager and marketing read and approve.

## MCP adapter

`request_campaign_send`, `create_payment_link` and `update_product_availability` create a one-op change set with
floor `approval` in the transaction that creates their `mcp_approvals` row, which stays the client-facing projection
(`get_approval_status`, `/mcp/approvals`). Approving keeps the existing binding (scope snapshot and preview digest,
migration `20261021030002`), then approves the set in the same transaction and applies it after commit. An origin
adapter keeps `mcp_approvals` in step (`executed` with the result, `failed`, `invalidated`, `expired`, `rejected`); the
payment URL goes to `mcp_approvals.result` and is handed to the client once as before. `approved` now means "approved,
effect still running". Requests created before change sets are linked when approved. MCP approve and reject require MFA.
The engine's inbox endpoints delegate decisions on MCP sets to the adapter (lock order: approval, then set).

## API

`/v1/o/:orgId/change-sets`: `GET` (inbox, `status=open|all|<status>`, `origin`), `POST` (staff proposal,
`Idempotency-Key` required), `GET /:id`, `GET /:id/audit`, `POST /:id/approve`, `/reject`, `/apply`,
`/ops/:opId/reverse`. `/v1/o/:orgId/change-policies`: `GET`, `PUT /:group`.

## Known limits

- A staff payment link created by the job (not in the approve request) has no deliverable; the link is re-opened from
  Payments › Links.
- `campaign.send` confirms the hand-over to the campaign sender (messages queued or scheduled); delivery itself is
  tracked on the campaign.
- Effects in this release are database-backed ports whose result commits with the success mark; a non-atomic provider
  effect would need `atomic = false`, which marks an attempt with an unknown outcome `needs_attention` (column present,
  no such effect yet).
- No approvals inbox UI yet (plan §6.6; 21-CS backend only).
