// Hot queries for scripts/perf/explain.mjs, written exactly as the API services issue them (parameters included).
// Keep them in step with the services: a query changed in code is changed here in the same commit.
// p = { org_id, user_id, branch_id, order_id, refunded_order_id, today, from30, from365 }.
// `expect` is the regression budget checked with --assert.

const OPEN = ['awaiting_payment', 'placed', 'accepted', 'preparing', 'ready'];

const ordersList = `select o.*, t.label as table_label, (select coalesce(sum(quantity), 0) from order_lines l where l.order_id = o.id) as item_count
         from orders o left join dining_tables t on t.id = o.table_id
        where o.org_id = $1
          and ($2::uuid is null or o.branch_id = $2)
          and ($3::uuid[] is null or o.branch_id = any($3::uuid[]))
          and ($4::text[] is null or o.status::text = any($4::text[]))
          and ($5::text[] is null or o.channel::text = any($5::text[]))
          and ($6::text is null or o.fulfillment::text = $6)
          and ($7::date is null or o.business_date = $7)
          and ($8::timestamptz is null or o.placed_at >= $8)
          and ($9::timestamptz is null or o.placed_at < $9)
          and ($10::uuid is null or o.visit_id = $10)
          and ($11::text is null or o.number = $11)
          and ($12::timestamptz is null or (o.placed_at, o.id) < ($12::timestamptz, $13::uuid))
        order by o.placed_at desc, o.id desc limit $14`;
const ordersParams = (p, { branch = null, statuses = null } = {}) => [p.org_id, branch, null, statuses, null, null, null, null, null, null, null, null, null, 51];

const SCOPED = `scoped as (
  select o.*, (o.placed_at at time zone coalesce(b.timezone, org.timezone)) as local_ts,
         o.status not in ('cancelled', 'awaiting_payment') as counted
    from orders o join branches b on b.id = o.branch_id join organizations org on org.id = o.org_id
   where o.org_id = $1 and ($2::uuid[] is null or o.branch_id = any($2))
     and o.placed_at >= (($3::date - 1)::timestamp at time zone 'UTC') and o.placed_at < (($4::date + 2)::timestamp at time zone 'UTC')
     and (o.placed_at at time zone coalesce(b.timezone, org.timezone))::date between $3::date and $4::date)`;
const REVENUE = `count(*) filter (where counted)::int as orders, coalesce(sum(total_minor - refunded_minor) filter (where counted), 0)::bigint as net,
  coalesce(sum(total_minor) filter (where counted), 0)::bigint as billed`;
const LINE_NET_EX_VAT = `(ol.line_total_minor::numeric
  * case when s.subtotal_minor > 0 then (s.subtotal_minor - s.discount_minor)::numeric / s.subtotal_minor else 1 end
  * case when s.tax_inclusive and (s.subtotal_minor - s.discount_minor + s.service_charge_minor + s.delivery_fee_minor) > 0
         then (s.subtotal_minor - s.discount_minor + s.service_charge_minor + s.delivery_fee_minor - s.tax_minor)::numeric
              / (s.subtotal_minor - s.discount_minor + s.service_charge_minor + s.delivery_fee_minor)
         else 1 end)`;
const products = `with ${SCOPED}
       , sales as (
         select ol.product_id, max(ol.name) as name, max(ol.name_ar) as name_ar, sum(ol.quantity)::int as qty,
                sum(ol.line_total_minor)::bigint as revenue, sum(${LINE_NET_EX_VAT}) as net_ex_vat,
                sum(${LINE_NET_EX_VAT}) filter (where ol.cost_minor is not null) as costed_net,
                sum(ol.cost_minor)::bigint as cost, count(*)::int as lines, count(*) filter (where ol.cost_minor is null)::int as lines_without_cost
           from order_lines ol join scoped s on s.id = ol.order_id
          where s.counted group by ol.product_id)
       select sales.* from sales`;

const CUSTOMERS_FROM = `
      from customers c
      join organizations org on org.id = c.org_id
      left join lateral (
        select count(*) filter (where o.status not in ('cancelled', 'awaiting_payment'))::int as order_count,
               coalesce(sum(o.total_minor - o.refunded_minor) filter (where o.status not in ('cancelled', 'awaiting_payment')), 0)::bigint as spend_minor,
               max(o.placed_at) filter (where o.status not in ('cancelled', 'awaiting_payment')) as last_order_at,
               min(o.placed_at) filter (where o.status not in ('cancelled', 'awaiting_payment')) as first_order_at,
               count(*)::int as any_orders
          from orders o where o.customer_id = c.id and ($2::uuid[] is null or o.branch_id = any($2))
      ) a on true
      where c.org_id = $1 and c.merged_into_id is null and ($11 or c.anonymized_at is null)
        and ($3::text is null or c.display_name ilike '%' || $3 || '%' or c.email::text ilike '%' || $3 || '%'
             or ($4::text is not null and c.phone_e164 like '%' || $4 || '%'))
        and ($5::text is null or $5 = any(c.tags))
        and ($6::boolean is null or c.marketing_consent = $6)
        and ($7::date is null or (a.last_order_at at time zone org.timezone)::date < $7)
        and ($8::date is null or (a.last_order_at at time zone org.timezone)::date >= $8)
        and ($9::int is null or coalesce(a.order_count, 0) >= $9)
        and ($10::bigint is null or coalesce(a.spend_minor, 0) >= $10)
        and (not $12 or a.any_orders > 0 or exists (
              select 1 from reservations r where r.customer_id = c.id and r.branch_id = any($2)))`;
