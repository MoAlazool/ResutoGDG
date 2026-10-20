-- PCL-17: the customers list computed a lateral aggregate over every customer's orders for each page (about 0.5 s
-- at 60k customers / 250k orders) and the total count repeated the work. Order totals per customer are now kept in
-- two read models maintained by triggers on orders, in the same transaction as the order change:
--
--   customer_branch_stats  one row per (customer, branch) the customer ordered in   (branch-scoped staff, ?branchId=)
--   customer_stats         one row per customer, all branches; every customer has one (organization-wide lists)
--
-- Values follow the CRM definition (customers.service.ts): counted orders are confirmed and not cancelled
-- (status not in cancelled, awaiting_payment); spend = sum(total − refunded) of counted orders; last/first = latest /
-- earliest counted placed_at; any_orders counts every order (branch visibility).
--
-- Consistency: app.refresh_customer_stats() locks the customer's customer_stats row first, then recomputes from
-- orders. Under READ COMMITTED every statement takes a fresh snapshot, so a refresh that waited for another
-- transaction's lock sees that transaction's committed orders: concurrent updates of one customer serialise and the
-- result is exact. Only changes that can alter the numbers refresh (status moves across the counted boundary,
-- totals, refunds, customer, branch, placed_at); kitchen progress (placed → preparing → ready → served) does not.
-- Bulk loads that bypass triggers (session_replication_role = replica) must call app.rebuild_customer_stats();
-- the daily job customers.stats-reconcile repairs and reports any drift (app.reconcile_customer_stats()).
--
-- The tables are read-only for the API roles; only the security-definer functions below write them.
-- Reverse: drop trigger orders_customer_stats on orders; drop trigger customers_stats_row on customers;
--          drop table customer_branch_stats, customer_stats; drop function app.refresh_customer_stats(uuid, uuid),
--          app.orders_customer_stats(), app.customers_stats_row(), app.rebuild_customer_stats(uuid),
--          app.reconcile_customer_stats(timestamptz).

