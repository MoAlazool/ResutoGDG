# Native iPad POS delivery status

**Not production ready.** Contract baseline `1746b4f6ee5e03bd0d9c8943b37e680eca057dce`. Source branch `feature/ipad-pos`; PR base must be `feature/ipad-pos`.

Legend: Implemented = functional source exists; Tested = executed automated evidence; Staging = actual authorized deployed workflow; Device = actual physical verification. “No” is not an inferred pass.

| Area | Implemented | Tested | Verified on Staging | Verified on Real Device | Blocked / remaining |
|---|---|---|---|---|---|
| Swift portable core | Yes | 84 XCTest tests pass on Swift 6.0.3 Linux | No | No | Apple build tracked separately |
| Native SwiftUI app/project | Yes | Xcode 16.4 + 46 core/4 UI passed at `481c191`; expanded workflow CI pending | No | No | Authenticated screens and physical-device acceptance remain |
| Supabase auth/refresh/Keychain | Yes | Core transport/refresh/session-local logout tests | No | No | Dedicated QA staff account; real-device Keychain checks |
| Restaurant/branch/role scoping | Yes | Core permission and queue isolation tests | Unauthenticated access rejects 401 | No | Authenticated cross-tenant/branch negative cases |
| Menu, images, search, category, modifiers | Yes | Core constraints/fixtures | No | No | 1000-product/60-line core benchmark passes; real catalogue/device acceptance pending |
| Temporary product availability | Yes; permission-gated, online, server-refreshed | New deterministic UI scenario pending | No | No | Web/native availability and inventory agreement |
| Cart edits, quantities, notes, promotion | Yes | Core validation | No | No | Server quote/price-consent contract missing |
| Pickup/dine-in order creation | Yes, explicit online approval | Retry/persistence/conflict tests | No | No | Verify same order in dashboard/KDS/stock/analytics |
| Floor selection, seat/close/clean | Yes | DTO fixture only | No | No | Interaction/occupancy/reservation acceptance |
| Orders/status/cancel/history | Yes | Lifecycle/decoding tests | No | No | Multi-client version conflict and full history tests |
| KDS read/status via shared orders | Yes, 5 s foreground polling | DTO/client logic only | No | No | Native event stream absent; line-level preparation/ready controls implemented |
| Online cash and partial/equal amount | Yes | Network/amount tests; new deterministic UI scenarios pending | No | No | Ledger allocation/ambiguous-response staging acceptance |
| Refund request + manual same-key recovery | Yes | No dedicated refund integration test yet | No | No | Provider/manual completion verification; web completes physical manual refund |
| Encrypted offline draft/cache/outbox | Yes | Core restart/retry/isolation/clock-rollback tests; encrypted UI relaunch/recovery scenarios pending | No | No | AES-GCM/Keychain/force-close/reboot actual iPad checks |
| AirPrint and LAN raster adapter | Yes, experimental LAN path | Core print-queue tests | N/A | No | Model certification, paper/status/reconnect/Arabic tests |
| Arabic/English, RTL, Western digits | Yes, central catalogue | Money tests, key-parity check; Arabic launch assertions in UI suite | No | No | Full bilingual visual/accessibility audit and server-error translations |
| Xcode/macOS Actions workflow | Prepared | Run 40128063055 passed at `481c191`; expanded scenarios/signing fix pending | N/A | N/A | See `docs/evidence/native-ci-be5a528.json` and latest PR checks |
| Paired device / staff permission intersection | Core compatibility adapters; app activation pending | Synthetic dual-credential/revocation/intersection tests pass | No | No | 0.2.0 merge/deployment, pairing UI + shadow acceptance |
| Native delivery entry/customer lookup/reservations workspace | Yes: delivery addresses, customer lookup/selection, daily reservations/check-in | No | No | No | Customer/reservation workflow acceptance and reservation creation/editing UI remain |
| Existing order line amendments/table move/merge | No | No | No | No | Shared backend contracts missing |
| Item/customer bill split | No | No | No | No | Staff split API missing; public guest authority not reused |
| External terminal payment/offline authorization | No | No | No | No | Provider selection, supported SDK/contracts, credentials and hardware |
| Vendor printer SDK/cash drawer | No | No | N/A | No | Selected exact hardware, licenses, SDK integration and testing |
| Fiscal invoice/regulatory receipt | No; operational order summary only | No | No | No | Fiscal contract/certification |
| Signing/TestFlight/App Store | No | No | N/A | No | Apple Developer team, artwork, privacy review and release acceptance |

Read-only staging health and unauthenticated security probes passed on 2026-10-24, including the native Swift URLSession probe. GitHub, Supabase, Render and Vercel connectors are callable and were inspected read-only. Public staging Supabase configuration is verified. No approved staff credentials/dedicated QA restaurant were found; see `docs/STAGING.md` for exact setup and the guarded authenticated lifecycle probe. Its write path has not been run.

New simulator-only contract scenarios cover sign-in/branch selection, ordering/KDS/status/cash/receipt queue, Arabic rotation, encrypted cart relaunch, sold-out controls, dine-in, role denial, EN/AR accessibility descriptions, and lost order/cash responses. They exercise real Keychain/AES adapters with synthetic transport and visible NOT-STAGING labels. Expanded macOS workflow results are pending; no authenticated staging or physical-device claim follows from fixtures.

See `API_DEPENDENCIES.md`, `docs/VERIFICATION.md`, `docs/SECURITY.md`, `docs/HARDWARE.md`, `docs/RELEASE.md`. Do not describe the complete product mission as finished based on these source files or a simulator build alone.

## POS API 0.2.0 preparation

Claude source `1a05443` has draft 0.1.0 and a proposed/in-progress 0.2.0 integration path. New native compatibility code covers separate device/staff credentials, context/permission intersection, typed POS DTOs, permanent-ID quote approval/reconciliation, a durable ordered event journal and read-only shadow snapshots. **Not activated in live SwiftUI routing.** Existing staff flows and encrypted queues remain intact; no automatic migration of previously attempted orders. 84 core tests pass locally; current Xcode CI must pass at the new adapter revision. See `docs/POS_API_MIGRATION.md` for implemented versus pending wiring and final backend gates.
