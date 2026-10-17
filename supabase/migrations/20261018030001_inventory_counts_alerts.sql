-- Inventory (Agent B2): stocktakes, waste reasons, transfer pairing and
-- deduplicated low-stock alerts. Quantities are in the item's own unit.

-- Waste is recorded with a reason so food-waste indicators are measured, not estimated.
alter table public.stock_movements add column waste_reason text
  check (waste_reason is null or waste_reason in ('expired', 'spoiled', 'damaged', 'overproduction', 'plate_waste', 'other'));
alter table public.stock_movements add constraint stock_movements_waste_reason_required
  check (reason <> 'waste' or waste_reason is not null);
-- Both legs of a branch transfer share one id (reference_type = 'transfer').
create index stock_movements_reference_idx on public.stock_movements(org_id, reference_type, reference_id);

-- A stocktake line: what the system expected, what was counted, and the variance
-- (also written as a 'count' movement when non-zero). Zero-variance counts are kept
-- so "last counted" is known for every item.
create table public.stock_counts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  item_id uuid not null references public.inventory_items(id) on delete cascade,
  expected_quantity numeric(14, 3) not null,
  counted_quantity numeric(14, 3) not null check (counted_quantity >= 0),
  variance numeric(14, 3) generated always as (counted_quantity - expected_quantity) stored,
  unit_cost_minor bigint not null default 0 check (unit_cost_minor >= 0),
  movement_id bigint references public.stock_movements(id) on delete set null,
  note text check (note is null or length(note) <= 300),
  counted_by text,
  created_at timestamptz not null default now()
);
create index stock_counts_item_idx on public.stock_counts(branch_id, item_id, created_at desc);

-- One open alert per item per branch while it is at or below its reorder level.
-- A new stock.low event is published only when an alert opens (once per breach);
-- the alert resolves when stock rises above the reorder level again.
create table public.stock_alerts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  item_id uuid not null references public.inventory_items(id) on delete cascade,
  status text not null default 'open' check (status in ('open', 'resolved')),
  quantity_at_open numeric(14, 3) not null,
  reorder_level numeric(14, 3) not null,
  opened_at timestamptz not null default now(),
  resolved_at timestamptz,
  check ((status = 'resolved') = (resolved_at is not null))
);
create unique index stock_alerts_one_open on public.stock_alerts(branch_id, item_id) where status = 'open';
create index stock_alerts_org_idx on public.stock_alerts(org_id, status, opened_at desc);

select app.enable_tenant_rls('public.stock_counts', 'branch_id');
select app.enable_tenant_rls('public.stock_alerts', 'branch_id');

select app.lockdown_public_grants();
