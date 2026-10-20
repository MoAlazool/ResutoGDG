-- Synthetic scale-up for performance measurement (scripts/perf/scale-db.mjs fills in the double-brace parameters).
-- Never run against a shared or production database: scale-db.mjs refuses non-local hosts and protected names.
--
-- Adds, on top of a copy of the demo database:
--   main tenant ({{main_slug}}): {{main_orders}} historical orders over {{days}} days across its branches,
--     {{main_customers}} customers (about 60% of orders carry one), 1-4 lines per order from the real menu,
--     payments + allocations, 4 order events, 5 published outbox events per order;
--   {{noise_orgs}} noise tenants with {{noise_orders}} orders and {{noise_customers}} customers each, so every
--     per-tenant index and RLS predicate runs against a multi-tenant table;
--   {{job_runs}} job_runs rows (sender cadence history).
-- Historical orders are in final states (served / picked_up / delivered, 3% cancelled, 1% partly refunded):
-- like production, open orders are a handful against a large history. Deterministic: setseed({{seed}}).
set session_replication_role = replica; -- no row triggers (updated_at, consent history); rows are FK-consistent by construction
select setseed({{seed}});

create temp table perf_main as
select o.id as org_id, o.timezone, o.currency from organizations o where o.slug = '{{main_slug}}';
do $$ begin if (select count(*) from perf_main) <> 1 then raise exception 'main tenant {{main_slug}} not found'; end if; end $$;

create temp table perf_branches as
select row_number() over (order by b.created_at, b.id) as rn, b.id, b.org_id, coalesce(b.timezone, (select timezone from perf_main)) as tz
  from branches b where b.org_id = (select org_id from perf_main);

create temp table perf_tables as
select row_number() over (partition by t.branch_id order by t.id) as rn, t.branch_id, t.id from dining_tables t
 where t.branch_id in (select id from perf_branches);

create temp table perf_products as
select row_number() over (order by p.sort_order, p.id) as rn, p.id, p.name, p.name_ar, p.price_minor, p.cost_minor, p.station
  from products p where p.org_id = (select org_id from perf_main) and p.is_active and p.price_minor > 0;
do $$ begin if (select count(*) from perf_products) = 0 then raise exception 'main tenant has no priced products'; end if; end $$;

-- Noise tenants -------------------------------------------------------------------------------------------------
insert into organizations (id, slug, name, country, currency, timezone, status)
select gen_random_uuid(), 'perf-tenant-' || g, 'Perf tenant ' || g, 'EG', 'EGP', 'Africa/Cairo', 'active'
  from generate_series(1, {{noise_orgs}}) g
on conflict do nothing;
create temp table perf_noise_orgs as
select row_number() over (order by o.slug) as rn, o.id as org_id from organizations o where o.slug like 'perf-tenant-%' and o.slug ~ '^perf-tenant-[0-9]+$'
   and substring(o.slug from 13)::int <= {{noise_orgs}};
insert into branches (id, org_id, code, name)
select gen_random_uuid(), n.org_id, c, 'Branch ' || c from perf_noise_orgs n cross join unnest(array['a', 'b']) c
on conflict do nothing;

-- Customers -----------------------------------------------------------------------------------------------------
insert into customers (org_id, display_name, phone_e164, locale, marketing_consent, first_seen_at, last_seen_at, created_at)
select (select org_id from perf_main), 'Guest ' || g, '+2019' || lpad(g::text, 8, '0'), case when g % 3 = 0 then 'ar' else 'en' end,
       g % 4 = 0, now() - (g % 400) * interval '1 day', now() - (g % 365) * interval '1 day', now() - (g % 400) * interval '1 day'
  from generate_series(1, {{main_customers}}) g
on conflict do nothing;
insert into customers (org_id, display_name, phone_e164, created_at)
select n.org_id, 'Noise guest ' || g, '+2018' || lpad((n.rn * 100000 + g)::text, 8, '0'), now() - (g % 400) * interval '1 day'
  from perf_noise_orgs n cross join generate_series(1, {{noise_customers}}) g
on conflict do nothing;

create temp table perf_customers as
select c.org_id, row_number() over (partition by c.org_id order by c.id) as rn, c.id, c.display_name, c.phone_e164
  from customers c where c.org_id in (select org_id from perf_main union all select org_id from perf_noise_orgs) and c.merged_into_id is null;
create index on perf_customers (org_id, rn);
analyze perf_customers;
create temp table perf_customer_counts as select org_id, count(*) as n from perf_customers group by 1;
create temp table perf_table_counts as select branch_id, count(*) as n from perf_tables group by 1;

