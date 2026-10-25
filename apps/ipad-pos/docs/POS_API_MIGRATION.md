# POS API compatibility implementation

Reviewed Claude `1a0544314d7596dd6b08bb2071755f2e1815195e`, including `docs/api/IPAD_INTEGRATION.md`, `IPAD_COMPATIBILITY.md`, `packages/contracts/src/pos.ts` and API implementations. At that revision **0.1.0 is draft; 0.2.0 staff-on-device and by-client-ID lookup are proposed/in progress**. Nothing is staging stable. Review date: 2026-10-25 Cairo; evidence timestamps use UTC.

## Current routing and migration gate

The working SwiftUI application continues using Supabase staff routes, its original encrypted stores, KDS polling and cash ledger. No existing draft or ambiguous order is automatically migrated. No pairing exchange, device mutation, POS order, POS payment or print-job claim has been executed against staging here.

The new portable adapters compile in the native app/package and have synthetic contract tests. They are **not activated by the app**. This follows Claude's step 1 gate: merge/deploy 0.2.0 first; then pair and compare read-only shadows for a full service day; only after actual native staging lifecycle acceptance switch writes. A 0.1.0 response is deliberately rejected for staff-on-device use. Do not enable device-only impersonation to work around missing 0.2.0.

## Implemented adapters

| Component | Behavior | Verification |
|---|---|---|
| `DeviceCredentialStore` | Separate `paired-device` Keychain record via existing SecretStore; validates token format, org, branch, active device, `requireStaff=true`, contract 0.2.0 | Synthetic tests; real pairing pending |
| `POSClient` | Device bearer only on `/v1/pos/*`; staff JWT only in `X-Resuto-Staff-Authorization`; public code exchange sends neither old credential; GET-only refresh; mutation identity never replaced | Header, route escape, refresh, denied staff, revocation and sign-out tests |
| `POSSession` | Validates staff identity/role, restaurant/branch and device context; UI hint intersects staff role, device role and server permissions | Manager-on-kitchen/host/cross-tenant/branch and 0.1.0 negative tests |
| `POSEventJournal` | Durable scope/device-specific epoch/sequence; ordered dedupe; unknown kinds advance safely; gaps/reset/ahead refuse; refresh completes before cursor persists | Restart, duplicates, gap, epoch, disk/projection failures and isolation tests |
| `POSShadowSync` | Read-only session/menu/floor/order synchronization, delta merge and closed-order removal; resync uses watermark captured before snapshots; lost projection forces full snapshot; detects stalled pagination, marks truncated full lists and periodically revalidates signed image URL cursors even without events | Synthetic web/KDS/payment invalidation and projection-loss tests; staging comparison pending |
| `POSSubmitBody` / `CompatibleOrderSubmitter` | Exact reviewed server quote totals/line consent, `repricing=reject`, original draft UUID as permanent clientOrderId; reconcile lost results via proposed 0.2.0 lookup; never auto-fall back after a device attempt | Quote/structured conflict/idempotency/reconciliation tests; live writes disabled |
| Existing `OrderQueue` extension | Only explicit quote approval selects POS for a never-sent local draft; legacy operations keep six-day bound; POS-quoted operations retain permanent ID after long outage; rollback fails closed; known non-committing POS conflicts may be re-reviewed with same ID | Persistence/30-day replay and endpoint-family preservation tests |

Revoked/expired device credentials are deleted without clearing the staff session. Staff logout preserves pairing. A valid staff user denied on this device never falls back to device-only requests. Re-pairing to another branch cannot expose the previous branch's checkpoints or queued orders.

`APIError.details` preserves reviewed structured price/unavailability/resync information. `FailurePresentation` selects bilingual recovery keys and separate support references without rendering arbitrary backend messages. Error codes select behavior. Existing staff error mapping remains compatible.

## Preserved limitations

- Pairing UI activation and foreground shadow-loop wiring await merged/deployed 0.2.0 and approved QA identities. The adapters are not a claim that the current app already runs on paired-device routes.
- The existing staff request supports promotion codes, customer IDs and delivery addresses; the draft POS submit schema does not. The POS mapper **rejects** these inputs rather than dropping data. These workflows keep staff routes until Claude publishes additive fields or a deliberate product policy. Do not convert an already attempted order to a different route or UUID.
- Shadow mode never records payments, prints or mutates operational records. Its caches are disposable projections of existing platform data, not a new source of truth. Supply the existing `EncryptedStore` for both snapshot and journal when wiring the app.
- POS payment/receipt/kitchen write migration is not wired. Existing manual cash/refund and local print recovery retain their safe behavior. POS card recording alone is not terminal authorization. Keep the existing bounded financial replay policy until payment retention/reconciliation is explicitly agreed.
- Shared print-job claim expiry is 60 s; AirPrint/TCP handoff is not proof of paper output. Before activating shared jobs, agree claim renewal/recovery or operator confirmation for ambiguous physical output. Never automatically complete a job as printed after socket completion.
- Unsupported staff order amendments, table transfers/merge and staff bill splits remain backend dependencies. Key-bound enrollment/App Attest and credential rotation remain owner/backend decisions.
- Full order snapshots can be truncated at 300. Shadow state records this flag; it must be surfaced and a scalable backend paging contract agreed before calling a larger service's open-order view complete.

## Contract checks and next activation steps

`contracts/pos-api-draft.json` pins the reviewed branch's actual POS routes, source revision and OpenAPI digest. `scripts/check_pos_contracts.py` reports draft review separately from existing staff-contract checks. The 0.2.0 `by-client-id` lookup is explicitly tagged proposed; it is not claimed present in base OpenAPI. `POSCompatibilityTests.swift` uses synthetic proposed-0.2.0 objects, never staging captures.

After Claude merges 0.2.0: re-read final schemas/errors and guard implementation; refresh this pin; verify `requireStaff` and staff attribution on deployed staging; add normal code-entry pairing UI and context binding; run `POSShadowSync.poll` in a cancellable foreground loop using encrypted scope/device stores; compare against staff/web read models. Preserve drafts during full resync and retain last applied cursor only after projection writes. Then enable quote review, durable device orders and reconciliation on explicitly approved new drafts. Run the complete native/web/KDS/payment/inventory/analytics checklist before switching defaults or marking contracts stable.
