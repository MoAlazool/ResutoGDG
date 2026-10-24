# Native development handoff

The native track has a functional source implementation and a review PR; it is not a completed production POS. The exact checklist is `../STATUS.md`. Review PR: https://github.com/MoAlazool/ResutoGDG/pull/3, base `feature/ipad-pos`, head `codex/ipad-pos-native-client`. The local working branch remains `feature/ipad-pos`; its commits are pushed only to the isolated review head. No remote target/Claude/main branch is updated or merged.

## Delivered code

SwiftUI iPad application, deterministic checked-in Xcode project, portable Swift package, generated permission hints, typed verified REST contracts, Supabase auth, secure storage, scoped drafts/outbox, original-key financial recovery, server-backed catalogue/order/floor/KDS/customer/reservation flows, cash/refund requests, operational receipts and conservative hardware adapters. English/Arabic UI and Western digits are implemented; visual/device acceptance is outstanding. All authoritative records and business operations remain in Resuto's existing backend.

Native implementation lives under `apps/ipad-pos/`; the only outside change is the dedicated native Actions workflow. The existing local `data/` directory is not changed, staged or committed. No shared server/database code, provider credentials, infrastructure or deployments were changed.

## Validation evidence

Run `swift test --package-path apps/ipad-pos` for portable tests and `python3 apps/ipad-pos/scripts/check_contracts.py` for route drift. Linux results are recorded in `evidence/core-tests-linux.log`. macOS run 40125492140 passed at `be5a528` (42 core + 4 UI tests, Xcode 16.4); its JSON evidence and inspected screenshot result are recorded. Newer workflow runs and native screenshots/result bundles are on the PR checks; check the exact head SHA before treating a result as current. Syntax-only local parsing is not Apple compilation. Read-only staging health/401 evidence is in `evidence/staging-read-only.json`, not an authenticated lifecycle result.

GitHub read access and CI are available. Supabase/Render/Vercel are installed according to plugin discovery but provider-specific callable tools were unavailable to this session. No authorized staging staff account/public project configuration was supplied to the native client; authenticated end-to-end verification remains open. Public staging API currently reports build `5c359d5`, sandbox payment mode and healthy database connectivity. Latest fetched Claude branch at `fe93c1d` changes no API/contracts/OpenAPI relative to the native baseline.

## Next independent development work

Complete authenticated UI/integration tests on dedicated staging data; add lifecycle failure injection at the application orchestration layer; validate every bilingual screen, keyboard/VoiceOver/multitasking and real-device performance; improve dense floor accessibility/zoom and pagination for extremely large active queues; finish reservation creation/editing if desired for native POS staff; add approved release art and managed-device retention policy. These are remaining implementation/verification tasks, not all external blockers.

## Backend decisions for Claude

Prioritize atomic staff quote/price consent, durable operation lookup/uniqueness beyond HTTP idempotency retention, and native device enrollment/revocation policy. Then agree order-line amendments/table transfers/check merge/staff split commands and optional authenticated event stream. `../API_DEPENDENCIES.md` specifies current behavior, proposed schemas, permissions and acceptance cases. Do not expose guest tokens or replace backend authorization to make native features appear complete.

## Owner-dependent validation

Supply authorized staging staff accounts/project public config through approved access, Apple Developer team/signing, actual target iPads and selected printer/cash-drawer models. Review privacy and fiscal requirements; configure provider TEST credentials through the shared platform owner. Follow `VERIFICATION.md`, `SECURITY.md`, `HARDWARE.md` and `RELEASE.md`. Neither a CI pass nor a rendered native screen proves physical printer, provider settlement, regulatory or production readiness.
