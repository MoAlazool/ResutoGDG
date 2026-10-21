-- INT-25: per-document idempotency for accounting pushes. One row per Resuto reference (RSJ/RSR/RSE/RSC/RSF/RSP
-- journals, RSI summary invoices) that a connection has accepted, with the provider's id. A later push of the same
-- period (manual with a new key, or the daily automatic push) skips these references instead of creating duplicates
-- at the provider; the adapters also look the reference up at the provider before creating anything.
create table public.accounting_push_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  connection_id uuid not null references public.integration_connections(id) on delete cascade,
  push_id uuid references public.accounting_pushes(id) on delete set null,
  reference text not null check (reference ~ '^RS[A-Z]-[A-Za-z0-9._-]{1,150}$'),
  kind text not null check (kind in ('journal', 'invoice')),
  external_id text not null check (length(external_id) between 1 and 200),
  found_existing boolean not null default false,
  created_at timestamptz not null default now(),
  unique (connection_id, reference)
);
create index accounting_push_items_org_idx on public.accounting_push_items(org_id, created_at desc);
select app.enable_tenant_rls('public.accounting_push_items');
select app.lockdown_public_grants();

-- Reversal: drop table public.accounting_push_items;
