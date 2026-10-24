# Resuto native iPad POS

Native SwiftUI client for the existing Resuto platform, iPadOS 17+. No WebView, external Swift dependencies, or separate authoritative backend. **Under development; not production ready.** See [STATUS.md](STATUS.md) for evidence and remaining implementation work.

## Build

Open `ResutoPOS.xcodeproj` with Xcode 16+ and select an installed iPad simulator. The generated project includes the native app and UI tests; the Swift package exposes the portable core tests.

```sh
python3 apps/ipad-pos/scripts/generate_permissions.py
python3 apps/ipad-pos/scripts/generate_project.py
python3 apps/ipad-pos/scripts/check_contracts.py
swift test --package-path apps/ipad-pos
xcodebuild -project apps/ipad-pos/ResutoPOS.xcodeproj -scheme ResutoPOS -destination 'platform=iOS Simulator,id=<installed-UDID>' CODE_SIGNING_ALLOWED=NO test
```

Project generation is deterministic Python with no third-party module requirements. `Sources/ResutoCore` is compiled into the application target and also exposed as a standalone testable Swift package. UI tests exercise unauthenticated launch/rotation and startup metrics; they do not claim authenticated POS coverage.

At launch choose **Configure connection**, supply your authorized API URL ending `/v1`, Supabase project origin and public publishable/anon key. The staging API default is `https://resuto-2-staging-api.onrender.com/v1`; Supabase origin/public key must come from the authorized staging owner. Never use service-role keys. Then sign in with a real staff account and select an authorized restaurant/branch. The app does not create users, bypass web deployment protection, or use demo tokens.

## Implemented paths

Restaurant/branch selection; Supabase sign-in/refresh/logout; catalogue search/categories/images; constrained modifiers/quantities/notes/promotions; local cart edits; encrypted drafts/cache; floor table selection, seating/closing/cleaning; server order listing/detail/status/cancellation; KDS polling; online cash collection/partial amounts; refund requests; order summaries; AirPrint and opt-in network ESC/POS raster printing; recovery and explicit reprint queues; English/Arabic directional UI; settings and offline recovery.

Drafts are saved locally first. Open **Sync**, review a refreshed menu, then confirm submission. Pending sends preserve their idempotency key. Server acceptance and kitchen status are distinct. The client does not calculate authoritative tax or pretend that a local action settles a payment.

## Repository boundaries

Implementation and native documents stay in `apps/ipad-pos/`; the only outside file is `.github/workflows/ipad-pos.yml`. No shared API/DB/web changes. All work starts from `feature/ipad-pos`; any review PR must explicitly target `feature/ipad-pos`. Claude owns shared backend changes; [API_DEPENDENCIES.md](API_DEPENDENCIES.md) records proposed contracts without calling invented routes.

- [Architecture and execution plan](docs/ARCHITECTURE.md)
- [Security review](docs/SECURITY.md)
- [Hardware matrix](docs/HARDWARE.md)
- [Verification and acceptance](docs/VERIFICATION.md)
- [Release owner actions](docs/RELEASE.md)
