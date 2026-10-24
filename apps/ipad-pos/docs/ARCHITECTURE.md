# Architecture, product plan and operating boundaries

## Discovery baseline

Read before integration: `RESUME.md`, `docs/HANDOFF.md`, `docs/TEST_RESULTS.md`, `docs/api/openapi.json`, `docs/STAGING_DEPLOYMENT.md`, `packages/contracts/src/{platform,permissions,catalog,orders,payments,floor,state-machines,common}.ts`, NestJS access guard, auth/orders/visits/floor/kitchen/menu/payment controllers, shared order kernel and idempotency service. Existing web design tokens are in `docs/ui/design-tokens.json`. The native accent follows the Resuto green family; native system surfaces adapt to appearance and text size.

The backend is a NestJS modular monolith with tenant-scoped PostgreSQL transactions, Supabase JWT authentication, membership/branch restrictions, optimistic order versions, a shared order kernel/payment ledger and transactional outbox. Web and iPad read the same records. No native schema or server fork is introduced. Storage namespaces use a deterministic length-prefix encoding of environment, user, restaurant and branch before hashing, independent of JSON key order. Local encrypted files hold disposable caches and durable unsubmitted/recovery operations only.

## Execution sequence and next work

A. Discover and map contracts; document safety gaps. B. Build portable contracts/domain/networking + iPad shell, Keychain and encrypted storage. C. Connect catalogue/cart/floor/order/KDS. D. Add server-confirmed cash/refund requests and receipt queues. E. Exercise crash/retry/isolation and offline recovery. F. Validate language/accessibility/layout and performance in Xcode and on hardware. G. Complete staging lifecycle, provider/hardware acceptance and distribution. A–E have substantial implementation; status is granular in `STATUS.md`. F/G remain verification and product completion tracks, not implicitly done because code exists.

## Layers

- `Sources/ResutoCore/Contracts.swift`: reviewed Codable/Sendable subsets of existing contracts; ignore additional server fields without inventing required fields.
- `Domain.swift`: input constraints, item estimates (not tax/ledger), Western money strings, amount splitting and lifecycle hints.
- `Permissions.swift`: generated from backend role matrix; guards remain authoritative.
- `Networking.swift`: HTTPS URLSession transport, bearer tokens, single-flight Supabase refresh, errors/request IDs, bounded ETag cache and typed decoding. Read refresh retry only; mutation retries require their original durable identity.
- `Synchronization.swift`: actor-owned scoped durable operations, immutable order payloads, atomic persistence before network, backoff/jitter, retention stop, conflict attention states.
- `Receipts.swift`: authoritative order-summary projection and conservative durable physical-print queue.
- `App/Security.swift`: platform Keychain, AES-GCM files, complete file protection and backup exclusion, environment validation, redirect refusal.
- `App/POSModel.swift`: application orchestration, active authenticated context, revision guards for refreshes, foreground polling, draft and financial recovery.
- SwiftUI screen files: native navigation, order entry and operational views, contextual sheets, native controls, Dynamic Type/system semantics.
- `Printing.swift`: AirPrint and explicit local IPv4 ESC/POS raster adapter; no universal device assumption.

The app target compiles the shared source directly. The independent Swift package makes core domain/network/queue tests executable on Linux and macOS. No third-party Swift library is required.

## Interaction model

Landscape uses sidebar + catalogue/cart panes; narrow widths use an adaptive fallback. Floor coordinates remain physical world coordinates even in RTL. Product options are validated against group min/max and availability; backend validates again. A local draft can be edited freely. A persisted cart draft owns the same stable ID used for capture and server submission. Recovered consumed drafts are suppressed; recapturing the same draft returns its existing operation, while payload/scope changes under that ID fail closed. This closes a force-close window between the outbox write and clearing the separate cart snapshot. An attempted order freezes its key/payload; semantic conflicts need staff attention. Existing orders may be advanced/cancelled using server versions, while line amendments and table transfers await shared contracts.

Language uses a central English/Arabic catalogue, native Unicode Arabic shaping and semantic layout direction. Western digits are generated explicitly for financial values. Server free-text errors and product data may remain in their supplied language. Full Arabic visual audit is pending. No custom motion overrides system reduced-motion behavior; no WebView is used.

## Offline policy

| Operation | Offline behavior | Recovery |
|---|---|---|
| Catalogue/floor layout | Encrypted, scoped snapshot up to 24 h; status labelled stale | Foreground server refresh |
| Active session ordering | Capture drafts for up to 8 h since last server refresh | Explicit fresh-menu review before send |
| Restart without connectivity | Online identity validation required to reopen operational context | Sign in/restore when connected |
| Draft/cart changes | Atomic encrypted snapshot on edits and scene transition | Same environment/user/restaurant/branch only |
| Order creation | Local only until staff approves online; no kitchen success claim | At-least-once HTTP with same key and frozen body |
| Interrupted creation | Queued, backoff 2^attempt + jitter, capped 300 s; honors Retry-After | Same key; 6-day limit; semantic errors require review |
| Table occupancy/status, stock, cancellation | Online-only mutations | Server version/rule validation |
| Cash/refund | Online-only; immutable intent durable before request; no background replay | Staff explicitly retries same request in Settings; expiry requires external reconciliation |
| Printing | Persisted queue; network outcome can be uncertain | No automatic uncertain reprint; staff checks paper first |

No exactly-once claim extends beyond server idempotency retention or physical printer acknowledgements. Native synchronization is not background guaranteed: foreground polling resumes on activation. Force-close recovery reloads durable operations, not an in-memory task. Membership and role are refreshed before queue drain; sign-out removes session credentials and clears operational memory while scoped encrypted drafts remain for the same authenticated user.

## Known implementation gaps

Reservation creation/editing UI, line amendments, table move/merge, item/customer split UI, provider terminal payments, cash drawer actions, vendor SDK adapters, remote device enrollment, biometric/offline unlock policy, and certified fiscal receipts remain incomplete. These are explicit product/backend/hardware dependencies. Core screens should not be represented as complete end-to-end acceptance until staging and device verification pass.
