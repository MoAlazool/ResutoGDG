# Native backend dependency report — for Claude

Current staging rollout/QA handoff: [`docs/STAGING_READINESS_20261025.md`](docs/STAGING_READINESS_20261025.md). Claude tip `48f5eeb` retains the pinned POS contract, but staging lacks the POS schema and authorized native QA identities. Deploying the current backend startup applies eleven pending migrations; this must be reviewed as a wider staging rollout. No migration/deployment has been performed by the native track.

Latest contract review: Claude `69ec75e63b3660c2c307564d2dd402de45b4dad7` implements POS API **0.2.0 draft**, including `requireStaff`, staff permission intersection/attribution and permanent by-client-ID lookup. `IPAD_INTEGRATION.md` and `IPAD_COMPATIBILITY.md` still mark staging/native acceptance pending. No shared branch/backend/infrastructure mutation was performed.

The original proposals below describe gaps in the working **staff-route baseline**. Claude's draft POS API addresses pairing, price consent, permanent order IDs, branch events and shared print jobs; those are now **integration/verification dependencies**, not requests to invent alternative routes. New native adapters are tested against synthetic reviewed contracts, but order/payment routing stays on staff routes until Claude's documented shadow/staging gates pass. See `docs/POS_API_MIGRATION.md`.

Contract baseline: `1746b4f6ee5e03bd0d9c8943b37e680eca057dce`; orders/payments contracts v2. This report proposes changes; none of the proposed routes below are called by the app. Backend ownership remains with Claude. No shared backend, migration, deployment, or infrastructure changes are included.

## Existing integration, verified from implementation

The client calls `/v1/me`, `/v1/o/{orgId}`, `menu`, `menu/products/{productId}/availability`, `floor/{branchId}`, `floor/{branchId}/live`, `orders`, `orders/{id}`, `orders/{id}/transition`, `orders/{id}/cancel`, `orders/{id}/collect`, `payments/{paymentId}/refunds`, `visits`, `visits/{visitId}/close`, `tables/{tableId}/clean`, and `kitchen/{branchId}`. Exact methods are asserted in `scripts/check_contracts.py` against `docs/api/openapi.json`.

Auth uses Supabase `/auth/v1/token?grant_type=password`, `grant_type=refresh_token`, and `/auth/v1/logout`, not the development issuer and not MCP credentials. Tokens are bearer credentials to the same NestJS access guard used by web. `/me` memberships define restaurant, role, and allowed branches. `/o/{orgId}` returns filtered branches. The server checks membership, permissions, entitlements and branch scope again on every operation.

Staff creation accepts channel `staff` or `phone`, **not `pos`**, despite `pos` appearing in the wider channel enum. It calls `OrdersKernelService.place` inside the tenant transaction and emits `order.placed` through the transactional outbox. The resulting orders feed the same staff order read model, KDS, inventory effects and analytics. No iPad-specific authoritative ledger or order database is created. Cash collection uses the existing payment ledger. Refund requests use ResutoPay and respect its entitlement gate.

Operational changes use existing ETags and foreground polling (5 seconds in this client). KDS provides a `since` cursor, but there is no supported native push subscription. The app currently requests the full feed with ETag revalidation. Kitchen status is shown only from server responses. Creation acknowledgement means server acceptance, not proof that every asynchronous effect was processed.

## P0 baseline gap: staff quote and conditional creation

**Draft resolution:** Claude’s `/pos/orders/quote` and expected total/line consent address this on device routes; activate after 0.2.0 staging deployment and native acceptance. The proposal below is historical context for the staff-route gap, not a request for a parallel quote design.

**Missing in the staff baseline:** `staffOrderRequest` has neither `expectedTotalMinor` nor a quote/version token. Public guest/web quoting does not authorize a staff POS to reuse guest identity or public visit tokens. Creation can reprice between menu review and submission.

**Proposed** `POST /v1/o/{orgId}/orders/quote` (`orders:write`): input `StaffOrderRequest`; output `{quoteId: UUID, expiresAt: ISO8601, currency, subtotalMinor, discountMinor, serviceChargeMinor, deliveryFeeMinor, taxMinor, taxInclusive, totalMinor, lines: [{productId, productVersion, quantity, unitPriceMinor, modifiersTotalMinor, lineTotalMinor}], branchRevision}`. Bind quote to org, branch, authenticated actor, immutable payload fingerprint and relevant pricing revisions. Extend creation with `quoteId` and `expectedTotalMinor`; consume/check transactionally and return 409 `price_changed` with a new quote when stale. Never accept client tax arithmetic.

