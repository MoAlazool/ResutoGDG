# Native verification scope

All simulator workflows use the explicit DEBUG-only synthetic transport and visible NOT-STAGING banner. They exercise real SwiftUI, Keychain and encrypted files. They do not establish deployed API, web/KDS, provider or physical-device acceptance. The exact run/commit/result belongs in `VERIFICATION.md` and the evidence JSON; the table below describes assertions, not a production certification.

Latest complete native execution: run **40210274577**, source **`42263eb`**, **107 core + 21/21 simulator UI tests passed**. Final Arabic direction/copy fixes and frame-position assertions passed; all 19 full native frames were inspected. Staging/device/visual limitations below remain.

## Simulator scenarios (21)

| Workflow | Assertions |
|---|---|
| Authentication launch | Signed-out launch requires staff sign-in; credential fields are not prefilled |
| Arabic launch and rotation | Arabic welcome text and rotation survive launch |
| Welcome screenshot | Signed-out screenshot artifact, with no supplied staff credentials |
| Launch performance | Simulator launch samples; not the real-device acceptance target |
| Order → kitchen → cash → receipt queue | Same synthetic server order, status transition, confirmed paid state and queued operational receipt |
| Refund request | `manual_required` remains visible; request acceptance does not reverse paid state or claim settlement |
| Arabic order entry | Arabic item/modifier text and portrait cart access |
| Cart relaunch | Encrypted cart survives termination and is not silently submitted |
| Availability | Server-refreshed sold-out and restore controls change product availability |
| Floor list | List-based table selection preserves dine-in context |
| Arabic accessibility text | Accessibility-size text uses actionable table list instead of scaled map labels |
| Dine-in | Table context is sent with the order |
| English/Arabic descriptions | Core controls expose human-readable accessibility labels |
| Lost order response | Original operation key is reconciled without a replacement order |
| Force-close after ambiguous order | Persisted synthetic server retains its original generated order ID; real client files reconcile after relaunch |
| Lost cash response | Explicit recovery uses the same persisted key/amount and confirms server state |
| Paired staff session | Dual credentials, read-only shadow snapshots and local device forgetting preserve staff sign-in |
| Host restrictions | POS, KDS and financial controls are unavailable to the host role |
| Accessibility-size compact cart | Portrait order bar opens cart sheet; explicit server-review action remains reachable and confirmation enabled |
| Native English visual flow | Full simulator frames for sign-in, workspace, menu, modifiers, cart/review, orders, cash unpaid/paid states, kitchen, floor, local recovery and device settings; synthetic server only |
| Native Arabic visual flow | Full Arabic sign-in/workspace/order-entry captures; follow-up adds sheet cancellation/recap position assertions, recognized allergen localization and Western money digits |

## Portable core (107 tests)

Includes reviewed staff/POS DTOs, authentication refresh/logout races, credential separation/revocation, staff/device permission intersection, scope isolation, leases and clock expiry, cart/modifier arithmetic, durable queues and replay windows, quote consent, permanent-ID reconciliation, event gaps/epoch/deduplication, durable projection checkpoints, permission narrowing, signed-image refresh, ETag/late-read races, print ambiguity, localized errors, Western digits and CPU benchmarks. Transport fixtures and negative tests are not a deployed authorization audit.

## Remaining verification and implementation

- **Authenticated staging:** dedicated restaurant/staff identities, POS 0.2.0 deployment, full service-day read-only shadow comparison, native order → real Web Orders → KDS → status → payment/inventory/analytics lifecycle, tenant/branch/role denial and revoked sessions/devices.
- **Additional application workflows:** customer search/selection, delivery entry, reservation check-in, floor seat/close/clean, cancellation, full history pagination, kitchen line controls and staff switching need dedicated native UI coverage and staging acceptance. Reservation creation/editing remains native implementation work.
- **Accessibility:** full-screen clipping/contrast audit, VoiceOver, keyboard/Switch Control, multitasking, reduced motion and real-device large-text checks remain. A readable label or one accessibility-size scenario does not verify them all.
- **Offline/device:** cold-start offline access follows the documented online identity requirement; no local PIN policy is invented. Real iPad reboot/locked-storage, crash/reconnect, 100 injected duplicate scenarios, memory and response-time acceptance remain.
- **Hardware/financial release:** selected printer/drawer certification, provider terminal authorization, fiscal receipts and Apple signing/privacy/release prerequisites remain separate gates.
