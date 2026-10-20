-- PCL-26: analytics over long ranges re-read every order (and every order line) of the range on each request:
-- 365-day revenue summary about 4.5 s and products about 2.6 s at 250k orders, with on-disk sorts.
--
-- Daily rollups per (branch, local date) now hold the sums those reports need. They are an exact cache, not an
-- estimate:
--   * analytics_days has one row per (branch, local date) with a `stale` flag. A report uses a day's rollup only when
--     the day is not stale AND older than the live window (local today − 3); every other day of the range is read
--     live from orders, so a report always equals the raw computation.
--   * Triggers on orders, order_lines, payment_allocations and payments mark the day stale (upsert) whenever a change
--     can alter its numbers, in the same transaction. Orders placed in the last 48 hours are skipped: their days are
--     inside the live window, which readers never take from rollups.
--   * The leased job analytics.rollup-refresh (every 60 s) adds rows for days that left the live window and
--     recomputes stale days one at a time while holding the day row's lock: a concurrent change waits for the
--     refresh to commit and then marks the day stale again, so a day is never marked fresh for data it did not see.
--   * The daily job analytics.rollup-reconcile rediscovers days across the whole history (e.g. after a timezone
--     change dropped a branch's rollups) and forces the three most recent rolled days to be recomputed.
-- A change of a branch or organization timezone moves every local date, so it drops the affected rollups.
--
-- Deploy: the historical days start stale and are rolled up by the job within minutes (reports stay exact meanwhile).
-- Reverse: drop the four triggers below, then drop table analytics_order_rollups, analytics_payment_rollups,
-- analytics_product_rollups, analytics_days and the app.analytics_* / app.*_analytics_touch functions.

-- Per-branch time ranges (a live day slice of a report, a rollup day refresh, branch-filtered reports): without it the
-- planner intersects the tenant time index with a whole-branch bitmap (about 100k entries per slice at 250k orders).
-- Leads with org_id like every RLS-scoped read (org_id = current org is always part of the predicate).
create index if not exists orders_branch_time_idx on public.orders (org_id, branch_id, placed_at);

create table public.analytics_days (
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  local_date date not null,
  stale boolean not null default true,
  changes bigint not null default 0,   -- changes recorded after the day left the live window (observability)
  rolled_at timestamptz,
  primary key (branch_id, local_date)
);
create index analytics_days_org_idx on public.analytics_days (org_id, local_date);
create index analytics_days_stale_idx on public.analytics_days (local_date) where stale;

-- Grain of the revenue reports: local date × hour × channel × fulfillment (totals, breakdowns, daily series, heatmap).
create table public.analytics_order_rollups (
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  local_date date not null,
  hour smallint not null,
  channel public.order_channel not null,
  fulfillment public.fulfillment_type not null,
  orders integer not null,            -- counted (not cancelled / awaiting_payment)
  cancelled integer not null,
  awaiting_payment integer not null,
  gross bigint not null,              -- total + discount, counted
  discounts bigint not null,
  refunds bigint not null,
  net bigint not null,                -- total − refunded, counted
  vat numeric not null,               -- unrounded Σ tax × (total − refunded) / total, counted (rounded by the report)
  delivery_fees bigint not null,
  service_charge bigint not null,
  paid bigint not null,
  billed bigint not null,
  refunds_on_cancelled bigint not null,
  primary key (branch_id, local_date, hour, channel, fulfillment)
);
create index analytics_order_rollups_org_idx on public.analytics_order_rollups (org_id, local_date);

create table public.analytics_payment_rollups (
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  local_date date not null,
  method public.payment_method not null,
  is_test boolean not null,
  collected bigint not null,
  refunded bigint not null,
  primary key (branch_id, local_date, method, is_test)
);

create table public.analytics_product_rollups (
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  local_date date not null,
  product_id uuid,                    -- null groups lines whose product no longer exists, like the live report
  name text,
  name_ar text,
  qty bigint not null,
  revenue bigint not null,
  net_ex_vat numeric not null,
  costed_net numeric,
  cost bigint,
  lines integer not null,
  lines_without_cost integer not null
);
create index analytics_product_rollups_day_idx on public.analytics_product_rollups (branch_id, local_date);

-- Marks the day an order belongs to stale (skipped inside the 48-hour live window).
create or replace function app.analytics_touch_day(p_org uuid, p_branch uuid, p_placed timestamptz) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_placed is null or p_placed >= now() - interval '48 hours' then return; end if;
  insert into analytics_days as d (org_id, branch_id, local_date, stale, changes)
  select p_org, p_branch, (p_placed at time zone coalesce(b.timezone, o.timezone))::date, true, 1
    from branches b join organizations o on o.id = b.org_id where b.id = p_branch
  on conflict (branch_id, local_date) do update set stale = true, changes = d.changes + 1;
end $$;

create or replace function app.orders_analytics_touch() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'UPDATE' and (new.status, new.total_minor, new.refunded_minor, new.paid_minor, new.discount_minor, new.delivery_fee_minor,
       new.service_charge_minor, new.tax_minor, new.subtotal_minor, new.tax_inclusive, new.channel, new.fulfillment, new.branch_id, new.placed_at)
     is not distinct from (old.status, old.total_minor, old.refunded_minor, old.paid_minor, old.discount_minor, old.delivery_fee_minor,
       old.service_charge_minor, old.tax_minor, old.subtotal_minor, old.tax_inclusive, old.channel, old.fulfillment, old.branch_id, old.placed_at) then
    return null;
  end if;
  if tg_op <> 'INSERT' then perform app.analytics_touch_day(old.org_id, old.branch_id, old.placed_at); end if;
  if tg_op <> 'DELETE' and (tg_op = 'INSERT' or (new.branch_id, new.placed_at) is distinct from (old.branch_id, old.placed_at)) then
    perform app.analytics_touch_day(new.org_id, new.branch_id, new.placed_at);
  end if;
  return null;
end $$;
create trigger orders_analytics_touch
  after insert or delete or update of status, total_minor, refunded_minor, paid_minor, discount_minor, delivery_fee_minor, service_charge_minor,
    tax_minor, subtotal_minor, tax_inclusive, channel, fulfillment, branch_id, placed_at on public.orders
  for each row execute function app.orders_analytics_touch();

-- Lines, allocations and payments touch the day of the order they belong to.
create or replace function app.order_child_analytics_touch() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r record;
begin
  for r in
    select o.org_id, o.branch_id, o.placed_at from orders o
     where o.id in (case when tg_op <> 'INSERT' then old.order_id end, case when tg_op <> 'DELETE' then new.order_id end)
  loop
    perform app.analytics_touch_day(r.org_id, r.branch_id, r.placed_at);
  end loop;
  return null;
end $$;
create trigger order_lines_analytics_touch
  after insert or delete or update of order_id, product_id, name, name_ar, quantity, line_total_minor, cost_minor on public.order_lines
  for each row execute function app.order_child_analytics_touch();
create trigger payment_allocations_analytics_touch
  after insert or delete or update of order_id, payment_id, amount_minor, kind on public.payment_allocations
  for each row execute function app.order_child_analytics_touch();

create or replace function app.payments_analytics_touch() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r record;
begin
  if (new.method, new.is_test) is not distinct from (old.method, old.is_test) then return null; end if;
  for r in select o.org_id, o.branch_id, o.placed_at from payment_allocations a join orders o on o.id = a.order_id where a.payment_id = new.id loop
    perform app.analytics_touch_day(r.org_id, r.branch_id, r.placed_at);
  end loop;
  return null;
end $$;
create trigger payments_analytics_touch after update of method, is_test on public.payments
  for each row execute function app.payments_analytics_touch();

-- Timezone changes move every local date: drop the affected rollups (the daily reconcile rediscovers the days).
create or replace function app.timezone_analytics_reset() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.timezone is not distinct from old.timezone then return null; end if;
  if tg_table_name = 'branches' then
    delete from analytics_days where branch_id = new.id;
    delete from analytics_order_rollups where branch_id = new.id;
    delete from analytics_payment_rollups where branch_id = new.id;
    delete from analytics_product_rollups where branch_id = new.id;
  else
    delete from analytics_days where org_id = new.id;
    delete from analytics_order_rollups where org_id = new.id;
    delete from analytics_payment_rollups where org_id = new.id;
    delete from analytics_product_rollups where org_id = new.id;
  end if;
  return null;
end $$;
create trigger branches_timezone_analytics after update of timezone on public.branches
  for each row execute function app.timezone_analytics_reset();
create trigger organizations_timezone_analytics after update of timezone on public.organizations
  for each row execute function app.timezone_analytics_reset();

-- Rollup rows for the days p_from..p_to of one organization (optionally some branches), from orders: shared by the
-- per-day refresh and the rebuild. Same filters as the live report (analytics.service.ts SCOPED): one index range
-- scan over the period, local dates in each branch's timezone. Callers delete the old rows first.
create or replace function app.analytics_rollup_insert(p_org uuid, p_branches uuid[], p_from date, p_to date) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- The working set lives in a transaction-scoped temp table, analysed so the aggregates get real row estimates.
  if to_regclass('pg_temp.analytics_rollup_orders') is null then
    create temp table analytics_rollup_orders (
      id uuid primary key, branch_id uuid, channel order_channel, fulfillment fulfillment_type, status order_status, subtotal_minor bigint,
      discount_minor bigint, delivery_fee_minor bigint, service_charge_minor bigint, tax_minor bigint, tax_inclusive boolean, total_minor bigint,
      paid_minor bigint, refunded_minor bigint, local_ts timestamp, counted boolean) on commit drop;
  end if;
  truncate analytics_rollup_orders;
  insert into analytics_rollup_orders
  select o.id, o.branch_id, o.channel, o.fulfillment, o.status, o.subtotal_minor, o.discount_minor, o.delivery_fee_minor, o.service_charge_minor,
         o.tax_minor, o.tax_inclusive, o.total_minor, o.paid_minor, o.refunded_minor, (o.placed_at at time zone coalesce(b.timezone, org.timezone)),
         o.status not in ('cancelled', 'awaiting_payment')
    from orders o join branches b on b.id = o.branch_id join organizations org on org.id = o.org_id
   where o.org_id = p_org and (p_branches is null or o.branch_id = any(p_branches))
     and o.placed_at >= ((p_from - 1)::timestamp at time zone 'UTC') and o.placed_at < ((p_to + 2)::timestamp at time zone 'UTC')
     and (o.placed_at at time zone coalesce(b.timezone, org.timezone))::date between p_from and p_to;
  analyze analytics_rollup_orders;

  insert into analytics_order_rollups (org_id, branch_id, local_date, hour, channel, fulfillment, orders, cancelled, awaiting_payment, gross, discounts,
    refunds, net, vat, delivery_fees, service_charge, paid, billed, refunds_on_cancelled)
  select p_org, branch_id, local_ts::date, extract(hour from local_ts)::smallint, channel, fulfillment,
         count(*) filter (where counted), count(*) filter (where status = 'cancelled'), count(*) filter (where status = 'awaiting_payment'),
         coalesce(sum(total_minor + discount_minor) filter (where counted), 0), coalesce(sum(discount_minor) filter (where counted), 0),
         coalesce(sum(refunded_minor) filter (where counted), 0), coalesce(sum(total_minor - refunded_minor) filter (where counted), 0),
         coalesce(sum(case when total_minor > 0 then tax_minor::numeric * (total_minor - refunded_minor) / total_minor else 0 end) filter (where counted), 0),
         coalesce(sum(delivery_fee_minor) filter (where counted), 0), coalesce(sum(service_charge_minor) filter (where counted), 0),
         coalesce(sum(paid_minor - refunded_minor) filter (where counted), 0), coalesce(sum(total_minor) filter (where counted), 0),
         coalesce(sum(refunded_minor) filter (where status = 'cancelled'), 0)
    from analytics_rollup_orders group by branch_id, local_ts::date, extract(hour from local_ts), channel, fulfillment;

  insert into analytics_payment_rollups (org_id, branch_id, local_date, method, is_test, collected, refunded)
  select p_org, s.branch_id, s.local_ts::date, p.method, p.is_test,
         coalesce(sum(pa.amount_minor) filter (where pa.kind = 'payment'), 0), coalesce(-sum(pa.amount_minor) filter (where pa.kind = 'refund'), 0)
    from analytics_rollup_orders s join payment_allocations pa on pa.order_id = s.id join payments p on p.id = pa.payment_id
   where s.counted group by s.branch_id, s.local_ts::date, p.method, p.is_test;

  -- Net line revenue ex VAT exactly as analytics.service.ts LINE_NET_EX_VAT computes it (same numeric operations, so the
  -- sums agree to the last digit): discount spread pro rata, inclusive VAT removed at the order's effective rate.
  insert into analytics_product_rollups (org_id, branch_id, local_date, product_id, name, name_ar, qty, revenue, net_ex_vat, costed_net, cost, lines, lines_without_cost)
  select p_org, x.branch_id, x.local_date, x.product_id, max(x.name), max(x.name_ar), sum(x.quantity), sum(x.line_total_minor), sum(x.net),
         sum(x.net) filter (where x.cost_minor is not null), sum(x.cost_minor), count(*), count(*) filter (where x.cost_minor is null)
    from (
      select s.branch_id, s.local_ts::date as local_date, ol.product_id, ol.name, ol.name_ar, ol.quantity, ol.line_total_minor, ol.cost_minor,
             (ol.line_total_minor::numeric
               * case when s.subtotal_minor > 0 then (s.subtotal_minor - s.discount_minor)::numeric / s.subtotal_minor else 1 end
               * case when s.tax_inclusive and (s.subtotal_minor - s.discount_minor + s.service_charge_minor + s.delivery_fee_minor) > 0
                      then (s.subtotal_minor - s.discount_minor + s.service_charge_minor + s.delivery_fee_minor - s.tax_minor)::numeric
                           / (s.subtotal_minor - s.discount_minor + s.service_charge_minor + s.delivery_fee_minor)
                      else 1 end) as net
        from analytics_rollup_orders s join order_lines ol on ol.order_id = s.id where s.counted) x
   group by x.branch_id, x.local_date, x.product_id;
end $$;

/** Recomputes one day. The caller holds the analytics_days row lock and then clears `stale`. */
create or replace function app.analytics_refresh_day(p_org uuid, p_branch uuid, p_date date) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  delete from analytics_order_rollups where branch_id = p_branch and local_date = p_date;
  delete from analytics_payment_rollups where branch_id = p_branch and local_date = p_date;
  delete from analytics_product_rollups where branch_id = p_branch and local_date = p_date;
  perform app.analytics_rollup_insert(p_org, array[p_branch], p_date, p_date);
end $$;

/**
 * Rebuilds every rollup of one organization (null = all) for the days outside the live window. Used by this migration
 * and after trigger-less bulk loads. Runs as one transaction; concurrent order changes wait on the day rows.
 */
create or replace function app.rebuild_analytics_rollups(p_org uuid default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r record;
begin
  for r in
    select o.id as org_id, min((x.placed_at at time zone coalesce(b.timezone, o.timezone))::date) as first_day,
           max((now() at time zone coalesce(b.timezone, o.timezone))::date) - 4 as last_day
      from organizations o join branches b on b.org_id = o.id join orders x on x.branch_id = b.id
     where p_org is null or o.id = p_org group by o.id
  loop
    delete from analytics_days where org_id = r.org_id;
    delete from analytics_order_rollups where org_id = r.org_id;
    delete from analytics_payment_rollups where org_id = r.org_id;
    delete from analytics_product_rollups where org_id = r.org_id;
    continue when r.first_day > r.last_day;
    -- Days per branch end at that branch's local today − 4 (branches may sit in different timezones).
    insert into analytics_days (org_id, branch_id, local_date, stale, rolled_at)
    select r.org_id, b.id, g.d::date, false, now()
      from branches b join organizations o on o.id = b.org_id
     cross join generate_series(r.first_day, r.last_day, interval '1 day') g(d)
     where b.org_id = r.org_id and g.d::date <= (now() at time zone coalesce(b.timezone, o.timezone))::date - 4;
    perform app.analytics_rollup_insert(r.org_id, null, r.first_day, r.last_day);
    -- Rows for days past a branch's own cutoff are dropped again (only possible across timezones).
    delete from analytics_order_rollups x where x.org_id = r.org_id and not exists (select 1 from analytics_days d where d.branch_id = x.branch_id and d.local_date = x.local_date);
    delete from analytics_payment_rollups x where x.org_id = r.org_id and not exists (select 1 from analytics_days d where d.branch_id = x.branch_id and d.local_date = x.local_date);
    delete from analytics_product_rollups x where x.org_id = r.org_id and not exists (select 1 from analytics_days d where d.branch_id = x.branch_id and d.local_date = x.local_date);
  end loop;
end $$;

/**
 * Adds day rows (stale, never rolled) for days with orders that are now outside the live window and have
 * no row yet. p_lookback bounds the scan (the minute job looks back 10 days; the daily reconcile scans everything).
 */
create or replace function app.analytics_discover_days(p_lookback interval) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  n integer;
begin
  insert into analytics_days (org_id, branch_id, local_date, stale)
  select distinct o.org_id, o.branch_id, (o.placed_at at time zone coalesce(b.timezone, org.timezone))::date, true
    from orders o join branches b on b.id = o.branch_id join organizations org on org.id = o.org_id
   where (p_lookback is null or o.placed_at >= now() - p_lookback) and o.placed_at < now() - interval '3 days'
     and (o.placed_at at time zone coalesce(b.timezone, org.timezone))::date < (now() at time zone coalesce(b.timezone, org.timezone))::date - 3
  on conflict (branch_id, local_date) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

select app.enable_tenant_rls('public.analytics_days', 'branch_id');
select app.enable_tenant_rls('public.analytics_order_rollups', 'branch_id');
select app.enable_tenant_rls('public.analytics_payment_rollups', 'branch_id');
select app.enable_tenant_rls('public.analytics_product_rollups', 'branch_id');
revoke insert, update, delete on public.analytics_days, public.analytics_order_rollups, public.analytics_payment_rollups,
  public.analytics_product_rollups from resuto_member, resuto_tenant;
revoke execute on function app.analytics_touch_day(uuid, uuid, timestamptz), app.orders_analytics_touch(), app.order_child_analytics_touch(),
  app.payments_analytics_touch(), app.timezone_analytics_reset(), app.analytics_rollup_insert(uuid, uuid[], date, date),
  app.analytics_refresh_day(uuid, uuid, date),
  app.rebuild_analytics_rollups(uuid), app.analytics_discover_days(interval)
  from public, anon, authenticated, resuto_member, resuto_tenant;
select app.lockdown_public_grants();

-- No backfill here: the migration only lists the historical days (stale), so it holds the orders table only briefly.
-- analytics.rollup-refresh fills them (200 days a minute); until then those days are read live, as before.
select app.analytics_discover_days(null);