Contract acceptance: price/modifier/promotion/tax/availability change after quote must either preserve a valid promised quote by explicit business policy or reject before any order, inventory decrement, KDS event or payment effect. Cross-tenant, cross-branch, expired and other-actor quote reuse must fail. Simultaneous same-key creation must emit one business effect.

**Client behavior now:** item estimates are labelled estimates; local orders require fresh-menu review; server totals are shown after acceptance. Full price-consent guarantees remain blocked. Do not market offline draft capture as offline committed ordering.

## P0 baseline gap: durable operation reconciliation

**Draft resolution:** permanent POS `clientOrderId` rows exist in Claude’s 0.1.0 source; the 0.2.0 `by-client-id` lookup is implemented in the reviewed branch. Use that agreed route rather than the historical generic operation proposal below.

Existing staff idempotency rows expire after seven days. Native retries use the original key and immutable payload; replay stops before that horizon. A replacement key could duplicate an already accepted order after an ambiguous result.

**Proposed** `GET /v1/o/{orgId}/operations/{clientOperationId}` (`orders:read`, actor/branch scoped): `{state: "unknown"|"processing"|"accepted"|"rejected", orderId?:UUID, payloadHash?:string, acceptedAt?:ISO8601, failure?:{code,details}}`. Persist a unique `(org_id, client_operation_id)` association on the authoritative order independently of short-lived HTTP replay rows. Creation accepts the same `clientOperationId`; immutable payload mismatch is 409. Unknown must not imply safe creation until retention/uniqueness semantics are explicit.

Acceptance: lost response + restart + retry after 8/30 days cannot create a second order or kitchen ticket; another org/actor cannot enumerate operation state. Client currently marks expired/semantic rejection as attention and never automatically assigns a new operation ID.

## P0 baseline gap: device authorization and remote revocation

**Draft resolution:** one-use pairing codes and hashed bearer device credentials now exist in Claude’s draft 0.1.0. `requireStaff`, staff headers/intersection and attribution are implemented in draft 0.2.0. The proposed public-key/App Attest enrollment below is optional future policy, not an additional route request.

No device contract is deployed in the inspected staging environment; attestation/PIN staff-switch contracts remain absent. Do not simulate registration with local UUIDs.

**Proposed** owner/manager enrollment challenge → `POST /v1/o/{orgId}/pos/devices/enroll` with `{challenge, publicKey, displayName, branchId, attestation?}` → `{deviceId, status, policy:{offlineDraftTTLSeconds, allowedBranchIds}, credentialExpiry}`. Add list/revoke endpoints with `members:manage` or a dedicated permission. Device credential supplements user authentication; it must not replace employee permissions. Validate App Attest server-side where adopted. Log enrollment, reassignment, sensitive actions and revocation without raw keys. Native offline unlock policy must define lease expiry and device/user revocation exposure.

Settings implements pairing and read-only shadow monitoring; staging deployment and actual enrollment verification are pending. Staff switch is full sign-out/sign-in. Reopening an app after termination needs an online identity validation; ongoing authenticated sessions may capture drafts offline for at most eight hours after last successful refresh. Cached data alone never establishes membership.

## P1: server order amendments, table transfers, merge and item split

No staff order-line amendment, order-table transfer, or check merge endpoint was found in the current orders controller. Public bill splits require `x-visit-token`; a staff token must not be exchanged for guest authority.

**Proposed** commands under `/o/{orgId}/orders/{id}`: `amend` `{expectedVersion, lines/changes, reason, clientOperationId}`, `move-table` `{expectedVersion,targetTableId,reason,clientOperationId}`, and staff bill split `/visits/{id}/splits` `{mode,people?,amounts?,allocations?,expectedVersion,key}` returning authoritative shares. Require appropriate `orders:write`, `floor:seat`, `payments:collect` checks and branch locks; paid/settling visits must reject unsafe changes. Amendments must route kitchen deltas without duplicating already prepared lines, adjust stock atomically and preserve an audit trail.

Current client edits unsubmitted drafts, adds subsequent table orders using existing visits, and supports partial cash amounts with an equal-split calculator. It does not claim item/customer allocation or merged checks. Existing delivery orders can be read/advanced subject to server driver rules; native delivery address entry and existing customer selection use the supported staff contract; full dispatch/provider acceptance remains unverified.

## P1: authenticated operational event stream

**Proposed** authenticated branch-scoped SSE/WebSocket stream with monotonic event cursor and `{eventId,type,orgId,branchId,entityId,version,occurredAt}`. Send invalidation identifiers rather than PII, authorize subscription and reconnect, bound replay retention, and provide a snapshot watermark/gap signal. Cover order, kitchen, catalogue availability/price, floor/visit, reservation and payment changes. Preserve polling fallback. Test revoked membership, cross-branch subscriptions, reconnect gaps and duplicate/out-of-order delivery.

