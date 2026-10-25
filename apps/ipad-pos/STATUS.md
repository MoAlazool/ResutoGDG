# Native iPad POS delivery status

**Not production ready.** Contract baseline `1746b4f6ee5e03bd0d9c8943b37e680eca057dce`. Source branch `feature/ipad-pos`; PR base must be `feature/ipad-pos`.

## Current native UX refinement

Fresh native screenshot audit and implemented SwiftUI refinements are documented in [`docs/UX_REVIEW.md`](docs/UX_REVIEW.md). Ordering now uses a compact sidebar, adaptive catalogue/cart, explicit modifier requirements, clear send-versus-save actions and a fuller submission recap. Checkout, kitchen, floor, sync and device state hierarchy are also refined. Local core tests (107), localization parity, route contracts and simulator-transport checks pass. **The major UX changes and final RTL/copy follow-ups passed Xcode and all 21 UI tests at `42263eb`; the 19 final frames were inspected.**

Latest completed native run: [40210274577](https://github.com/MoAlazool/ResutoGDG/actions/runs/40210274577) at `42263eb48c343d8894d1e847beebfce878850b54` is **green: 107 core tests, all 21 simulator UI tests, Debug and Release builds**, Xcode 16.4 / Swift 6.1.2. All 19 full native captures were inspected, including the corrected Arabic sheets. These synthetic workflows exercise real Keychain/encrypted client files; they do not verify authenticated staging or physical devices. [Before/after gallery](docs/UX_GALLERY.md); [coverage map](docs/TEST_MATRIX.md).

Legend: Implemented = functional source exists; Tested = executed automated evidence; Staging = actual authorized deployed workflow; Device = actual physical verification. “No” is not an inferred pass.

| Area | Implemented | Tested | Verified on Staging | Verified on Real Device | Blocked / remaining |
|---|---|---|---|---|---|
| Swift portable core | Yes | 107 XCTest tests pass on Swift 6.0.3 Linux | No | No | Apple build tracked separately |
| Native SwiftUI app/project | Yes | Xcode 16.4 Debug/Release + 21/21 UI at `42263eb` | No | No | Authenticated staging, full visual/accessibility and physical acceptance remain |
| Supabase auth/refresh/Keychain | Yes | Core refresh/logout and synthetic sign-in UI with real Keychain pass | No | No | Dedicated QA staff account; real-device Keychain checks |
| Restaurant/branch/role scoping | Yes | Core permission and queue isolation tests | No | No | Public unauthenticated 401 only; authenticated cross-tenant/branch negatives pending |
| Menu, images, search, category, modifiers | Yes | Core constraints/fixtures | No | No | 1000-product/60-line core benchmark passes; real catalogue/device acceptance pending |
| Temporary product availability | Yes; permission-gated, online, server-refreshed | Synthetic reversible availability scenario passes at `05096ad` | No | No | Web/native availability and inventory agreement |
| Cart edits, quantities, notes, promotion | Yes | Core validation | No | No | POS quote/price-consent adapter exists; app write cutover awaits staging gates |
| Pickup/dine-in order creation | Yes, explicit online approval | Retry/persistence/conflict tests | No | No | Verify same order in dashboard/KDS/stock/analytics |
| Floor selection, seat/close/clean | Yes; accessible list added | Map/list dine-in and Arabic accessibility-size selection pass; seat/close/clean UI not covered | No | No | Actual occupancy/reservation agreement and remaining workflow coverage |
| Orders/status/cancel/history | Yes | Lifecycle/decoding + active-order status UI pass; cancellation/history coverage remains | No | No | Multi-client version conflict and full history tests |
| KDS read/status via shared orders | Yes, 5 s foreground polling | Synthetic shared-order status workflow passes | No | No | Actual multi-client convergence and kitchen-line UI coverage |
| Online cash and partial/equal amount | Yes | Core tests and synthetic cash/same-key recovery UI pass at `05096ad` | No | No | Ledger allocation/ambiguous-response staging acceptance |
| Refund request + manual same-key recovery | Yes | Synthetic manual-required refund UI passes; not provider settlement | No | No | Provider/manual completion and lost-refund-response acceptance |
| Encrypted offline draft/cache/outbox | Yes | Core restart/isolation/lease tests; cart and ambiguous-order force-close UI pass | No | No | Reboot/locked-storage and real reconnect/crash acceptance |
| AirPrint and LAN raster adapter | Yes, experimental LAN path | Core print-queue tests | N/A | No | Model certification, paper/status/reconnect/Arabic tests |
| Arabic/English, RTL, Western digits | Yes | Core/parity + Arabic entry/rotation/labels/accessibility-size floor UI pass | No | No | Full visual/contrast/VoiceOver audit; VoiceOver, dark appearance and complete real-device acceptance |
| Xcode/macOS Actions workflow | Yes | Run 40210274577 green at `42263eb` | N/A | N/A | Signing/distribution and actual device validation remain separate |
| Paired device / staff permission intersection | Pairing Settings + read-only event shadows; write adapter gated | Core dual-credential/context/revocation tests + pairing/shadow/forget UI pass | No | No | POS 0.2.0 deployment, actual pairing and full service-day shadow acceptance |
| Native delivery entry/customer lookup/reservations workspace | Yes: delivery addresses, customer lookup/selection, daily reservations/check-in | No | No | No | Customer/reservation workflow acceptance and reservation creation/editing UI remain |
| Existing order line amendments/table move/merge | No | No | No | No | Shared backend contracts missing |
| Item/customer bill split | No | No | No | No | Staff split API missing; public guest authority not reused |
| External terminal payment/offline authorization | No | No | No | No | Provider selection, supported SDK/contracts, credentials and hardware |
| Vendor printer SDK/cash drawer | No | No | N/A | No | Selected exact hardware, licenses, SDK integration and testing |
| Fiscal invoice/regulatory receipt | No; operational order summary only | No | No | No | Fiscal contract/certification |
| Signing/TestFlight/App Store | No | No | N/A | No | Apple Developer team, artwork, privacy review and release acceptance |

Read-only staging health and unauthenticated security probes passed on 2026-10-24, including the native Swift URLSession probe. GitHub, Supabase, Render and Vercel connectors are callable and were inspected read-only. Public staging Supabase configuration is verified. No approved staff credentials/dedicated QA restaurant were found; see `docs/STAGING.md` for exact setup and the guarded authenticated lifecycle probe. Its write path has not been run.

New simulator-only contract scenarios cover sign-in/branch selection, ordering/KDS/status/cash/receipt queue, Arabic rotation, encrypted cart relaunch, sold-out controls, dine-in, role denial, EN/AR accessibility descriptions, and lost order/cash responses. They exercise real Keychain/AES adapters with synthetic transport and visible NOT-STAGING labels. All 21 scenarios pass at `42263eb`; no authenticated staging or physical-device claim follows from fixtures.

See `API_DEPENDENCIES.md`, `docs/VERIFICATION.md`, `docs/SECURITY.md`, `docs/HARDWARE.md`, `docs/RELEASE.md`. Do not describe the complete product mission as finished based on these source files or a simulator build alone.

## POS API 0.2.0 preparation

Claude source `69ec75e` implements draft POS 0.2.0, including staff-on-device and permanent by-client-ID lookup. New native compatibility code covers separate device/staff credentials, context/permission intersection, typed POS DTOs, permanent-ID quote approval/reconciliation, a durable ordered event journal and read-only shadow snapshots. **Pairing and read-only shadow synchronization are wired in Settings; device order/payment cutover remains gated.** Existing staff flows and encrypted queues remain intact; no automatic migration of previously attempted orders. 107 core tests pass locally; the latest native Xcode run passes all 21 UI cases. See `docs/POS_API_MIGRATION.md` for implemented versus pending wiring and final backend gates.

Additional independent hardening: approved staging-origin validation before credentials leave the app; periodic signed-image cursor refresh without a menu event; Arabic decimal separator handling; branch-local business dates; localized errors/roles/kitchen times/order search; duplicate-localization-key crash prevention; receipt language isolation and explicit non-fiscal/test labels. Portable core Debug/Release and synthetic-transport checks pass locally. Latest Apple build/UI results must be recorded against the exact source revision.

## Historical verification notes

Run [40148561355](https://github.com/MoAlazool/ResutoGDG/actions/runs/40148561355) at `fc6f583` passed 91 core tests and Debug/Release builds, with **13/14 UI cases passing**. The restored-cart assertion ran before branch loading released busy state; it now waits for the enabled control. The next run adds a 15th synthetic UI case for staff-on-device pairing, shadow snapshots and local forgetting without staff logout. Latest-head Apple verification is pending until that run completes. Local core tests now cover 107 cases. No authenticated staging or physical-device acceptance is inferred.

Additional independent work: the floor has a native table-list alternative, automatically selected at accessibility Dynamic Type sizes, with localized occupancy/capacity and actionable table descriptions. Two new synthetic UI scenarios cover list-based dine-in selection and Arabic accessibility text (18 scenarios total; latest Apple result pending). Permission access now uses a scoped eight-hour identity lease rather than Wi-Fi reachability, with wall/monotonic expiry and rollback/isolation tests. Reconciliation tests reject mismatched order numbers and currencies without claiming acceptance. No staging/device result is implied.

Latest completed Apple run: [40150009851](https://github.com/MoAlazool/ResutoGDG/actions/runs/40150009851) at `812439b` passed 96 core tests, Debug/Release builds and **14/15 UI tests**, including staff/device pairing, shadow projection and local forgetting, plus the corrected cart relaunch. The remaining order/Settings failure exposed a background response reopening a dismissed detail sheet. The follow-up checks the current selection and order version before applying refresh, invalidates in-flight cache reads across scope changes, and waits for toolbar interactability. A rerun of all 18 UI scenarios is required. No authenticated staging or physical-device verification is claimed.

Follow-up source review found initial workspace selection depended on a permission lease still loading during branch entry. Initial navigation now uses membership hints; operational actions keep the scoped lease and server guard. Mutation completion/failure invalidates older in-flight reads, and an unrelated uncached identity response no longer discards menu ETags. Two deterministic networking tests cover those cache cases (107 portable tests total). The d8c07ce CI run was superseded during UI execution; its 105 core tests and Release build passed, but its full 18-case UI result is not a pass. The corrected revision requires a complete native rerun.

Run 40188215710 at `e6feb5a`: 107 core tests, Debug/Release builds, **17/18 UI scenarios passed**. Startup navigation and order dismissal are fixed; both table-list/accessibility scenarios pass. The remaining refund assertion failed on XCTest hit-testing of static text; its semantic helper is corrected and requires the next full run. No app financial-success behavior was relaxed.

## Current acceptance

Native source and simulator checks pass at `05096ad`; evidence: `docs/evidence/native-ci-05096ad.json`. This does not complete the product mission. Required next gates remain: POS 0.2.0 staging deployment and dedicated QA setup; full native/Web Orders/KDS/payment/inventory/analytics lifecycle; device-write cutover after shadow acceptance; additional native workflow coverage/implementation listed in `TEST_MATRIX.md`; full visual/accessibility/performance acceptance; printer/provider/fiscal validation; signing/release prerequisites. Keep PR #3 Draft and targeting `feature/ipad-pos`.

Shared platform CI run `40189594097` is green after retrying the restricted-runtime API job. Browser: 70 passed; restricted API: 917 passed / 1 skipped. The initial shared messaging assertion is retained for Claude's follow-up; no shared source was changed. Final evidence updates are documentation only and preserve application code tested at `05096ad`.

## Shared CI at the final native source

[Run 40210274579](https://github.com/MoAlazool/ResutoGDG/actions/runs/40210274579) at `42263eb` is green: browser 70 passed, API 914 passed / 4 skipped, restricted runtime API 917 passed / 1 skipped, web 445 passed / 20 skipped, plus database/security/build and visual parity checks. These are disposable CI services, not authenticated staging. Exact results are recorded in `docs/evidence/shared-ci-42263eb.json`.