create table public.customer_stats (
  customer_id uuid primary key references public.customers(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  order_count integer not null default 0,
  spend_minor bigint not null default 0,
  last_order_at timestamptz,
  first_order_at timestamptz,
  any_orders integer not null default 0,
  updated_at timestamptz not null default now()
);
-- Keyset-ordered lists: newest last order first (customers without counted orders last), highest spend, most orders.
create index customer_stats_last_order_idx on public.customer_stats (org_id, (coalesce(last_order_at, '-infinity'::timestamptz)) desc, customer_id desc);
create index customer_stats_spend_idx on public.customer_stats (org_id, spend_minor desc, customer_id desc);
create index customer_stats_orders_idx on public.customer_stats (org_id, order_count desc, customer_id desc);

create table public.customer_branch_stats (
  customer_id uuid not null references public.customers(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  order_count integer not null default 0,
  spend_minor bigint not null default 0,
  last_order_at timestamptz,
  first_order_at timestamptz,
  any_orders integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (customer_id, branch_id)
);
create index customer_branch_stats_branch_idx on public.customer_branch_stats (branch_id, customer_id);

-- Name and creation-date sorts are driven from customers itself.
create index if not exists customers_org_created_idx on public.customers (org_id, created_at desc, id desc) where merged_into_id is null;
create index if not exists customers_org_name_idx on public.customers (org_id, (display_name is null), (coalesce(lower(display_name), '')), id)
  where merged_into_id is null;

create or replace function app.refresh_customer_stats(p_customer uuid, p_branch uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_org uuid;
begin
  select org_id into v_org from customers where id = p_customer;
  if v_org is null then return; end if; -- customer deleted in this transaction
  insert into customer_stats (customer_id, org_id) values (p_customer, v_org) on conflict (customer_id) do nothing;
  perform 1 from customer_stats where customer_id = p_customer for update;
  if p_branch is not null then
    insert into customer_branch_stats as s (customer_id, branch_id, org_id, order_count, spend_minor, last_order_at, first_order_at, any_orders, updated_at)
    select p_customer, p_branch, v_org,
           count(*) filter (where o.status not in ('cancelled', 'awaiting_payment')),
           coalesce(sum(o.total_minor - o.refunded_minor) filter (where o.status not in ('cancelled', 'awaiting_payment')), 0),
           max(o.placed_at) filter (where o.status not in ('cancelled', 'awaiting_payment')),
           min(o.placed_at) filter (where o.status not in ('cancelled', 'awaiting_payment')),
           count(*), now()
      from orders o where o.customer_id = p_customer and o.branch_id = p_branch
    on conflict (customer_id, branch_id) do update set
      order_count = excluded.order_count, spend_minor = excluded.spend_minor, last_order_at = excluded.last_order_at,
      first_order_at = excluded.first_order_at, any_orders = excluded.any_orders, updated_at = excluded.updated_at;
    delete from customer_branch_stats where customer_id = p_customer and branch_id = p_branch and any_orders = 0;
  end if;
  update customer_stats s set (order_count, spend_minor, last_order_at, first_order_at, any_orders, updated_at) = (
    select coalesce(sum(b.order_count), 0), coalesce(sum(b.spend_minor), 0), max(b.last_order_at), min(b.first_order_at),
           coalesce(sum(b.any_orders), 0), now()
      from customer_branch_stats b where b.customer_id = p_customer)
   where s.customer_id = p_customer;
end $$;

create or replace function app.orders_customer_stats() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'UPDATE'
     and new.customer_id is not distinct from old.customer_id and new.branch_id = old.branch_id and new.placed_at = old.placed_at
     and new.total_minor = old.total_minor and new.refunded_minor = old.refunded_minor
     and (new.status in ('cancelled', 'awaiting_payment')) = (old.status in ('cancelled', 'awaiting_payment')) then
    return null;
  end if;
  if tg_op <> 'INSERT' and old.customer_id is not null then
    perform app.refresh_customer_stats(old.customer_id, old.branch_id);
  end if;
  if tg_op <> 'DELETE' and new.customer_id is not null
     and (tg_op = 'INSERT' or (new.customer_id, new.branch_id) is distinct from (old.customer_id, old.branch_id)) then
    perform app.refresh_customer_stats(new.customer_id, new.branch_id);
  end if;
  return null;
end $$;
create trigger orders_customer_stats
  after insert or delete or update of customer_id, branch_id, status, total_minor, refunded_minor, placed_at on public.orders
  for each row execute function app.orders_customer_stats();

-- Every customer has a customer_stats row, so organization-wide lists can walk the stats indexes.
create or replace function app.customers_stats_row() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into customer_stats (customer_id, org_id) values (new.id, new.org_id) on conflict (customer_id) do nothing;
  return null;
end $$;
create trigger customers_stats_row after insert on public.customers for each row execute function app.customers_stats_row();

/** Recomputes both read models from orders for one organization (null = all). Used after trigger-less bulk loads. */
create or replace function app.rebuild_customer_stats(p_org uuid default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  delete from customer_branch_stats where p_org is null or org_id = p_org;
  insert into customer_branch_stats (customer_id, branch_id, org_id, order_count, spend_minor, last_order_at, first_order_at, any_orders)
  select o.customer_id, o.branch_id, o.org_id,
         count(*) filter (where o.status not in ('cancelled', 'awaiting_payment')),
         coalesce(sum(o.total_minor - o.refunded_minor) filter (where o.status not in ('cancelled', 'awaiting_payment')), 0),
         max(o.placed_at) filter (where o.status not in ('cancelled', 'awaiting_payment')),
         min(o.placed_at) filter (where o.status not in ('cancelled', 'awaiting_payment')),
         count(*)
    from orders o join customers c on c.id = o.customer_id
   where o.customer_id is not null and (p_org is null or o.org_id = p_org)
   group by o.customer_id, o.branch_id, o.org_id;
  insert into customer_stats (customer_id, org_id)
  select c.id, c.org_id from customers c where p_org is null or c.org_id = p_org
  on conflict (customer_id) do nothing;
  update customer_stats s set order_count = coalesce(a.order_count, 0), spend_minor = coalesce(a.spend_minor, 0),
         last_order_at = a.last_order_at, first_order_at = a.first_order_at, any_orders = coalesce(a.any_orders, 0), updated_at = now()
    from customer_stats s2
    left join (select customer_id, sum(order_count)::int as order_count, sum(spend_minor)::bigint as spend_minor, max(last_order_at) as last_order_at,
                      min(first_order_at) as first_order_at, sum(any_orders)::int as any_orders
                 from customer_branch_stats where p_org is null or org_id = p_org group by customer_id) a on a.customer_id = s2.customer_id
   where s.customer_id = s2.customer_id and (p_org is null or s2.org_id = p_org);
end $$;

/**
 * Daily drift check: recomputes the stats of customers whose orders changed since p_since and of rows that no longer
 * match any order, fixes them, and returns how many (customer, branch) rows were wrong. Non-zero means something
 * changed orders without the trigger (a bulk load, manual SQL): the job logs it.
 */
create or replace function app.reconcile_customer_stats(p_since timestamptz) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r record;
  v_drift integer := 0;
begin
  for r in
    with touched as (
      select distinct o.customer_id, o.branch_id from orders o where o.updated_at >= p_since and o.customer_id is not null
    ), expected as (
      select t.customer_id, t.branch_id,
             count(o.id) filter (where o.status not in ('cancelled', 'awaiting_payment'))::int as order_count,
             coalesce(sum(o.total_minor - o.refunded_minor) filter (where o.status not in ('cancelled', 'awaiting_payment')), 0)::bigint as spend_minor,
             max(o.placed_at) filter (where o.status not in ('cancelled', 'awaiting_payment')) as last_order_at,
             count(o.id)::int as any_orders
        from touched t left join orders o on o.customer_id = t.customer_id and o.branch_id = t.branch_id
       group by t.customer_id, t.branch_id
    )
    select e.customer_id, e.branch_id from expected e
      left join customer_branch_stats s on s.customer_id = e.customer_id and s.branch_id = e.branch_id
     where (s.customer_id is null and e.any_orders > 0)
        or (s.customer_id is not null and (s.order_count, s.spend_minor, s.last_order_at, s.any_orders)
                                          is distinct from (e.order_count, e.spend_minor, e.last_order_at, e.any_orders))
    union
    select s.customer_id, s.branch_id from customer_branch_stats s
     where not exists (select 1 from orders o where o.customer_id = s.customer_id and o.branch_id = s.branch_id)
  loop
    perform app.refresh_customer_stats(r.customer_id, r.branch_id);
    v_drift := v_drift + 1;
  end loop;
  return v_drift;
end $$;

select app.enable_tenant_rls('public.customer_stats');
select app.enable_tenant_rls('public.customer_branch_stats', 'branch_id');
revoke insert, update, delete on public.customer_stats, public.customer_branch_stats from resuto_member, resuto_tenant;
revoke execute on function app.refresh_customer_stats(uuid, uuid), app.orders_customer_stats(), app.customers_stats_row(),
  app.rebuild_customer_stats(uuid), app.reconcile_customer_stats(timestamptz) from public, anon, authenticated, resuto_member, resuto_tenant;
select app.lockdown_public_grants();

select app.rebuild_customer_stats(null);