-- Orders --------------------------------------------------------------------------------------------------------
-- One row per synthetic order with its random draws; amounts are filled from the generated lines below.
create temp table perf_orders as
with draws as (
  select g, 'main'::text as kind, (select org_id from perf_main) as org_id, random() as r_branch, random() as r_ful, random() as r_chan,
         random() as r_day, random() as r_hour, random() as r_min, random() as r_cust, random() as r_cancel, random() as r_refund, random() as r_lines,
         random() as r_table, random() as r_disc
    from generate_series(1, {{main_orders}}) g
  union all
  select 10000000 + n.rn * 1000000 + g, 'noise', n.org_id, random(), random(), random(), random(), random(), random(), random(), random(), random(),
         random(), random(), random()
    from perf_noise_orgs n cross join generate_series(1, {{noise_orders}}) g
), shaped as (
  select d.*,
         case when d.kind = 'main' then (select id from perf_branches where rn = case when d.r_branch < 0.7 or (select count(*) from perf_branches) = 1 then 1 else 2 end)
              else (select b.id from branches b where b.org_id = d.org_id and b.code = case when d.r_branch < 0.6 then 'a' else 'b' end) end as branch_id,
         case when d.kind = 'noise' then (case when d.r_ful < 0.7 then 'pickup' else 'delivery' end)
              when d.r_ful < 0.35 then 'dine_in' when d.r_ful < 0.80 then 'pickup' else 'delivery' end::fulfillment_type as fulfillment,
         floor(d.r_day * {{days}})::int as day_offset,
         (array[9,10,11,12,12,13,13,13,14,14,15,16,17,18,19,19,20,20,20,21,21,21,22,22,23])[1 + floor(d.r_hour * 25)::int] as hour
    from draws d
)
select s.*, gen_random_uuid() as id,
       case s.fulfillment when 'dine_in' then (case when s.r_chan < 0.6 then 'qr' else 'staff' end)
                          when 'pickup' then (case when s.r_chan < 0.5 then 'web' else 'staff' end)
                          else (case when s.r_chan < 0.6 then 'web' else 'whatsapp' end) end::order_channel as channel,
       least(((date_trunc('day', now() at time zone 'Africa/Cairo') - s.day_offset * interval '1 day' + s.hour * interval '1 hour'
               + floor(s.r_min * 60) * interval '1 minute') at time zone 'Africa/Cairo'),
             now() - interval '45 minutes' - s.r_min * interval '3 hours') as placed_at,
       s.r_cancel < 0.03 as cancelled,
       s.r_cancel >= 0.03 and s.r_refund < 0.01 as refunded,
       1 + floor(s.r_lines * 4)::int as line_count
  from shaped s;
alter table perf_orders add column customer_id uuid, add column table_id uuid, add column customer_name text, add column customer_phone text,
  add column subtotal bigint, add column cost bigint, add column discount bigint not null default 0, add column delivery_fee bigint not null default 0;
create index on perf_orders (g);

update perf_orders o set customer_id = c.id, customer_name = c.display_name, customer_phone = c.phone_e164
  from perf_customer_counts k, perf_customers c
 where k.org_id = o.org_id and c.org_id = o.org_id
   and (o.fulfillment <> 'dine_in' or o.r_cust < 0.35) and o.r_cust < 0.9
   and c.rn = 1 + floor(o.r_cust * 1000003)::bigint % k.n;
update perf_orders o set table_id = t.id
  from perf_table_counts k, perf_tables t
 where o.fulfillment = 'dine_in' and k.branch_id = o.branch_id and t.branch_id = o.branch_id
   and t.rn = 1 + floor(o.r_table * 1000)::int % k.n;
-- A branch without tables cannot take dine-in orders (check constraint): make those pickup.
update perf_orders set fulfillment = 'pickup', channel = 'staff' where fulfillment = 'dine_in' and table_id is null;

create temp table perf_lines as
select o.id as order_id, o.org_id, o.kind, o.placed_at, o.cancelled, n as line_no,
       p.id as product_id, coalesce(p.name, 'Item ' || (1 + (o.g + n) % 12)) as name, p.name_ar,
       coalesce(p.price_minor, 4500 + ((o.g + n) % 12) * 500) as unit_price_minor, p.cost_minor,
       coalesce(p.station, 'kitchen') as station, 1 + ((o.g * 7 + n) % 3) as quantity
  from perf_orders o
 cross join generate_series(1, 4) n
  left join perf_products p on o.kind = 'main' and p.rn = 1 + ((o.g * 31 + n * 17) % (select count(*) from perf_products))
 where n <= o.line_count;

update perf_orders o set subtotal = l.subtotal, cost = l.cost
  from (select order_id, sum(unit_price_minor * quantity)::bigint as subtotal, sum(cost_minor * quantity)::bigint as cost from perf_lines group by 1) l
 where l.order_id = o.id;
update perf_orders set delivery_fee = 2500 where fulfillment = 'delivery';
update perf_orders set discount = round(subtotal * 0.1) where r_disc < 0.05;

insert into orders (id, org_id, branch_id, number, business_date, public_ref, channel, fulfillment, status, payment_status, table_id, customer_id,
  customer_name, customer_phone, currency, subtotal_minor, discount_minor, delivery_fee_minor, service_charge_minor, tax_minor, tax_inclusive,
  total_minor, paid_minor, refunded_minor, placed_at, accepted_at, ready_at, fulfilled_at, cancelled_at, cancel_reason, version, created_at, updated_at)
