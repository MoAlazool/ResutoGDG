# Security model

## Principals

| Principal | Credential | Where verified | Acts as |
|---|---|---|---|
| Staff user (owner…driver) | Supabase Auth access token (JWT; JWKS, or HS256 only without `SUPABASE_URL` or with `AUTH_ALLOW_HS256`; anonymous sessions refused) | `AccessGuard` → `JwtService.verify` | `TenantContext` with membership role and branch scope; a branch-restricted admin grants and manages only access within their own branches |
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
  validation, 15 MB limit, short-lived signed URLs (local driver: HMAC with a purpose-bound
  key from `common/crypto/keys.ts`, never the JWT secret).
- Delivery codes: keyed HMAC (`h1:` prefix), 5 wrong attempts per issued code counted in the
  database lock the code until staff issue a new one.
- Purpose keys form a ring (`SIGNING_KEY` entries, then every `CREDENTIALS_KEYS` entry): the
  newest signs, all verify, so key rotation never turns outstanding delivery codes into wrong
  attempts or breaks signed media URLs.
- Authenticated API responses: `Cache-Control: private, no-store` and `Vary` on the credential
  headers unless a public controller sets its own policy; HSTS in staging/production.
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
  instance today: N instances allow N× each limit — use a shared store when scaling out).
  The client IP follows `TRUST_PROXY` (one hop on Render by default); 429s carry
  `Retry-After` and `RateLimit-*`. Restaurant creation is limited per user and per address.
- Security headers: `nosniff`, `Referrer-Policy`, `X-Frame-Options`, no `x-powered-by`; CORS
  restricted to `CORS_ORIGINS`. Web Content-Security-Policy (`apps/web/lib/csp.ts`): every
  page gets a per-request nonce from `apps/web/middleware.ts`; `script-src` allows only
  nonce'd scripts and what they load (`'strict-dynamic'`), with no `'unsafe-inline'`, so
  injected `<script>` tags and inline handlers do not run (the session token in
  localStorage cannot be read by injected markup). Connections only to the site, the API
  and Supabase; no framing, plugins or `<base>` changes; forms post only to the site.
  `img-src` allows any `https:` host because product images are tenant URLs; this matters
  only once script runs, which the nonce prevents (and running script could navigate away
  with the token regardless). Static files carry a compatible fallback policy from
  `next.config.ts`. After a web deploy, `curl -sI <page>` must show one
  `content-security-policy` header with a `'nonce-…'` source.
- Outbound calls to tenant-supplied URLs (Odoo POS/Accounting) go through the egress guard
  (`packages/integrations/src/net.ts`): public HTTPS hosts on 443 only, every DNS answer and
  redirect re-checked, redirects to another origin refused (credentials never follow them),
  capped body, and errors never carry the server's response or a parser message quoting it.
- Correlation: every request has an `X-Request-Id` (validated or generated), stored on
  `audit_logs`, `outbox_events` and `mcp_tool_calls`, carried into worker handler runs and
  sent on outbound calls (providers, AI service); one JSON access-log line per request.
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
- Rate limiting is per-process (see above); the delivery-code counter is the only one in the database.
- Guest/reservation tokens still derive from the first `CREDENTIALS_KEYS` entry (rotation
  invalidates sent links); a separate versioned key ring is a follow-up for the orders module.
- No external penetration test has been performed.
