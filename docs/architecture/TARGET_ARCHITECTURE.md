# Target architecture — Resuto 2.0

## Shape

```text
Customer web (Next.js)      Owner dashboard        Kitchen display      Driver web app      Platform admin
 /r/:slug  /t/:qr            /dashboard/:orgId      /kitchen/:orgId      /driver             /admin
 /pay/:token /o/:token       (permission-aware)
        \___________________________|_________________________________________/
                                    |
                         NestJS API  /v1  (modular monolith)
           AccessGuard: auth → platform role → membership → permission → entitlement
    ┌───────────────┬──────────────┬──────────────┬──────────────┬──────────────┐
    │ kernel        │ core ops     │ growth       │ money        │ intelligence │
    │ pricing,      │ menu, floor, │ connect,     │ payments,    │ intelligence,│
    │ orders,       │ guest,orders,│ marketing,   │ finance,     │ mcp          │
    │ payment ledger│ kitchen,     │ integrations,│ delivery,    │              │
    │               │ reservations,│ studio       │ compliance,  │              │
    │               │ inventory,   │              │ billing      │              │
    │               │ customers,   │              │              │              │
    │               │ analytics    │              │              │              │
    └───────────────┴──────────────┴──────────────┴──────────────┴──────────────┘
          DbService (member / tenant / platform contexts) + RLS
                                    |
               Supabase PostgreSQL ── transactional outbox ── worker (same codebase)
                     |  Supabase Storage (tenant-media)          |  event handlers, scheduled jobs
                     |  Supabase Auth (JWT)                      |
                     |  (Realtime not used: staff screens poll)  |
                                    |
        ┌───────────────────────────┼─────────────────────────────┐
   ai-service (FastAPI)      provider adapters             mcp-server (MCP SDK)
   forecasting, segments,    payments, WhatsApp, ads,      authenticates rmcp_ keys,
   recommendations, routing  accounting, POS, tax          calls the API MCP runtime
```

## Decisions

| # | Decision | Rationale |
|---|---|---|
| ADR-1 | Modular monolith (NestJS) + separate Python AI service + thin MCP server | Strong boundaries without distributed-system cost; Python where the ML ecosystem is. |
| ADR-2 | SQL migrations as source of truth; `pg` with explicit SQL, not Prisma | RLS needs per-transaction `SET ROLE` + `set_config` claims, exclusion constraints, triggers and security-definer helpers. Prisma would duplicate the schema and make per-request RLS awkward. Migrations stay compatible with `supabase db push`. |
| ADR-3 | Three DB execution contexts (`member`, `tenant`, `platform`) | Every query runs under RLS appropriate to the actor; platform context is limited to tenant resolution and admin. |
| ADR-4 | Shared kernel for pricing, orders and payment ledger | Every channel (QR, web, WhatsApp, staff, MCP) prices and settles identically; one place to test money logic. |
| ADR-5 | Transactional outbox + Postgres dispatcher (no Redis yet) | Leased claims (`outbox_events.claim_token`, `event_handlings` 'running' with `lease_until`) and per-handler timeouts for horizontal workers; `onceForEvent()` (`event_effects`) for side effects that must not repeat; jobs claimed through `job_leases`. Redis/BullMQ added only when fan-out or rate-shaped queues need it. |
| ADR-6 | Integer minor units + explicit currency; VAT in basis points | Deterministic, auditable money; EG 14% / SA 15% defaults configurable per tenant. |
| ADR-7 | Separate order, payment and delivery state | Matches reality (paid-but-not-ready, delivered-but-COD-pending) and the prompt's requirement. |
| ADR-8 | Supabase Auth JWTs verified in the API; dev issuer for local only | Mobile-ready (any client with a JWT), no session cookies to share across apps. |
| ADR-9 | Next.js App Router, client data via the API only | Preserves Resuto UI in React; no direct DB access from browsers. |
| ADR-10 | Provider readiness levels (`simulated`, `implemented_unverified`, `sandbox_verified`, `live_verified`) shown in UI | Honest status for every integration. |
| ADR-11 | Custom domains map to the same app + tenant via host lookup | One deployment, one database; DNS/SSL activation is a hosting-provider step. |

## Environments

| | Development | Staging | Production |
|---|---|---|---|
| Database | local Postgres 16 (`pnpm db:up`) or `supabase start` | Supabase project `resuto-staging` | Supabase project `resuto-prod` |
| Auth | dev issuer or local Supabase | Supabase Auth (staging project) | Supabase Auth |
| Payments | `PAYMENT_MODE=sandbox` (simulated + provider sandboxes) | provider sandboxes | merchant live accounts |
| WhatsApp | sandbox transport | Meta test number | merchant WABA |

Each environment has its own Supabase project, keys, `CREDENTIALS_KEYS` and provider
credentials. See `docs/DEPLOYMENT_READINESS.md`.

## Portability (self-hosting)

- Database: plain Postgres 16 + the auth shim pattern; all schema in migrations.
- Auth: any issuer producing compatible JWTs (Supabase self-hosted GoTrue, or the
  JWKS path for another IdP); `auth.users` FK is the only coupling.
- Storage: `StorageService` driver interface (`local`, `supabase`; S3-compatible next).
- Containers: `apps/api` (API + worker), `apps/web` (Next standalone), `apps/ai-service`, `apps/mcp-server`.
