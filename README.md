# Resuto 2.0 — AI-native restaurant operating system

**Operate smarter → understand customers → increase profitability → grow faster.**

Resuto is a modular SaaS platform for restaurants in Egypt and Saudi Arabia:
operations (menu, QR ordering, reservations, floor, kitchen, inventory), customer
experience, WhatsApp ordering, payments, delivery, marketing, websites, finance,
compliance, native AI and secure MCP connectivity for external AI clients.

> Branch status: Resuto 2.0 is being built on `claude/relaxed-mayer-omkl3f` as a
> parallel migration. The original application is preserved, unchanged and runnable,
> in [`legacy/`](legacy/README.md). See [docs/EXECUTION_PROGRESS.md](docs/EXECUTION_PROGRESS.md)
> and [docs/MODULE_STATUS.md](docs/MODULE_STATUS.md) for the honest current state.

## Repository

```text
apps/
  api/          NestJS modular monolith (HTTP API + worker entrypoint)
  web/          Next.js (customer site, QR ordering, dashboard, kitchen, driver, admin)
  ai-service/   Python FastAPI baselines (forecasting, customer intelligence, routing)
  mcp-server/   ResutoMCP server for external AI clients
packages/
  contracts/    Zod schemas, permissions, state machines, money helpers
  integrations/ provider adapters (payments, messaging, ads, accounting, POS, tax)
  ui/           design-system React components
supabase/       migrations (source of truth), seeds, database security tests
tools/          legacy data migration
docs/           architecture, status, research
legacy/         ResutoGDG 1.x, preserved
```

## Quick start (local)

Requirements: Node 22.12+, pnpm 10, PostgreSQL 16 binaries (or Docker + Supabase CLI), Python 3.12+.

```bash
pnpm install
pnpm db:up          # local Postgres on 127.0.0.1:54329 (+ Supabase auth shim)
pnpm db:migrate
pnpm --filter @resuto/contracts build && pnpm --filter @resuto/integrations build
cp .env.example .env
pnpm --filter @resuto/api build && (cd apps/api && node --env-file=../../.env dist/main.js)
pnpm --filter @resuto/web dev
```

With the Supabase CLI and Docker: `supabase start` then `supabase db reset` applies
the same migrations; set `SUPABASE_URL`/`SUPABASE_JWT_SECRET` from `supabase status`
and `AUTH_DEV_MODE=false`.

## Tests

```bash
pnpm db:test                         # RLS / tenant isolation / constraints
pnpm --filter @resuto/contracts test
pnpm --filter @resuto/api test       # API integration tests on real Postgres
pnpm --filter @resuto/web build      # type-checks every page
pnpm legacy:test                     # original application
```

## Architecture

- [Target architecture](docs/architecture/TARGET_ARCHITECTURE.md)
- [Module contracts & ownership](docs/architecture/MODULE_CONTRACTS.md)
- [Security model](docs/architecture/SECURITY_MODEL.md)
- [Database ERD](docs/architecture/DATABASE_ERD.md)
- [Migration plan](docs/architecture/MIGRATION_PLAN.md)
- [Current (legacy) state](docs/architecture/CURRENT_STATE.md) · [Feature inventory](docs/architecture/FEATURE_INVENTORY.md)
