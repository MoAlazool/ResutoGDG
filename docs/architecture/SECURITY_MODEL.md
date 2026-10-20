# Security model

## Principals

| Principal | Credential | Where verified | Acts as |
|---|---|---|---|
| Staff user (owner…driver) | Supabase Auth access token (JWT; HS256 secret or JWKS) | `AccessGuard` → `JwtService.verify` | `TenantContext` with membership role and branch scope |
| Platform admin | Supabase JWT + row in `platform_admins` | `@PlatformAdmin()` routes only | platform context, every action audited |
| MCP client | `rmcp_…` key (sha256 stored), scoped to one org, a non-owner acting role, optional branch list and tool allow-list | `AccessGuard.resolveMcp` | `TenantContext` (`actorType = mcp_client`), only the MCP runtime (`@McpRuntime()`: whoami, tool list, tool calls), so every action passes the tool allow-list, approvals, limits and audit; per-client rate limit |
| Guest | random bearer tokens for a visit, bill share, ordering session, checkout session or reservation (sha256 stored) | each public endpoint | tenant context resolved from the token |
| Provider webhook | provider signature (HMAC / provider scheme) | webhook controller before parsing | tenant resolved from provider ids, `TenantContext.system` |
| Worker job | none (in-process) | — | `TenantContext.system(orgId)` per tenant |

Local development uses `AUTH_DEV_MODE=true`, an email/password issuer in the API that
mints JWTs with the same claims as Supabase Auth. Environment validation refuses to
start with `AUTH_DEV_MODE` in production.

## Authorization layers (all must pass)

1. **Authentication** — `AccessGuard` (global). Routes are private unless `@Public()`.
2. **Tenant membership** — for any route with `:orgId`, the user must hold an active
   membership in a non-closed organization; otherwise **404** (existence of other
   tenants is never confirmed). MCP keys only match their own org.
3. **Role permission** — `@RequirePermission(...)` checked against
   `ROLE_PERMISSIONS` in `@resuto/contracts` (single source for API, web and MCP).
   Role assignment never exceeds the assigner (`assignableRoles`); the owner role is
   never assignable or editable through member APIs; users cannot change their own access.
4. **Branch scope** — memberships may list branch ids; services call
   `ctx.assertBranch()`; RLS enforces it again for member sessions.
5. **Module entitlement** — `@RequiresModule(...)` calls `app.module_enabled()`:
   plan modules + add-ons + overrides, subscription `trialing/active` or `past_due`
   within grace. Plan limits (branches, staff) are enforced in services (HTTP 402).
6. **Row-Level Security (defense in depth)** — every tenant table has RLS:
   - `resuto_member` (API acting for a user): `org_id = app.org_id` **and** active
     membership of `auth.uid()` **and** branch scope.
   - `resuto_tenant` (guest, webhook, job, MCP): `org_id = app.org_id`.
   - `authenticated` (direct Supabase client, e.g. Realtime): SELECT only on
     orders, order_lines, dining_tables, service_requests, reservations,
     delivery_jobs, conversations, messages, branches, own memberships/profile.
     All INSERT/UPDATE/DELETE privileges are revoked (`app.lockdown_public_grants()`).
   - `anon`: no privileges.
   Verified by `supabase/tests/rls.test.mjs` (forged org id, cross-tenant insert,
   branch scope, direct-client writes, credential columns).

## Data protection

- Provider credentials: AES-256-GCM envelopes (`SecretBox`, key rotation by key id)
  in `integration_connections.credentials_encrypted`; column not selectable by
  member sessions; only `credentials_hint` is ever returned.
- Bearer tokens and invitation tokens: only sha256 stored; tokens are shown once.
- Passwords (dev issuer only): scrypt. Production passwords live in Supabase Auth.
- Media: private bucket `tenant-media`, paths prefixed by org id, magic-byte type
  validation, 15 MB limit, short-lived signed URLs.
- Audit log: append-only for application roles (trigger), includes MCP and AI actions.
- Fiscal documents: immutable after issue (trigger); corrections use credit notes.
- Service-role keys (`SUPABASE_SERVICE_ROLE_KEY`) exist only server-side.

## Payments integrity

- Totals are computed only by `PricingService`; client totals are compared, never used.
- Payment success is applied only by `PaymentLedgerService` from (a) staff-recorded
  cash/COD, or (b) **verified** provider webhooks / server-side provider status
  queries whose amount and currency match the pending attempt. WhatsApp messages,
  redirects and return URLs never mark anything paid.
- Overpayment, double-application (row locks), idempotency-key reuse with a
  different payload, and refunds above the paid amount are rejected.
- Resuto does not hold merchant funds: each restaurant connects its own provider
  account; Resuto stores references and reconciliation records.

## Public surface hardening

- QR tokens identify a table but are never returned by any public endpoint
  (fixes the legacy table-takeover issue documented in CURRENT_STATE.md).
- Public endpoints are rate-limited by IP and by token (`RateLimiter`; in-memory per
  instance today — use a Redis-backed limiter when running several API instances).
- Security headers: `nosniff`, `Referrer-Policy`, no `x-powered-by`; CORS restricted to
  `CORS_ORIGINS`.
- Webhooks: signature verified against the raw body before JSON parsing; events
  deduplicated by `(provider, event_key)` in `webhook_inbox`.

## MCP and AI boundaries

- External AI (MCP) and native AI reach data only through API services with a
  `TenantContext`; no SQL tool, no database credentials, no cross-tenant tools.
- Tool inputs/outputs are schema-validated; sensitive actions (sending messages,
  launching campaigns, refunds, price changes) create `mcp_approvals` that a human
  with `mcp:approve` must approve in the dashboard before execution.
- Every MCP call is recorded in `mcp_tool_calls` and `audit_logs` (source `mcp`).
- Financial totals and safety rules are computed deterministically, never by an LLM.

## Known gaps (tracked in docs/OPEN_BLOCKERS.md)

- Supabase Auth itself has not been exercised locally (no Docker); the JWT contract is
  tested with the dev issuer using the same claims.
- Rate limiting is per-process.
- No external penetration test has been performed.
