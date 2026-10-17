-- Resuto Finance (Agent D1): stored export files (checksum-verified downloads)
-- and accounting push history.

alter table public.financial_exports add column branch_id uuid references public.branches(id) on delete cascade;
alter table public.financial_exports add column filename text;
alter table public.financial_exports add column content text;   -- CSV/JSON as generated; checksum = sha256(content)
create index financial_exports_org_idx on public.financial_exports(org_id, created_at desc);

create table public.accounting_pushes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  connection_id uuid not null references public.integration_connections(id) on delete cascade,
  provider text not null,
  kind text not null check (kind in ('journal', 'invoice')),
  period_start date not null,
  period_end date not null,
  status text not null check (status in ('succeeded', 'partial', 'failed')),
  entries jsonb not null default '[]'::jsonb,      -- what was sent (references, totals)
  external_ids jsonb not null default '[]'::jsonb,
  error text,
  idempotency_key text not null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (org_id, idempotency_key)
);
create index accounting_pushes_org_idx on public.accounting_pushes(org_id, created_at desc);

create index expenses_category_idx on public.expenses(category_id);
create index order_lines_org_order_idx on public.order_lines(org_id, order_id);

select app.enable_tenant_rls('public.accounting_pushes');

select app.lockdown_public_grants();