## P1: native payment provider and fiscal receipt contract

Current manual cash is confirmed through the server ledger; refunds may return pending/unknown/manual_required and must not appear successful locally. No native card reader SDK/provider-supported offline authorization contract was established. Integration provider acceptance remains unverified in the repository handoff.

**Needed:** explicit supported terminal/provider selection; tokenized native initiation and server verification; fiscal receipt response with legal entity/tax identity, invoice number, authoritative allocations and regulatory QR/signature data where required. An operational order summary is not a certified ZATCA/ETA receipt. Physical cash refund completion remains in existing ResutoPay web workflow; native request does not assert cash returned.

## P2: generated response schemas and permission/entitlement capability discovery

OpenAPI includes routes/requests but not every response shape. Add complete versioned response schemas and a native capability endpoint exposing permissions, entitlements and supported operations without replacing server guards. This enables generated DTO drift checks, meaningful feature availability and contract tests across all roles. Current Swift DTOs are reviewed hand-written subsets; generated permissions are UI hints only.

## Coordination with 21-POSAPI / 0.2.0

Use Claude's `docs/api/IPAD_INTEGRATION.md` migration sequence: (1) merged/deployed staff-on-device pairing plus read-only shadows, (2) quoted POS orders/reconciliation/payments after real native cross-platform acceptance, (3) kitchen/shared printing after hardware acceptance, (4) mark contracts stable. The native implementation now includes dual-credential/scoped storage, typed session/menu/floor/order/event/quote/conflict/print DTOs, an encrypted-store-compatible event journal and read-only shadow synchronizer, and a quote-aware submitter. Settings now selects pairing and read-only shadows; working order/payment flows retain staff routes. No unsupported route is called live.

Finalization needed from Claude:

1. Deploy and verify 0.2.0's staff header authentication, `device.requireStaff`, effective permissions and staff attribution alongside device ID; native decoding now uses the finalized `staff: {id,email,role}` and top-level/session `requireStaff` fields. Verify a missing/expired staff token never acts as device role, and cross-tenant/branch lookup is denied without disclosure.
2. Deploy and verify permanent `GET /pos/orders/by-client-id/{clientOrderId}` semantics and accepted/processing/404 response. Native keeps the same UUID and payload on ambiguous retries; legacy in-flight orders retain their original endpoint/key and six-day stop. Do not migrate an ambiguous legacy operation to `/pos/orders`.
3. Clarify POS submit's additive support for existing staff promotion codes, customer IDs and delivery addresses. Current adapter rejects those conversions; existing supported workflows continue on staff routes. An unimplemented field must not silently disappear.
4. Define print-claim recovery when physical completion exceeds 60 s or TCP/AirPrint output is ambiguous; the native client will not automatically mark a socket handoff as printed.
5. Confirm payment client-ID retention/reconciliation independently of permanent order IDs. Existing native financial recovery remains bounded/manual. No terminal provider/offline authorization is inferred from `method=card` recording.
6. Provide final OpenAPI/checklist/changelog and backend `pos-flow` evidence. The pinned draft native manifest is at `contracts/pos-api-draft.json`; by-client-ID is pinned as implemented draft, with deployment/acceptance pending. Full-snapshot truncation above 300 open orders needs an explicit paging/completeness policy.

Native availability controls use the existing `POST /o/{orgId}/menu/products/{productId}/availability` with `{branchId,available}` and server refresh. This controls temporary sold-out state, not stock replenishment. Staff-only cancellation/refund/reservation/visit/customer routes stay as documented, with staff permission checks. Native logout is session-local, preserving other clients and future device pairing. Dedicated QA prerequisites and the legacy native-client staging probe are in `docs/STAGING.md`; authenticated cross-platform and physical-device acceptance remain pending.

## Shared CI observation for Claude (outside native source)

At native PR commit `05096ad`, shared CI run `40189594097` failed the restricted-runtime API suite in `apps/api/test/connect.test.ts:364`: global WhatsApp sender result expected `{retried:1,sent:0}` and returned `{retried:1,sent:3}` (916 other tests passed, 1 skipped). The browser suite separately passed all 70 cases. A job-only retry was requested to distinguish transient fixture/queue state from a persistent shared issue; no shared implementation/test/schema changes were made. See native `docs/evidence/shared-api-ci-05096ad.json`. Ownership remains with Claude; this is not a request to add an iPad endpoint.

The job-only retry (`121160347693`) completed successfully: restricted runtime 917 passed / 1 skipped; normal runtime 914 passed / 4 skipped. Shared workflow `40189594097` is now green with no shared source changes. Retain the first failure as a fixture/queue isolation follow-up for Claude; a successful rerun does not remove that intermittent test behavior.
