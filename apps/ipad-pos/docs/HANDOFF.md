# Native development handoff

The native track has a functional source implementation and a review PR; it is not a completed production POS. The exact checklist is `../STATUS.md`. Review PR: https://github.com/MoAlazool/ResutoGDG/pull/3, base `feature/ipad-pos`, head `codex/ipad-pos-native-client`. The local working branch remains `feature/ipad-pos`; its commits are pushed only to the isolated review head. No remote target/Claude/main branch is updated or merged.

## Delivered code

SwiftUI iPad application, deterministic checked-in Xcode project, portable Swift package, generated permission hints, typed verified REST contracts, Supabase auth, secure storage, scoped drafts/outbox, original-key financial recovery, server-backed catalogue/order/floor/KDS/customer/reservation flows, cash/refund requests, operational receipts and conservative hardware adapters. English/Arabic UI and Western digits are implemented; visual/device acceptance is outstanding. All authoritative records and business operations remain in Resuto's existing backend.

Native implementation lives under `apps/ipad-pos/`; the only outside change is the dedicated native Actions workflow. The existing local `data/` directory is not changed, staged or committed. No shared server/database code, provider credentials, infrastructure or deployments were changed.

## Validation evidence

Run `swift test --package-path apps/ipad-pos` for portable tests and `python3 apps/ipad-pos/scripts/check_contracts.py` for route drift. Linux results are recorded in `evidence/core-tests-linux.log`. macOS run 40125492140 passed at `be5a528` (42 core + 4 UI tests, Xcode 16.4); its JSON evidence and inspected screenshot result are recorded. Newer workflow runs and native screenshots/result bundles are on the PR checks; check the exact head SHA before treating a result as current. Syntax-only local parsing is not Apple compilation. Read-only staging health/401 evidence is in `evidence/staging-read-only.json`, not an authenticated lifecycle result.

GitHub, Supabase, Render and Vercel connectors are callable and were inspected read-only. Supabase staging origin/public configuration are verified, but no approved native QA identity/credential source exists in the inspected staging context. Authenticated end-to-end verification remains open. `STAGING.md` specifies isolated QA setup, the real native Swift probe and secret-handling constraints. Public staging API reports build `5c359d5`, sandbox payment mode and healthy database connectivity. Latest fetched Claude `69ec75e` implements draft POS API 0.2.0 with staff-on-device and permanent by-client-ID lookup. New native compatibility adapters are implemented/tested, with live activation pending 0.2.0 deployment and shadow acceptance; see `POS_API_MIGRATION.md`.

## Current native compatibility additions

Separate staff/device credentials, mandatory staff-on-device session validation and permission intersection, scoped ordered feed checkpoints, read-only menu/floor/order shadows, exact server quote consent, permanent-ID device order reconciliation and endpoint-family-preserving queue extension are implemented as portable adapters. Existing SwiftUI routing stays on staff APIs. Pairing UI and cancellable foreground encrypted shadow synchronization are wired in Settings. POS writes remain gated on staging deployment, full service-day shadow comparison and native cross-platform acceptance. The pinned draft manifest and exact gating are in `POS_API_MIGRATION.md`.

Simulator CI now uses ad hoc Keychain entitlements. This fixed the original sign-in failure. Expanded workflows subsequently passed dine-in, encrypted relaunch, Arabic entry, role denial, accessibility descriptions and lost order-response recovery. Remaining lazy-form interaction/availability assertion failures were corrected; check the latest run for checkout/receipt and full-suite results. User-facing errors now use translated recovery keys rather than arbitrary backend messages; support request IDs remain available.

## Next independent development work

Complete authenticated UI/integration tests on dedicated staging data; add lifecycle failure injection at the application orchestration layer; validate every bilingual screen, keyboard/VoiceOver/multitasking and real-device performance; improve dense floor accessibility/zoom and pagination for extremely large active queues; finish reservation creation/editing if desired for native POS staff; add approved release art and managed-device retention policy. These are remaining implementation/verification tasks, not all external blockers.

## Backend decisions for Claude

Prioritize atomic staff quote/price consent, durable operation lookup/uniqueness beyond HTTP idempotency retention, and native device enrollment/revocation policy. Then agree order-line amendments/table transfers/check merge/staff split commands and optional authenticated event stream. `../API_DEPENDENCIES.md` specifies current behavior, proposed schemas, permissions and acceptance cases. Do not expose guest tokens or replace backend authorization to make native features appear complete.

## Owner-dependent validation

Supply authorized staging staff accounts/project public config through approved access, Apple Developer team/signing, actual target iPads and selected printer/cash-drawer models. Review privacy and fiscal requirements; configure provider TEST credentials through the shared platform owner. Follow `VERIFICATION.md`, `SECURITY.md`, `HARDWARE.md` and `RELEASE.md`. Neither a CI pass nor a rendered native screen proves physical printer, provider settlement, regulatory or production readiness.

## Latest native continuation — 2026-10-25

Native run 40189594156 is green at `05096ad`: 107 core tests, 18/18 iPad simulator workflows and Debug/Release builds on Xcode 16.4. `evidence/native-ci-05096ad.json` records the exact execution. `TEST_MATRIX.md` lists covered assertions and remaining internal work. The simulator launch mean is 2.569 s; device performance and full visual/accessibility acceptance are not established.

POS 0.2.0 pairing, separate Keychain credentials, staff/device permission intersection and encrypted foreground read-only shadows are wired in Settings. Device order/payment writes remain gated on deployed QA shadow/lifecycle acceptance; legacy operations preserve their endpoint/key. Scoped identity leases, late-read cancellation, mutation cache invalidation, conditional ETags, order selection/version checks, accessible table lists and manual-required refund UI are implemented/tested. Staging remains build `5c359d5` with no POS tables or dedicated Native QA restaurant; no approved staff credential source was available. Native/App/DB/production ownership boundaries remain unchanged. PR #3 remains Draft with base `feature/ipad-pos`.
