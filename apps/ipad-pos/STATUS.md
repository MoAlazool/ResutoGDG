# Native iPad POS delivery status

**Not production ready.** Contract baseline `1746b4f6ee5e03bd0d9c8943b37e680eca057dce`. Source branch `feature/ipad-pos`; PR base must be `feature/ipad-pos`.

Legend: Implemented = functional source exists; Tested = executed automated evidence; Staging = actual authorized deployed workflow; Device = actual physical verification. “No” is not an inferred pass.

| Area | Implemented | Tested | Verified on Staging | Verified on Real Device | Blocked / remaining |
|---|---|---|---|---|---|
| Swift portable core | Yes | 107 XCTest tests pass on Swift 6.0.3 Linux | No | No | Apple build tracked separately |
| Native SwiftUI app/project | Yes | Xcode 16.4 Debug/Release builds + 13/14 UI at `fc6f583`; current run pending | No | No | Authenticated screens and physical-device acceptance remain |
| Supabase auth/refresh/Keychain | Yes | Core transport/refresh/session-local logout tests | No | No | Dedicated QA staff account; real-device Keychain checks |
| Restaurant/branch/role scoping | Yes | Core permission and queue isolation tests | Unauthenticated access rejects 401 | No | Authenticated cross-tenant/branch negative cases |
| Menu, images, search, category, modifiers | Yes | Core constraints/fixtures | No | No | 1000-product/60-line core benchmark passes; real catalogue/device acceptance pending |
| Temporary product availability | Yes; permission-gated, online, server-refreshed | Synthetic reversible availability scenario passes at `fc6f583` | No | No | Web/native availability and inventory agreement |
| Cart edits, quantities, notes, promotion | Yes | Core validation | No | No | POS quote/price-consent adapter exists; app write cutover awaits staging gates |
| Pickup/dine-in order creation | Yes, explicit online approval | Retry/persistence/conflict tests | No | No | Verify same order in dashboard/KDS/stock/analytics |
| Floor selection, seat/close/clean | Yes | DTO fixture only | No | No | Interaction/occupancy/reservation acceptance |
| Orders/status/cancel/history | Yes | Lifecycle/decoding tests | No | No | Multi-client version conflict and full history tests |
| KDS read/status via shared orders | Yes, 5 s foreground polling | DTO/client logic only | No | No | POS event shadows implemented; actual multi-client KDS convergence pending |
| Online cash and partial/equal amount | Yes | Core tests and synthetic cash/same-key recovery UI pass at `fc6f583` | No | No | Ledger allocation/ambiguous-response staging acceptance |
| Refund request + manual same-key recovery | Yes | Synthetic manual-required refund UI scenario added; native CI pending | No | No | Provider/manual completion verification; web completes physical manual refund |
| Encrypted offline draft/cache/outbox | Yes | Core restart/retry/isolation tests; force-close original order reconciliation passes; cart rerun pending | No | No | AES-GCM/Keychain/force-close/reboot actual iPad checks |
| AirPrint and LAN raster adapter | Yes, experimental LAN path | Core print-queue tests | N/A | No | Model certification, paper/status/reconnect/Arabic tests |
| Arabic/English, RTL, Western digits | Yes, central catalogue | Money tests, key-parity check; Arabic launch assertions in UI suite | No | No | Full bilingual visual/accessibility audit and server-error translations |
| Xcode/macOS Actions workflow | Yes | Debug/Release + 13/14 UI at `fc6f583`; current run pending | N/A | N/A | See `docs/evidence/native-ci-be5a528.json` and latest PR checks |
| Paired device / staff permission intersection | Pairing Settings + read-only shadow integration | Synthetic dual-credential/revocation/intersection tests pass | No | No | 0.2.0 staging deployment, real pairing + full service-day shadow acceptance |
| Native delivery entry/customer lookup/reservations workspace | Yes: delivery addresses, customer lookup/selection, daily reservations/check-in | No | No | No | Customer/reservation workflow acceptance and reservation creation/editing UI remain |
| Existing order line amendments/table move/merge | No | No | No | No | Shared backend contracts missing |
| Item/customer bill split | No | No | No | No | Staff split API missing; public guest authority not reused |
| External terminal payment/offline authorization | No | No | No | No | Provider selection, supported SDK/contracts, credentials and hardware |
| Vendor printer SDK/cash drawer | No | No | N/A | No | Selected exact hardware, licenses, SDK integration and testing |
| Fiscal invoice/regulatory receipt | No; operational order summary only | No | No | No | Fiscal contract/certification |
| Signing/TestFlight/App Store | No | No | N/A | No | Apple Developer team, artwork, privacy review and release acceptance |

