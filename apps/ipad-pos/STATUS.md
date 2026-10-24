# Native iPad POS delivery status

**Not production ready.** Contract baseline `1746b4f6ee5e03bd0d9c8943b37e680eca057dce`. Source branch `feature/ipad-pos`; PR base must be `feature/ipad-pos`.

Legend: Implemented = functional source exists; Tested = executed automated evidence; Staging = actual authorized deployed workflow; Device = actual physical verification. “No” is not an inferred pass.

| Area | Implemented | Tested | Verified on Staging | Verified on Real Device | Blocked / remaining |
|---|---|---|---|---|---|
| Swift portable core | Yes | 42 XCTest tests pass on Swift 6.0.3 Linux | No | No | Apple build tracked separately |
| Native SwiftUI app/project | Yes | Syntax parsed; macOS CI pending | No | No | Xcode/simulator evidence required |
| Supabase auth/refresh/Keychain | Yes | Core transport/refresh tests | No | No | Authorized staff account/project config; Keychain device checks |
| Restaurant/branch/role scoping | Yes | Core permission and queue isolation tests | Unauthenticated access rejects 401 | No | Authenticated cross-tenant/branch negative cases |
| Menu, images, search, category, modifiers | Yes | Core constraints/fixtures | No | No | Layout, 1000-product performance, real catalogue acceptance |
| Cart edits, quantities, notes, promotion | Yes | Core validation | No | No | Server quote/price-consent contract missing |
| Pickup/dine-in order creation | Yes, explicit online approval | Retry/persistence/conflict tests | No | No | Verify same order in dashboard/KDS/stock/analytics |
| Floor selection, seat/close/clean | Yes | DTO fixture only | No | No | Interaction/occupancy/reservation acceptance |
| Orders/status/cancel/history | Yes | Lifecycle/decoding tests | No | No | Multi-client version conflict and full history tests |
| KDS read/status via shared orders | Yes, 5 s foreground polling | DTO/client logic only | No | No | Native event stream absent; line-level preparation/ready controls implemented |
| Online cash and partial/equal amount | Yes | Network/amount tests; app orchestration untested | No | No | Ledger allocation/ambiguous-response staging acceptance |
| Refund request + manual same-key recovery | Yes | No dedicated refund integration test yet | No | No | Provider/manual completion verification; web completes physical manual refund |
| Encrypted offline draft/cache/outbox | Yes | Core restart/retry/isolation tests | No | No | AES-GCM/Keychain/force-close/reboot actual iPad checks |
| AirPrint and LAN raster adapter | Yes, experimental LAN path | Core print-queue tests | N/A | No | Model certification, paper/status/reconnect/Arabic tests |
| Arabic/English, RTL, Western digits | Yes, central catalogue | Money tests; Arabic launch test prepared | No | No | Full bilingual visual/accessibility audit and server-error translations |
| Xcode/macOS Actions workflow | Prepared | First run passed core; native compile failed on ambiguous ShapeStyle, fixed; rerun pending | N/A | N/A | Actual Actions run result required |
| Device enrollment/remote revoke | No | No | No | No | Backend contract missing |
| Native delivery entry/customer lookup/reservations workspace | Yes: delivery addresses, customer lookup/selection, daily reservations/check-in | No | No | No | Customer/reservation workflow acceptance and reservation creation/editing UI remain |
| Existing order line amendments/table move/merge | No | No | No | No | Shared backend contracts missing |
| Item/customer bill split | No | No | No | No | Staff split API missing; public guest authority not reused |
| External terminal payment/offline authorization | No | No | No | No | Provider selection, supported SDK/contracts, credentials and hardware |
| Vendor printer SDK/cash drawer | No | No | N/A | No | Selected exact hardware, licenses, SDK integration and testing |
| Fiscal invoice/regulatory receipt | No; operational order summary only | No | No | No | Fiscal contract/certification |
| Signing/TestFlight/App Store | No | No | N/A | No | Apple Developer team, artwork, privacy review and release acceptance |

Read-only staging health and unauthenticated security probes passed on 2026-10-24. This is not authenticated integration verification. Provider tools: GitHub callable and verified; Supabase/Render/Vercel discovered installed but callable service tools unavailable in this session.

See `API_DEPENDENCIES.md`, `docs/VERIFICATION.md`, `docs/SECURITY.md`, `docs/HARDWARE.md`, `docs/RELEASE.md`. Do not describe the complete product mission as finished based on these source files or a simulator build alone.
