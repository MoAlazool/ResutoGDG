# Native backend dependency report — for Claude

Read-only compatibility check on 2026-10-24: Claude branch `fe93c1d29caa0f8d1f9844fda6976b9f1c993d74` has no differences in `apps/api`, `packages/contracts` or `docs/api/openapi.json` from the baseline. No merge was performed.

Contract baseline: `1746b4f6ee5e03bd0d9c8943b37e680eca057dce`; orders/payments contracts v2. This report proposes changes; none of the proposed routes below are called by the app. Backend ownership remains with Claude. No shared backend, migration, deployment, or infrastructure changes are included.

## Existing integration, verified from implementation

The client calls `/v1/me`, `/v1/o/{orgId}`, `menu`, `floor/{branchId}`, `floor/{branchId}/live`, `orders`, `orders/{id}`, `orders/{id}/transition`, `orders/{id}/cancel`, `orders/{id}/collect`, `payments/{paymentId}/refunds`, `visits`, `visits/{visitId}/close`, `tables/{tableId}/clean`, and `kitchen/{branchId}`. Exact methods are asserted in `scripts/check_contracts.py` against `docs/api/openapi.json`.

Auth uses Supabase `/auth/v1/token?grant_type=password`, `grant_type=refresh_token`, and `/auth/v1/logout`, not the development issuer and not MCP credentials. Tokens are bearer credentials to the same NestJS access guard used by web. `/me` memberships define restaurant, role, and allowed branches. `/o/{orgId}` returns filtered branches. The server checks membership, permissions, entitlements and branch scope again on every operation.

Staff creation accepts channel `staff` or `phone`, **not `pos`**, despite `pos` appearing in the wider channel enum. It calls `OrdersKernelService.place` inside the tenant transaction and emits `order.placed` through the transactional outbox. The resulting orders feed the same staff order read model, KDS, inventory effects and analytics. No iPad-specific authoritative ledger or order database is created. Cash collection uses the existing payment ledger. Refund requests use ResutoPay and respect its entitlement gate.

Operational changes use existing ETags and foreground polling (5 seconds in this client). KDS provides a `since` cursor, but there is no supported native push subscription. The app currently requests the full feed with ETag revalidation. Kitchen status is shown only from server responses. Creation acknowledgement means server acceptance, not proof that every asynchronous effect was processed.

## P0: atomic staff quote and conditional creation

**Missing:** `staffOrderRequest` has neither `expectedTotalMinor` nor a quote/version token. Public guest/web quoting does not authorize a staff POS to reuse guest identity or public visit tokens. Creation can reprice between menu review and submission.

**Proposed** `POST /v1/o/{orgId}/orders/quote` (`orders:write`): input `StaffOrderRequest`; output `{quoteId: UUID, expiresAt: ISO8601, currency, subtotalMinor, discountMinor, serviceChargeMinor, deliveryFeeMinor, taxMinor, taxInclusive, totalMinor, lines: [{productId, productVersion, quantity, unitPriceMinor, modifiersTotalMinor, lineTotalMinor}], branchRevision}`. Bind quote to org, branch, authenticated actor, immutable payload fingerprint and relevant pricing revisions. Extend creation with `quoteId` and `expectedTotalMinor`; consume/check transactionally and return 409 `price_changed` with a new quote when stale. Never accept client tax arithmetic.

Contract acceptance: price/modifier/promotion/tax/availability change after quote must either preserve a valid promised quote by explicit business policy or reject before any order, inventory decrement, KDS event or payment effect. Cross-tenant, cross-branch, expired and other-actor quote reuse must fail. Simultaneous same-key creation must emit one business effect.

**Client behavior now:** item estimates are labelled estimates; local orders require fresh-menu review; server totals are shown after acceptance. Full price-consent guarantees remain blocked. Do not market offline draft capture as offline committed ordering.

## P0: durable operation reconciliation and bounded deduplication

Existing idempotency rows expire after seven days. Native retries use the original key and immutable payload; replay stops before that horizon. A replacement key could duplicate an already accepted order after an ambiguous result.

**Proposed** `GET /v1/o/{orgId}/operations/{clientOperationId}` (`orders:read`, actor/branch scoped): `{state: "unknown"|"processing"|"accepted"|"rejected", orderId?:UUID, payloadHash?:string, acceptedAt?:ISO8601, failure?:{code,details}}`. Persist a unique `(org_id, client_operation_id)` association on the authoritative order independently of short-lived HTTP replay rows. Creation accepts the same `clientOperationId`; immutable payload mismatch is 409. Unknown must not imply safe creation until retention/uniqueness semantics are explicit.

Acceptance: lost response + restart + retry after 8/30 days cannot create a second order or kitchen ticket; another org/actor cannot enumerate operation state. Client currently marks expired/semantic rejection as attention and never automatically assigns a new operation ID.

## P0: device authorization and remote revocation

No native device registration/attestation/PIN staff-switch contract is present. Do not simulate registration with local UUIDs.

**Proposed** owner/manager enrollment challenge → `POST /v1/o/{orgId}/pos/devices/enroll` with `{challenge, publicKey, displayName, branchId, attestation?}` → `{deviceId, status, policy:{offlineDraftTTLSeconds, allowedBranchIds}, credentialExpiry}`. Add list/revoke endpoints with `members:manage` or a dedicated permission. Device credential supplements user authentication; it must not replace employee permissions. Validate App Attest server-side where adopted. Log enrollment, reassignment, sensitive actions and revocation without raw keys. Native offline unlock policy must define lease expiry and device/user revocation exposure.

Current UI explicitly labels enrollment unavailable. Staff switch is full sign-out/sign-in. Reopening an app after termination needs an online identity validation; ongoing authenticated sessions may capture drafts offline for at most eight hours after last successful refresh. Cached data alone never establishes membership.

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