const customerParams = (p, q = null) => [p.org_id, null, q, null, null, null, null, null, null, null, false, false];

export const suite = [
  {
    id: 'Q1', name: 'orders.active, one branch (Orders page, polled 5 s)', sql: ordersList,
    params: (p) => ordersParams(p, { branch: p.branch_id, statuses: OPEN }),
  },
  {
    id: 'Q1b', name: 'orders.active, all branches', sql: ordersList, params: (p) => ordersParams(p, { statuses: OPEN }),
  },
  { id: 'Q2', name: 'orders.all first page', sql: ordersList, params: (p) => ordersParams(p) },
  {
    id: 'Q4', name: 'overview live (open orders, any date)',
    sql: `select status::text as status, count(*)::int as n, min(placed_at) as oldest from orders
        where org_id = $1 and ($2::uuid[] is null or branch_id = any($2)) and status in ('awaiting_payment', 'placed', 'accepted', 'preparing', 'ready')
        group by 1`,
    params: (p) => [p.org_id, null],
  },
  {
    id: 'Q5', name: 'KDS change marker (polled 2 s per screen)',
    sql: `select coalesce((extract(epoch from greatest(
            (select max(o.updated_at) from orders o where o.branch_id = $1 and o.updated_at > now() - interval '2 days'),
            (select max(l.updated_at) from order_lines l join orders o on o.id = l.order_id
              where o.branch_id = $1 and o.status in ('placed', 'accepted', 'preparing', 'ready')))) * 1000000)::bigint, 0)::text as cursor, now() as now`,
    params: (p) => [p.branch_id],
  },
  {
    id: 'Q6', name: 'KDS tickets',
    sql: `select o.id, o.number, o.status, o.fulfillment, o.channel, o.customer_name, o.placed_at, o.accepted_at, o.notes, o.version, t.label as table_label
         from orders o left join dining_tables t on t.id = o.table_id
        where o.branch_id = $1 and o.status in ('placed', 'accepted', 'preparing', 'ready')
          and not (o.status = 'ready' and o.fulfillment = 'delivery' and not exists (
            select 1 from order_lines l where l.order_id = o.id and l.kitchen_status not in ('served', 'cancelled')))
          and ($2::text is null or exists (select 1 from order_lines l where l.order_id = o.id and l.station = $2))
        order by o.placed_at, o.id limit 300`,
    params: (p) => [p.branch_id, null],
  },
  {
    id: 'Q7', name: 'order detail payments (OR across join)',
    sql: `select distinct p.* from payments p left join payment_allocations a on a.payment_id = p.id
        where p.order_id = $1 or a.order_id = $1 order by p.created_at`,
    params: (p) => [p.refunded_order_id ?? p.order_id],
  },
  {
    id: 'Q8', name: 'analytics revenue totals, 30 days',
    sql: `with ${SCOPED} select ${REVENUE} from scoped`, params: (p) => [p.org_id, null, p.from30, p.today],
  },
  {
    id: 'Q8b', name: 'analytics revenue totals, 365 days',
    sql: `with ${SCOPED} select ${REVENUE} from scoped`, params: (p) => [p.org_id, null, p.from365, p.today],
  },
  {
    id: 'Q8c', name: 'analytics daily series, 365 days',
    sql: `with ${SCOPED}, days as (select generate_series($3::date, $4::date, interval '1 day')::date as day)
         select d.day::text as day, count(s.id) filter (where s.counted)::int as orders,
                coalesce(sum(s.total_minor - s.refunded_minor) filter (where s.counted), 0)::bigint as net
           from days d left join scoped s on s.local_ts::date = d.day group by d.day order by d.day`,
    params: (p) => [p.org_id, null, p.from365, p.today],
  },
  { id: 'Q9', name: 'analytics products, 30 days', sql: products, params: (p) => [p.org_id, null, p.from30, p.today] },
  { id: 'Q9b', name: 'analytics products, 365 days', sql: products, params: (p) => [p.org_id, null, p.from365, p.today] },
  {
    id: 'C1', name: 'customers page 1 (sort last order)',
    sql: `select c.*, a.order_count, a.spend_minor, a.last_order_at, a.first_order_at ${CUSTOMERS_FROM}
        order by a.last_order_at desc nulls last, c.id limit 50 offset 0`,
    params: (p) => customerParams(p),
  },
  { id: 'C2', name: 'customers total count', sql: `select count(*)::int as n ${CUSTOMERS_FROM}`, params: (p) => customerParams(p) },
  {
    id: 'M1', name: 'public menu branches',
    sql: `select * from branches where org_id = $1 and is_active order by created_at`, params: (p) => [p.org_id], mode: 'tenant',
  },
  {
    id: 'A1', name: 'admin outbox counters', mode: 'platform',
    sql: `select count(*) filter (where published_at is null)::int as unpublished, min(created_at) filter (where published_at is null) as oldest,
                count(*) filter (where published_at is null and attempts > 0)::int as retrying
           from outbox_events where published_at is null`,
  },
];