select o.id, o.org_id, o.branch_id, 'P' || o.g, (o.placed_at at time zone 'Africa/Cairo')::date, md5('perf-' || o.g),
       o.channel, o.fulfillment,
       case when o.cancelled then 'cancelled' when o.fulfillment = 'dine_in' then 'served' when o.fulfillment = 'delivery' then 'delivered' else 'picked_up' end::order_status,
       case when o.cancelled then 'unpaid' when o.refunded then 'partially_refunded' else 'paid' end::payment_status,
       o.table_id, o.customer_id, o.customer_name, o.customer_phone, 'EGP',
       o.subtotal, o.discount, o.delivery_fee, 0, round((o.subtotal - o.discount + o.delivery_fee) * 14.0 / 114), true,
       o.subtotal - o.discount + o.delivery_fee,
       case when o.cancelled then 0 else o.subtotal - o.discount + o.delivery_fee end,
       case when o.refunded then round((o.subtotal - o.discount) * 0.2) else 0 end,
       o.placed_at, o.placed_at + interval '2 minutes', o.placed_at + interval '18 minutes',
       case when o.cancelled then null else o.placed_at + interval '35 minutes' end,
       case when o.cancelled then o.placed_at + interval '5 minutes' end, case when o.cancelled then 'customer_request' end,
       5, o.placed_at, o.placed_at + interval '35 minutes'
  from perf_orders o;

insert into order_lines (org_id, order_id, product_id, name, name_ar, unit_price_minor, quantity, modifiers, modifiers_total_minor, line_total_minor,
  cost_minor, station, kitchen_status, created_at, updated_at, kitchen_started_at, kitchen_ready_at)
select l.org_id, l.order_id, l.product_id, l.name, l.name_ar, l.unit_price_minor, l.quantity, '[]', 0, l.unit_price_minor * l.quantity, l.cost_minor,
       l.station, case when l.cancelled then 'cancelled' else 'served' end::kitchen_status, l.placed_at, l.placed_at + interval '20 minutes',
       case when l.cancelled then null else l.placed_at + interval '3 minutes' end, case when l.cancelled then null else l.placed_at + interval '17 minutes' end
  from perf_lines l order by l.order_id, l.line_no;

insert into order_events (org_id, order_id, event_type, from_status, to_status, actor_type, created_at)
select o.org_id, o.id, 'status_changed', s.f, case when s.t = 'done' then
         (case when o.cancelled then 'cancelled' when o.fulfillment = 'dine_in' then 'served' when o.fulfillment = 'delivery' then 'delivered' else 'picked_up' end)
         else s.t end, 'user', o.placed_at + s.m * interval '1 minute'
  from perf_orders o cross join (values (null, 'placed', 0), ('placed', 'preparing', 3), ('preparing', 'ready', 18), ('ready', 'done', 35)) s(f, t, m);

create temp table perf_payments as
select gen_random_uuid() as id, o.id as order_id, o.org_id, o.branch_id, o.placed_at, o.refunded,
       o.subtotal - o.discount + o.delivery_fee as amount, case when o.refunded then round((o.subtotal - o.discount) * 0.2) else 0 end as refunded_minor,
       case when o.channel in ('web', 'whatsapp') and o.r_chan < 0.3 then 'card' else 'cash' end::payment_method as method
  from perf_orders o where not o.cancelled and o.subtotal - o.discount + o.delivery_fee > 0;
insert into payments (id, org_id, branch_id, order_id, method, provider, status, amount_minor, refunded_minor, currency, captured_at, created_at, updated_at)
select p.id, p.org_id, p.branch_id, p.order_id, p.method, 'manual', case when p.refunded then 'partially_refunded' else 'succeeded' end::payment_attempt_status,
       p.amount, p.refunded_minor, 'EGP', p.placed_at + interval '30 minutes', p.placed_at + interval '30 minutes', p.placed_at + interval '30 minutes'
  from perf_payments p;
insert into payment_allocations (org_id, payment_id, order_id, amount_minor, kind, created_at)
select p.org_id, p.id, p.order_id, p.amount, 'payment', p.placed_at + interval '30 minutes' from perf_payments p
union all
select p.org_id, p.id, p.order_id, -p.refunded_minor, 'refund', p.placed_at + interval '1 day' from perf_payments p where p.refunded_minor > 0;

insert into outbox_events (org_id, aggregate_type, aggregate_id, event_type, payload, created_at, available_at, published_at, attempts)
select o.org_id, 'order', o.id::text, e, '{}'::jsonb, o.placed_at, o.placed_at, o.placed_at + interval '1 second', 1
  from perf_orders o cross join unnest(array['order.placed', 'order.status_changed', 'order.status_changed', 'order.paid', 'order.status_changed']) e;

insert into job_runs (job, started_at, finished_at, status)
select 'connect.outbound-sender', now() - g * interval '5 seconds', now() - g * interval '5 seconds' + interval '20 milliseconds', 'succeeded'
  from generate_series(1, {{job_runs}}) g;

set session_replication_role = origin;
