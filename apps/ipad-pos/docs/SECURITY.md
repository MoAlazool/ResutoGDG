# Mobile security review

## Controls implemented

Tokens and encryption keys use Keychain generic passwords with `WhenUnlockedThisDeviceOnly`. No passwords persist. Supabase project public publishable/anon keys are configuration, never service-role keys; configuration rejects non-anon JWTs. No development issuer, MCP impersonation, embedded production credentials, bypass headers, pin-only identity or local admin override.

API/Supabase require HTTPS, no URL credentials/query/fragments; API root is `/v1`. URLSession is ephemeral with no shared cookie/disk response cache. Redirects are refused, normal platform certificate validation is retained, and no custom trust bypass is installed. A refresh is shared by concurrent reads. Logout invalidates in-flight refresh generation so a late response cannot restore a signed-out identity. Supabase logout uses `scope=local`, preserving other clients' sessions.

Local data is AES-256-GCM authenticated, atomically replaced, completely file-protected and excluded from backup. Filenames and Keychain namespaces derive from environment and user/tenant/branch context, not customer identifiers. Cached DTOs omit product costs and customer contacts. Pending order notes may contain sensitive staff-entered information, hence encrypted persistence and no plaintext diagnostics. Losing the encryption key is not silently treated as an empty queue. Corrupt data fails visibly.

UI permission hints are generated from the platform matrix. Every authoritative operation is sent to the existing access guard and branch-scoped services. The native app re-reads `/me` before automatic queue replay, uses versioned transitions/cancellations, clears protected memory on authorization rejection, and blocks offline operational access after eight hours without refresh. No offline payment/refund or stock mutation is accepted. Online financial intents persist original identity before network, require explicit staff recovery after ambiguity and stop before server idempotency retention expires and fail closed after clock rollback. Unknown/pending/manual-required refund results remain unconfirmed.

Logs contain no tokens, email, customer details, payment references or HTTP body dumps. User-facing failures render translated recovery keys instead of arbitrary backend error messages; request IDs remain separate for support. Request IDs are available for support. No analytics/crash SDK has been added. Swift dependencies are empty; GitHub actions use pinned commit SHAs and read-only repository permissions. Network printer payloads are rendered images, so notes cannot inject ESC/POS control commands. Network adapter accepts only private/link-local IPv4 addresses and documented raster widths; no drawer/cutter commands are sent.

## Remaining risks and owner decisions

- **Release blocker:** no authenticated staging/mobile security acceptance yet. Core negative tests are not proof that the deployed server rejects every cross-tenant request.
- **Backend blocker:** mobile device enrollment/revocation, server operation lookup and atomic quote consent are not available. Supabase access JWT revocation limitations are already recorded in `docs/HANDOFF.md` PS-25. An offline grace window cannot observe remote revocation; shorten/remove it for high-risk installations.
- **Device validation:** test locked-device writes, reboot-before-first-unlock, corrupt ciphertext, Keychain access failures, OS snapshot behavior, background transitions and account switching. A scene-phase privacy curtain is implemented; verify its timing in actual app switcher snapshots on a device.
- **Transport:** raw ESC/POS LAN traffic is unencrypted; restrict it to a managed restaurant LAN and validate supported printer models. Physical receipt success is never inferred from TCP completion.
- **Privacy:** App Store data disclosures, retention and owner privacy policy require review. Authentication/order activity travels to Resuto/Supabase; a local cache is not a separate authoritative data system. Native local records currently have no complete retention management UI. Scope them to managed devices until retention/wipe policy is implemented.
- **Financial recovery:** durable intent replay is bounded and manual. There is no safe automatic clearing of ambiguous intents; use platform records and manager reconciliation. Certified tax receipt/terminal compliance is not established.
- **Supply chain:** macOS CI has recorded app/core/smoke results; expanded workflows and actual physical devices remain separate acceptance gates. No signing credential should be added to source or ordinary PR jobs.

## Simulator test isolation

Synthetic transport compiles only for DEBUG simulator builds and requires an explicit launch flag plus fixtures supplied by XCTest. It targets reserved `.invalid` hosts, is visibly labelled NOT-STAGING, does not enter Release/device builds and does not replace Keychain/encrypted storage. Test reset removes only its environment-scoped files/session. CI ad hoc signing grants simulator test Keychain access; a release must use the owner's authorized team/profile, not the `RESUTOTEST.` CI prefix.

## Negative test evidence

Portable tests cover permission fail-closed behavior, allowed-branch restrictions, cross-user/tenant/environment queue isolation, denied queue replay, foreign/duplicate/unavailable modifiers, quantity bounds, failed disk writes, corrupt queue data, expired replay window, no automatic mutation retry and HTTPS enforcement. Read-only staging probes demonstrate 401 for unauthenticated identity and orders access. Authenticated tenant A → tenant B, revoked user/device, expired JWT and denied refund tests remain in the staging acceptance checklist.
