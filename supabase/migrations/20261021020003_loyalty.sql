-- FT-03: loyalty. One programme per restaurant (earning rule, rounding, eligibility, exclusions, expiry), a catalogue
-- of rewards redeemed as an order discount by the server pricing engine, and an append-only points ledger.
--
-- Invariants (enforced here and tested in apps/api/test/loyalty.test.ts and supabase/tests/loyalty.test.mjs):
--   * loyalty_ledger rows are never updated or deleted (trigger); corrections are new rows (reverse_*, adjust);
--   * every row carries an idempotency key unique per restaurant, so a redelivered event or a retried checkout
--     cannot earn, redeem or reverse twice;
--   * loyalty_accounts.balance always equals the sum of the customer's ledger points and each row stores the balance
--     after it (rows for one customer are written under the account row lock);
--   * a redemption never takes the balance below zero (checked under the lock and by the check on redeem rows).
--
-- Reversal: drop table public.loyalty_ledger, public.loyalty_accounts, public.loyalty_rewards, public.loyalty_programs;
--   drop function app.loyalty_ledger_append_only();

create table public.loyalty_programs (
  org_id uuid primary key references public.organizations(id) on delete cascade,
  is_active boolean not null default false,
  -- 'spend': points_per_unit points for every unit_minor of eligible spend; 'visit': stamps_per_visit per paid order.
  earn_mode text not null default 'spend' check (earn_mode in ('spend', 'visit')),
  points_per_unit numeric(10, 2) not null default 1 check (points_per_unit >= 0 and points_per_unit <= 1000),
  unit_minor integer not null default 100 check (unit_minor between 1 and 10000000),
  stamps_per_visit integer not null default 1 check (stamps_per_visit between 0 and 100),
  rounding text not null default 'floor' check (rounding in ('floor', 'round', 'ceil')),
  min_order_minor bigint not null default 0 check (min_order_minor >= 0),
  eligible_channels text[],                 -- null = every channel
  eligible_branch_ids uuid[],               -- null = every branch
  excluded_product_ids uuid[] not null default '{}',
  expiry_days integer check (expiry_days is null or expiry_days between 1 and 3650),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

create table public.loyalty_rewards (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (length(name) between 1 and 80),
  name_ar text check (name_ar is null or length(name_ar) between 1 and 80),
  points_cost integer not null check (points_cost between 1 and 1000000),
  kind text not null check (kind in ('fixed', 'percent')),
  value integer not null check (value > 0),     -- minor units (fixed) or basis points (percent)
  max_discount_minor bigint check (max_discount_minor is null or max_discount_minor > 0),
  min_order_minor bigint not null default 0 check (min_order_minor >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  check (kind <> 'percent' or value <= 10000)
);
create index loyalty_rewards_org_idx on public.loyalty_rewards(org_id, is_active);

create table public.loyalty_accounts (
  org_id uuid not null references public.organizations(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  balance integer not null default 0,
  lifetime_earned integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (org_id, customer_id)
);
create index loyalty_accounts_balance_idx on public.loyalty_accounts(org_id, balance desc);

create table public.loyalty_ledger (
  id uuid primary key default gen_random_uuid(),
  -- Write order (rows of one transaction share created_at); balance_after follows this order per customer.
  seq bigint generated always as identity,
  org_id uuid not null references public.organizations(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  kind text not null check (kind in ('earn', 'redeem', 'reverse_earn', 'reverse_redeem', 'expire', 'adjust')),
  points integer not null check (points <> 0),
  balance_after integer not null,
  order_id uuid references public.orders(id) on delete set null,
  payment_id uuid references public.payments(id) on delete set null,
  reward_id uuid references public.loyalty_rewards(id) on delete set null,
  discount_minor bigint,
  reason text check (reason is null or length(reason) between 1 and 300),
  actor text not null,
  idempotency_key text not null,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  check ((kind in ('earn', 'reverse_redeem') and points > 0) or (kind in ('redeem', 'reverse_earn', 'expire') and points < 0) or kind = 'adjust'),
  check (kind <> 'redeem' or balance_after >= 0),
  check (kind <> 'adjust' or reason is not null)
);
create unique index loyalty_ledger_idem_idx on public.loyalty_ledger(org_id, idempotency_key);
create index loyalty_ledger_customer_idx on public.loyalty_ledger(org_id, customer_id, seq desc);
create index loyalty_ledger_order_idx on public.loyalty_ledger(order_id) where order_id is not null;
create index loyalty_ledger_expiry_idx on public.loyalty_ledger(org_id, expires_at) where kind = 'earn' and expires_at is not null;

create or replace function app.loyalty_ledger_append_only() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  -- Direct UPDATE/DELETE statements are refused. Changes made by foreign-key actions (an organisation deleted, a
  -- customer erased, an order removed: depth > 1) are allowed so data-protection erasure still works.
  if pg_trigger_depth() <= 1 then
    raise exception 'loyalty_ledger is append-only (% refused)', tg_op using errcode = 'P0001';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
revoke execute on function app.loyalty_ledger_append_only() from public, anon, authenticated;
create trigger loyalty_ledger_immutable before update or delete on public.loyalty_ledger
  for each row execute function app.loyalty_ledger_append_only();

select app.enable_tenant_rls('public.loyalty_programs');
select app.enable_tenant_rls('public.loyalty_rewards');
select app.enable_tenant_rls('public.loyalty_accounts');
select app.enable_tenant_rls('public.loyalty_ledger');
-- Ledger rows are only ever inserted (by the API under the account lock).
revoke update, delete on public.loyalty_ledger from resuto_member, resuto_tenant;
select app.lockdown_public_grants();