Read-only staging health and unauthenticated security probes passed on 2026-10-24, including the native Swift URLSession probe. GitHub, Supabase, Render and Vercel connectors are callable and were inspected read-only. Public staging Supabase configuration is verified. No approved staff credentials/dedicated QA restaurant were found; see `docs/STAGING.md` for exact setup and the guarded authenticated lifecycle probe. Its write path has not been run.

New simulator-only contract scenarios cover sign-in/branch selection, ordering/KDS/status/cash/receipt queue, Arabic rotation, encrypted cart relaunch, sold-out controls, dine-in, role denial, EN/AR accessibility descriptions, and lost order/cash responses. They exercise real Keychain/AES adapters with synthetic transport and visible NOT-STAGING labels. Latest-head 18-case macOS workflow results are pending; no authenticated staging or physical-device claim follows from fixtures.

See `API_DEPENDENCIES.md`, `docs/VERIFICATION.md`, `docs/SECURITY.md`, `docs/HARDWARE.md`, `docs/RELEASE.md`. Do not describe the complete product mission as finished based on these source files or a simulator build alone.

## POS API 0.2.0 preparation

Claude source `69ec75e` implements draft POS 0.2.0, including staff-on-device and permanent by-client-ID lookup. New native compatibility code covers separate device/staff credentials, context/permission intersection, typed POS DTOs, permanent-ID quote approval/reconciliation, a durable ordered event journal and read-only shadow snapshots. **Pairing and read-only shadow synchronization are wired in Settings; device order/payment cutover remains gated.** Existing staff flows and encrypted queues remain intact; no automatic migration of previously attempted orders. 107 core tests pass locally; current Xcode CI must pass at the new adapter revision. See `docs/POS_API_MIGRATION.md` for implemented versus pending wiring and final backend gates.

Additional independent hardening: approved staging-origin validation before credentials leave the app; periodic signed-image cursor refresh without a menu event; Arabic decimal separator handling; branch-local business dates; localized errors/roles/kitchen times/order search; duplicate-localization-key crash prevention; receipt language isolation and explicit non-fiscal/test labels. Portable core Debug/Release and synthetic-transport checks pass locally. Latest Apple build/UI results must be recorded against the exact source revision.

## Latest continuation

Run [40148561355](https://github.com/MoAlazool/ResutoGDG/actions/runs/40148561355) at `fc6f583` passed 91 core tests and Debug/Release builds, with **13/14 UI cases passing**. The restored-cart assertion ran before branch loading released busy state; it now waits for the enabled control. The next run adds a 15th synthetic UI case for staff-on-device pairing, shadow snapshots and local forgetting without staff logout. Latest-head Apple verification is pending until that run completes. Local core tests now cover 107 cases. No authenticated staging or physical-device acceptance is inferred.

Additional independent work: the floor has a native table-list alternative, automatically selected at accessibility Dynamic Type sizes, with localized occupancy/capacity and actionable table descriptions. Two new synthetic UI scenarios cover list-based dine-in selection and Arabic accessibility text (18 scenarios total; latest Apple result pending). Permission access now uses a scoped eight-hour identity lease rather than Wi-Fi reachability, with wall/monotonic expiry and rollback/isolation tests. Reconciliation tests reject mismatched order numbers and currencies without claiming acceptance. No staging/device result is implied.

Latest completed Apple run: [40150009851](https://github.com/MoAlazool/ResutoGDG/actions/runs/40150009851) at `812439b` passed 96 core tests, Debug/Release builds and **14/15 UI tests**, including staff/device pairing, shadow projection and local forgetting, plus the corrected cart relaunch. The remaining order/Settings failure exposed a background response reopening a dismissed detail sheet. The follow-up checks the current selection and order version before applying refresh, invalidates in-flight cache reads across scope changes, and waits for toolbar interactability. A rerun of all 18 UI scenarios is required. No authenticated staging or physical-device verification is claimed.

Follow-up source review found initial workspace selection depended on a permission lease still loading during branch entry. Initial navigation now uses membership hints; operational actions keep the scoped lease and server guard. Mutation completion/failure invalidates older in-flight reads, and an unrelated uncached identity response no longer discards menu ETags. Two deterministic networking tests cover those cache cases (107 portable tests total). The d8c07ce CI run was superseded during UI execution; its 105 core tests and Release build passed, but its full 18-case UI result is not a pass. The corrected revision requires a complete native rerun.
