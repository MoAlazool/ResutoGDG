-- Kernel additions: payment allocations make visit-level (table bill) payments
-- auditable per order, and support deterministic refunds.

create table public.payment_allocations (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.organizations(id) on delete cascade,
  payment_id uuid not null references public.payments(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  amount_minor bigint not null check (amount_minor <> 0),   -- negative rows are refund reversals
  kind text not null default 'payment' check (kind in ('payment', 'refund')),
  created_at timestamptz not null default now()
);
create index payment_allocations_payment_idx on public.payment_allocations(payment_id);
create index payment_allocations_order_idx on public.payment_allocations(order_id);

select app.enable_tenant_rls('public.payment_allocations');

-- Deposit credit from a reservation applied to a visit's bill.
alter table public.visits add column credit_minor bigint not null default 0 check (credit_minor >= 0);
alter table public.visits add column credit_used_minor bigint not null default 0 check (credit_used_minor >= 0);
alter table public.visits add constraint visits_credit_bounds check (credit_used_minor <= credit_minor);

select app.lockdown_public_grants();
