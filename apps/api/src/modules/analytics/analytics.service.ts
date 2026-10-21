import { Injectable } from '@nestjs/common';
import type { AnalyticsMeta, AnalyticsPeriodQuery, RevenueTotals, RoiInput } from '@resuto/contracts';
import type { paperIndicatorQuery } from '@resuto/contracts';
import { z } from 'zod';
import type { TenantContext } from '../../common/auth/context';
import type { Tx } from '../../common/db/db.service';
import { invalid, notFound } from '../../common/errors/domain-error';
import { InventoryService } from '../inventory/inventory.service';
import { branchScope, int, iso } from './scope';

type Period = { from: string; to: string; branchId?: string };

/**
 * Orders in the period, bucketed by their branch's local date (branch timezone,
 * falling back to the organization timezone). `counted` = confirmed and not
 * cancelled: awaiting_payment orders are not sales yet, cancelled orders are not
 * revenue. Params: $1 org, $2 branch scope (uuid[] | null), $3 from, $4 to.
 */
const SCOPED = `scoped as (
  select o.*, (o.placed_at at time zone coalesce(b.timezone, org.timezone)) as local_ts,
         o.status not in ('cancelled', 'awaiting_payment') as counted
    from orders o join branches b on b.id = o.branch_id join organizations org on org.id = o.org_id
   where o.org_id = $1 and ($2::uuid[] is null or o.branch_id = any($2))
     and o.placed_at >= (($3::date - 1)::timestamp at time zone 'UTC') and o.placed_at < (($4::date + 2)::timestamp at time zone 'UTC')
     and (o.placed_at at time zone coalesce(b.timezone, org.timezone))::date between $3::date and $4::date)`;

/**
 * Net line revenue excluding VAT, after the order discount is spread over lines
 * pro rata: line_total × (1 − discount/subtotal) × (inclusive ? (taxable − tax)/taxable : 1),
 * where taxable = subtotal − discount + service charge + delivery fee (as priced by the kernel).
 */
const LINE_NET_EX_VAT = `(ol.line_total_minor::numeric
  * case when s.subtotal_minor > 0 then (s.subtotal_minor - s.discount_minor)::numeric / s.subtotal_minor else 1 end
  * case when s.tax_inclusive and (s.subtotal_minor - s.discount_minor + s.service_charge_minor + s.delivery_fee_minor) > 0
         then (s.subtotal_minor - s.discount_minor + s.service_charge_minor + s.delivery_fee_minor - s.tax_minor)::numeric
              / (s.subtotal_minor - s.discount_minor + s.service_charge_minor + s.delivery_fee_minor)
         else 1 end)`;

/**
 * Daily rollups (PCL-26, migration 20261020080003). `covered` lists the (branch, local date) days of the period whose
 * rollup rows are exact (not stale) and older than the live window (local today − 3); `scoped_live` holds the orders
 * of every other day of the period, read one (branch, day) slice at a time through orders_branch_time_idx (LATERAL +
 * OFFSET 0 keeps it a per-slice index scan). Reports sum the rollup rows of covered days with the same aggregates
 * computed live for the rest, so the result is identical to a full raw scan (test/analytics-rollups.test.ts). With
 * rollups = false nothing is covered (the raw path). Params: $1 org, $2 branch scope (uuid[] | null), $3 from, $4 to.
 */
const HYBRID = (rollups: boolean) => `covered as (
  select d.branch_id, d.local_date from analytics_days d
    join branches b on b.id = d.branch_id join organizations org on org.id = d.org_id
   where ${rollups ? 'true' : 'false'} and d.org_id = $1 and ($2::uuid[] is null or d.branch_id = any($2))
     and d.local_date between $3::date and $4::date and not d.stale
     and d.local_date < (now() at time zone coalesce(b.timezone, org.timezone))::date - 3)
, live_days as materialized (
  select b.id as branch_id, g.d::date as local_date, coalesce(b.timezone, org.timezone) as tz
    from branches b join organizations org on org.id = b.org_id
   cross join generate_series($3::date, $4::date, interval '1 day') g(d)
   where b.org_id = $1 and ($2::uuid[] is null or b.id = any($2))
     and not exists (select 1 from covered c where c.branch_id = b.id and c.local_date = g.d::date))
, scoped_live as (
  select o.id, o.branch_id, o.channel, o.fulfillment, o.status, o.subtotal_minor, o.discount_minor, o.delivery_fee_minor, o.service_charge_minor,
         o.tax_minor, o.tax_inclusive, o.total_minor, o.paid_minor, o.refunded_minor,
         (o.placed_at at time zone u.tz) as local_ts, o.status not in ('cancelled', 'awaiting_payment') as counted
    from live_days u cross join lateral (
      select o.* from orders o where o.org_id = $1 and o.branch_id = u.branch_id
         and o.placed_at >= (u.local_date::timestamp at time zone u.tz) and o.placed_at < ((u.local_date + 1)::timestamp at time zone u.tz)
      offset 0) o)`;

/** Revenue grain: branch × local date × hour × channel × fulfillment (needs HYBRID). */
const ORDER_GRAIN = `grain as (
  select r.branch_id, r.local_date, r.hour::int as hour, r.channel, r.fulfillment, r.orders, r.cancelled, r.awaiting_payment, r.gross, r.discounts,
         r.refunds, r.net, r.vat, r.delivery_fees, r.service_charge, r.paid, r.billed, r.refunds_on_cancelled
    from analytics_order_rollups r join covered c on c.branch_id = r.branch_id and c.local_date = r.local_date
  union all
  select branch_id, local_ts::date, extract(hour from local_ts)::int, channel, fulfillment,
         count(*) filter (where counted)::int, count(*) filter (where status = 'cancelled')::int, count(*) filter (where status = 'awaiting_payment')::int,
         coalesce(sum(total_minor + discount_minor) filter (where counted), 0)::bigint, coalesce(sum(discount_minor) filter (where counted), 0)::bigint,
         coalesce(sum(refunded_minor) filter (where counted), 0)::bigint, coalesce(sum(total_minor - refunded_minor) filter (where counted), 0)::bigint,
         coalesce(sum(case when total_minor > 0 then tax_minor::numeric * (total_minor - refunded_minor) / total_minor else 0 end) filter (where counted), 0),
         coalesce(sum(delivery_fee_minor) filter (where counted), 0)::bigint, coalesce(sum(service_charge_minor) filter (where counted), 0)::bigint,
         coalesce(sum(paid_minor - refunded_minor) filter (where counted), 0)::bigint, coalesce(sum(total_minor) filter (where counted), 0)::bigint,
         coalesce(sum(refunded_minor) filter (where status = 'cancelled'), 0)::bigint
    from scoped_live group by branch_id, local_ts::date, extract(hour from local_ts), channel, fulfillment)`;

/** Revenue totals over the grain (VAT is summed unrounded and rounded once, exactly as a per-order sum would be). */
const GRAIN_REVENUE = `
  coalesce(sum(orders), 0)::int as orders, coalesce(sum(cancelled), 0)::int as cancelled, coalesce(sum(gross), 0)::bigint as gross,
  coalesce(sum(discounts), 0)::bigint as discounts, coalesce(sum(refunds), 0)::bigint as refunds, coalesce(sum(net), 0)::bigint as net,
  coalesce(round(sum(vat)), 0)::bigint as vat, coalesce(sum(delivery_fees), 0)::bigint as delivery_fees,
  coalesce(sum(service_charge), 0)::bigint as service_charge, coalesce(sum(paid), 0)::bigint as paid, coalesce(sum(billed), 0)::bigint as billed,
  coalesce(sum(refunds_on_cancelled), 0)::bigint as refunds_on_cancelled, coalesce(sum(awaiting_payment), 0)::int as awaiting_payment`;

/** Product sales grain (needs HYBRID): rollup rows of covered days + live line aggregates of counted orders. */
const PRODUCT_GRAIN = `sales_grain as (
  select r.product_id, r.name, r.name_ar, r.qty, r.revenue, r.net_ex_vat, r.costed_net, r.cost, r.lines, r.lines_without_cost
    from analytics_product_rollups r join covered c on c.branch_id = r.branch_id and c.local_date = r.local_date
  union all
  select ol.product_id, max(ol.name), max(ol.name_ar), sum(ol.quantity)::bigint, sum(ol.line_total_minor)::bigint, sum(${LINE_NET_EX_VAT}),
         sum(${LINE_NET_EX_VAT}) filter (where ol.cost_minor is not null), sum(ol.cost_minor)::bigint, count(*)::int,
         count(*) filter (where ol.cost_minor is null)::int
    from order_lines ol join scoped_live s on s.id = ol.order_id where s.counted group by ol.product_id)`;

/** Owner home live tiles: open orders of any date through orders_open_org_idx (PCL-09). Exported for the plan test. */
export const OVERVIEW_LIVE_SQL = `select status::text as status, count(*)::int as n, min(placed_at) as oldest from orders
        where org_id = $1 and ($2::uuid[] is null or branch_id = any($2)) and status in ('awaiting_payment', 'placed', 'accepted', 'preparing', 'ready')
        group by 1`;

const REVENUE_METHOD =
  'Orders are bucketed by local date in each branch\'s timezone. Counted orders exclude cancelled and awaiting-payment orders. ' +
  'Gross = billed total + discounts; net = billed total − refunds (VAT inclusive); VAT = order VAT reduced pro rata by refunds; ' +
  'net ex-VAT = net − VAT; average order value = round(billed total ÷ counted orders). Refunds are attributed to the order\'s placement date.';

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 10000) / 100 : null);
const change = (cur: number, prev: number) => (prev !== 0 ? Math.round(((cur - prev) / Math.abs(prev)) * 10000) / 100 : null);
const minutes = (v: unknown) => (v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10);

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

/** Deterministic analytics over tenant data. Never estimates; hypothetical results are only produced by roi(). */
@Injectable()
export class AnalyticsService {
  constructor(private readonly inventory: InventoryService) {}

  private async context(tx: Tx, ctx: TenantContext, branchId?: string) {
    const scope = branchScope(ctx, branchId);
    const org = await tx.one<{ timezone: string; currency: string }>(`select timezone, currency from organizations where id = $1`, [ctx.orgId]);
    let tz = org.timezone;
    if (branchId) {
      const branch = await tx.maybeOne<{ tz: string }>(`select coalesce(timezone, $2) as tz from branches where id = $1 and org_id = $3`, [branchId, org.timezone, ctx.orgId]);
      if (!branch) throw notFound('Branch');
      tz = branch.tz;
    }
    return { scope, tz, currency: org.currency, orgTimezone: org.timezone };
  }

  private meta(tz: string, method: string, dataCoverage: AnalyticsMeta['dataCoverage'], assumptions: AnalyticsMeta['assumptions'] = [], kind: AnalyticsMeta['kind'] = 'measured'): AnalyticsMeta {
    return { method, assumptions, dataCoverage, kind, timezone: tz, generatedAt: new Date().toISOString() };
  }

  private mapRevenue(r: any): RevenueTotals {
    const orders = r.orders ?? 0;
    const net = int(r.net);
    const vat = int(r.vat);
    return {
      orders, cancelledOrders: r.cancelled ?? 0, grossMinor: int(r.gross), discountsMinor: int(r.discounts), refundsMinor: int(r.refunds),
      netMinor: net, vatMinor: vat, netExVatMinor: net - vat, deliveryFeesMinor: int(r.delivery_fees), serviceChargeMinor: int(r.service_charge),
      paidMinor: int(r.paid), averageOrderMinor: orders ? Math.round(int(r.billed) / orders) : 0,
    };
  }

  private async revenue(tx: Tx, orgId: string, scope: string[] | null, p: Period, rollups = true) {
    return tx.one(`with ${HYBRID(rollups)}, ${ORDER_GRAIN} select ${GRAIN_REVENUE} from grain`, [orgId, scope, p.from, p.to]);
  }

  // -------------------------------------------------------------------------
  // Revenue summary, breakdowns, trend, heatmap
  // -------------------------------------------------------------------------
  /** `opts.rollups = false` reads every day live (tests compare both paths; the API always uses rollups). */
  async summary(tx: Tx, ctx: TenantContext, q: AnalyticsPeriodQuery, opts: { rollups?: boolean } = {}) {
    const rollups = opts.rollups ?? true;
    const { scope, tz, currency } = await this.context(tx, ctx, q.branchId);
    const params = [ctx.orgId, scope, q.from, q.to];
    // One statement: the grain is built once (a CTE used by every part is materialised) and each part of the report is
    // an aggregate over it, instead of rebuilding the period for every breakdown.
    const report = await tx.one<any>(
      `with ${HYBRID(rollups)}, ${ORDER_GRAIN}
       , pay as (
           select r.method, r.is_test, r.collected, r.refunded
             from analytics_payment_rollups r join covered c on c.branch_id = r.branch_id and c.local_date = r.local_date
           union all
           select p.method, p.is_test, coalesce(sum(pa.amount_minor) filter (where pa.kind = 'payment'), 0)::bigint,
                  coalesce(-sum(pa.amount_minor) filter (where pa.kind = 'refund'), 0)::bigint
             from payment_allocations pa join payments p on p.id = pa.payment_id join scoped_live s on s.id = pa.order_id
            where s.counted group by 1, 2)
       , by_branch as (
           select g.key, bb.name as label, g.orders, g.net, g.billed from (
             select branch_id as key, coalesce(sum(orders), 0)::int as orders, coalesce(sum(net), 0)::bigint as net,
                    coalesce(sum(billed), 0)::bigint as billed
               from grain group by 1) g join branches bb on bb.id = g.key)
       , by_channel as (
           select channel::text as key, null::text as label, coalesce(sum(orders), 0)::int as orders, coalesce(sum(net), 0)::bigint as net,
                  coalesce(sum(billed), 0)::bigint as billed from grain group by 1, 2)
       , by_fulfillment as (
           select fulfillment::text as key, null::text as label, coalesce(sum(orders), 0)::int as orders, coalesce(sum(net), 0)::bigint as net,
                  coalesce(sum(billed), 0)::bigint as billed from grain group by 1, 2)
       , payments as (
           select method::text as method, is_test, sum(collected)::bigint as collected, sum(refunded)::bigint as refunded from pay group by 1, 2)
       , daily as (
           select d.day::date::text as day, coalesce(sum(g.orders), 0)::int as orders, coalesce(sum(g.net), 0)::bigint as net
             from generate_series($3::date, $4::date, interval '1 day') d(day) left join grain g on g.local_date = d.day::date group by d.day)
       , heat as (
           select extract(isodow from local_date)::int as dow, hour, coalesce(sum(orders), 0)::int as orders, coalesce(sum(net), 0)::bigint as net
             from grain group by 1, 2 having sum(orders) > 0)
       select (select row_to_json(t) from (select ${GRAIN_REVENUE} from grain) t) as totals,
              coalesce((select json_agg(b order by b.net desc) from by_branch b), '[]') as by_branch,
              coalesce((select json_agg(b order by b.net desc) from by_channel b), '[]') as by_channel,
              coalesce((select json_agg(b order by b.net desc) from by_fulfillment b), '[]') as by_fulfillment,
              coalesce((select json_agg(p order by p.collected desc) from payments p), '[]') as payments,
              coalesce((select json_agg(d order by d.day) from daily d), '[]') as daily,
              coalesce((select json_agg(h order by h.dow, h.hour) from heat h), '[]') as heat`, params);
    const cur = report.totals;
    const totals = this.mapRevenue(cur);
    let comparison = null;
    if (q.compare === 'previous') {
      const n = daysBetween(q.from, q.to);
      const prevPeriod = { from: addDays(q.from, -n), to: addDays(q.from, -1) };
      const prev = this.mapRevenue(await this.revenue(tx, ctx.orgId, scope, prevPeriod, rollups));
      comparison = {
        ...prevPeriod, totals: prev,
        changePct: {
          orders: change(totals.orders, prev.orders), netMinor: change(totals.netMinor, prev.netMinor),
          netExVatMinor: change(totals.netExVatMinor, prev.netExVatMinor), averageOrderMinor: change(totals.averageOrderMinor, prev.averageOrderMinor),
          refundsMinor: change(totals.refundsMinor, prev.refundsMinor),
        },
      };
    }
    const mapBreakdown = (rows: any[]) => rows.map((r) => ({ key: r.key, label: r.label, orders: r.orders, netMinor: int(r.net),
      averageOrderMinor: r.orders ? Math.round(int(r.billed) / r.orders) : 0, sharePct: pct(int(r.net), totals.netMinor) }));
    const { by_branch: byBranch, by_channel: byChannel, by_fulfillment: byFulfillment, payments, daily, heat } = report as Record<string, any[]>;
    const realPayments = payments.filter((p) => !p.is_test);
    const testPayments = payments.filter((p) => p.is_test);
    return {
      from: q.from, to: q.to, branchId: q.branchId ?? null, currency, totals, comparison,
      byBranch: mapBreakdown(byBranch), byChannel: mapBreakdown(byChannel), byFulfillment: mapBreakdown(byFulfillment),
      byPaymentMethod: realPayments.map((p) => ({ method: p.method, collectedMinor: int(p.collected), refundedMinor: int(p.refunded),
        netMinor: int(p.collected) - int(p.refunded) })),
      daily: daily.map((d) => ({ date: d.day, orders: d.orders, netMinor: int(d.net) })),
      heatmap: heat.map((h) => ({ isoDow: h.dow, hour: h.hour, orders: h.orders, netMinor: int(h.net) })),
      meta: this.meta(tz, `${REVENUE_METHOD} Payment mix sums per-order payment allocations (refund reversals subtract); test/sandbox payments are excluded. Heatmap uses ISO weekday (1 = Monday) and local hour.`, {
        cancelledOrders: totals.cancelledOrders, awaitingPaymentOrders: cur.awaiting_payment,
        refundsOnCancelledOrdersMinor: int(cur.refunds_on_cancelled),
        excludedTestPaymentsMinor: testPayments.reduce((a, p) => a + int(p.collected), 0),
        unpaidOrPartiallyPaidMinor: Math.max(0, totals.netMinor - totals.paidMinor),
        perBranchTimezones: !q.branchId,
      }),
    };
  }

  // -------------------------------------------------------------------------
  // Products: top, underperforming, margins
  // -------------------------------------------------------------------------
  async products(tx: Tx, ctx: TenantContext, q: AnalyticsPeriodQuery, opts: { rollups?: boolean } = {}) {
    const { scope, tz, currency } = await this.context(tx, ctx, q.branchId);
    const params = [ctx.orgId, scope, q.from, q.to];
    const rows = await tx.query(
      `with ${HYBRID(opts.rollups ?? true)}, ${PRODUCT_GRAIN}
       , sales as (
         select product_id, max(name) as name, max(name_ar) as name_ar, sum(qty)::int as qty, sum(revenue)::bigint as revenue,
                sum(net_ex_vat) as net_ex_vat, sum(costed_net) as costed_net, sum(cost)::bigint as cost, sum(lines)::int as lines,
                sum(lines_without_cost)::int as lines_without_cost
           from sales_grain group by product_id)
       select coalesce(sales.product_id, p.id) as product_id, coalesce(p.name, sales.name) as name, coalesce(p.name_ar, sales.name_ar) as name_ar,
              p.is_active, coalesce(sales.qty, 0) as qty, coalesce(sales.revenue, 0) as revenue, coalesce(round(sales.net_ex_vat), 0)::bigint as net_ex_vat,
              round(sales.costed_net)::bigint as costed_net, sales.cost, coalesce(sales.lines, 0) as lines, coalesce(sales.lines_without_cost, 0) as lines_without_cost
         from sales full join (select id, name, name_ar, is_active from products where org_id = $1 and is_active) p on p.id = sales.product_id`, params);
    const products = rows.map((r) => {
      const lines = r.lines;
      const without = r.lines_without_cost;
      const costData: 'complete' | 'partial' | 'none' | 'no_sales' = lines === 0 ? 'no_sales' : without === 0 ? 'complete' : without === lines ? 'none' : 'partial';
      const costedNet = r.costed_net === null ? null : int(r.costed_net);
      const cost = r.cost === null ? null : int(r.cost);
      const margin = costedNet !== null && cost !== null && costData !== 'none' ? costedNet - cost : null;
      return {
        productId: r.product_id, name: r.name, nameAr: r.name_ar, active: !!r.is_active, quantity: int(r.qty), revenueMinor: int(r.revenue),
        netExVatMinor: int(r.net_ex_vat), costData, costMinor: costData === 'none' ? null : cost,
        grossMarginMinor: margin, marginPct: margin !== null && costedNet ? pct(margin, costedNet) : null,
      };
    });
    const sold = products.filter((p) => p.quantity > 0);
    const byRevenue = [...sold].sort((a, b) => b.revenueMinor - a.revenueMinor || b.quantity - a.quantity);
    const byQty = [...sold].sort((a, b) => b.quantity - a.quantity || b.revenueMinor - a.revenueMinor);
    const under = products.filter((p) => p.active).sort((a, b) => a.revenueMinor - b.revenueMinor || a.quantity - b.quantity || a.name.localeCompare(b.name));
    const totalNet = sold.reduce((a, p) => a + p.netExVatMinor, 0);
    const costedNet = rows.reduce((a, r) => a + (r.costed_net === null ? 0 : int(r.costed_net)), 0);
    const totalCost = rows.reduce((a, r) => a + (r.cost === null ? 0 : int(r.cost)), 0);
    const lines = rows.reduce((a, r) => a + r.lines, 0);
    const linesWithout = rows.reduce((a, r) => a + r.lines_without_cost, 0);
    const marginMinor = costedNet - totalCost;
    return {
      from: q.from, to: q.to, branchId: q.branchId ?? null, currency,
      top: byRevenue.slice(0, 10), topByQuantity: byQty.slice(0, 10), underperforming: under.slice(0, 10), all: products,
      grossMargin: {
        netExVatMinor: totalNet, costedNetExVatMinor: costedNet, costMinor: totalCost,
        grossMarginMinor: lines - linesWithout > 0 ? marginMinor : null, marginPct: lines - linesWithout > 0 ? pct(marginMinor, costedNet) : null,
        costCoveragePct: pct(costedNet, totalNet),
      },
      meta: this.meta(tz, 'Line revenue from counted orders. Net ex-VAT spreads each order discount over its lines pro rata and removes inclusive VAT at the order\'s effective rate. Cost is the product cost snapshot stored on each line at order time (products.cost_minor); lines without a snapshot are excluded from margin and flagged. Underperforming = active products with the lowest revenue in the period, including products that did not sell.', {
        orderLines: lines, orderLinesWithoutCost: linesWithout, costCoverageByRevenuePct: pct(costedNet, totalNet),
        productsWithoutCostData: products.filter((p) => p.costData === 'none').length,
        productsNotSold: products.filter((p) => p.active && p.quantity === 0).length,
      }),
    };
  }

  // -------------------------------------------------------------------------
  // Customers: new vs returning, repeat rate, monthly retention cohorts
  // -------------------------------------------------------------------------
  async customers(tx: Tx, ctx: TenantContext, q: AnalyticsPeriodQuery) {
    const { scope, tz } = await this.context(tx, ctx, q.branchId);
    const params = [ctx.orgId, scope, q.from, q.to];
    const firstOrders = `firsts as (
      select distinct on (o.customer_id) o.customer_id, (o.placed_at at time zone coalesce(b.timezone, org.timezone))::date as first_day
        from orders o join branches b on b.id = o.branch_id join organizations org on org.id = o.org_id
       where o.org_id = $1 and ($2::uuid[] is null or o.branch_id = any($2)) and o.customer_id is not null
         and o.status not in ('cancelled', 'awaiting_payment')
       order by o.customer_id, o.placed_at)`;
    const agg = await tx.one(
      `with ${SCOPED}, ${firstOrders}
       , cust as (select customer_id, count(*)::int as n, sum(total_minor - refunded_minor)::bigint as net from scoped where counted and customer_id is not null group by 1)
       select count(*)::int as customers,
              count(*) filter (where f.first_day >= $3::date)::int as new_customers,
              count(*) filter (where f.first_day < $3::date)::int as returning_customers,
              count(*) filter (where c.n >= 2)::int as repeat_customers,
              coalesce(sum(c.net) filter (where f.first_day >= $3::date), 0)::bigint as new_net,
              coalesce(sum(c.net) filter (where f.first_day < $3::date), 0)::bigint as returning_net,
              (select count(*) from scoped where counted and customer_id is null)::int as anonymous_orders,
              (select count(*) from scoped where counted)::int as orders
         from cust c join firsts f using (customer_id)`, params);
    // Cohorts: customers whose first counted order falls in the period, by local month; activity through the period end.
    const cohorts = await tx.query(
      `with ${firstOrders}
       , members as (select customer_id, date_trunc('month', first_day)::date as cohort from firsts where first_day between $3::date and $4::date)
       , activity as (
         select distinct m.cohort, m.customer_id,
                ((extract(year from lt) - extract(year from m.cohort)) * 12 + extract(month from lt) - extract(month from m.cohort))::int as offset_month
           from members m join orders o on o.customer_id = m.customer_id
           join branches b on b.id = o.branch_id join organizations org on org.id = o.org_id
           cross join lateral (select (o.placed_at at time zone coalesce(b.timezone, org.timezone)) as lt) x
          where o.status not in ('cancelled', 'awaiting_payment') and ($2::uuid[] is null or o.branch_id = any($2))
            and (o.placed_at at time zone coalesce(b.timezone, org.timezone))::date <= $4::date)
       select to_char(cohort, 'YYYY-MM') as cohort, offset_month, count(distinct customer_id)::int as customers
         from activity group by cohort, offset_month order by cohort, offset_month`, params);
    const byCohort = new Map<string, number[]>();
    for (const r of cohorts) {
      const arr = byCohort.get(r.cohort) ?? [];
      arr[r.offset_month] = r.customers;
      byCohort.set(r.cohort, arr);
    }
    const cohortRows = [...byCohort.entries()].map(([cohort, arr]) => {
      const size = arr[0] ?? 0;
      const months = Array.from({ length: arr.length }, (_, i) => arr[i] ?? 0);
      return { cohort, size, active: months, retentionPct: months.map((m) => pct(m, size)) };
    });
    return {
      from: q.from, to: q.to, branchId: q.branchId ?? null,
      customers: agg.customers, newCustomers: agg.new_customers, returningCustomers: agg.returning_customers,
      repeatCustomers: agg.repeat_customers, repeatRatePct: pct(agg.repeat_customers, agg.customers),
      newCustomerNetMinor: int(agg.new_net), returningCustomerNetMinor: int(agg.returning_net),
      cohorts: cohortRows,
      meta: this.meta(tz, 'Customers = distinct identified customers with at least one counted order in the period. New = first counted order ever (within the branches in scope) falls in the period; returning = first order before the period. Repeat rate = customers with 2+ counted orders in the period ÷ customers. Cohorts group customers by the local month of their first counted order (only first orders inside the period) and count how many ordered again in each later month up to the period end. Orders without an identified customer cannot be attributed and are reported in dataCoverage.', {
        countedOrders: agg.orders, ordersWithoutCustomer: agg.anonymous_orders,
        identifiedOrderSharePct: pct(agg.orders - agg.anonymous_orders, agg.orders),
      }),
    };
  }

  // -------------------------------------------------------------------------
  // Marketing: attributed orders and costs (non-sandbox only)
  // -------------------------------------------------------------------------
  async marketing(tx: Tx, ctx: TenantContext, q: AnalyticsPeriodQuery) {
    const { scope, tz, currency } = await this.context(tx, ctx, q.branchId);
    const params = [ctx.orgId, scope, q.from, q.to];
    const campaigns = await tx.query(
      `with ${SCOPED} select c.id, c.name, c.channel, c.is_sandbox, count(*)::int as orders,
              coalesce(sum(s.total_minor - s.refunded_minor), 0)::bigint as net,
              coalesce(round(sum(s.total_minor - s.refunded_minor - case when s.total_minor > 0 then s.tax_minor::numeric * (s.total_minor - s.refunded_minor) / s.total_minor else 0 end)), 0)::bigint as net_ex_vat
         from scoped s join campaigns c on c.id = s.campaign_id where s.counted group by c.id order by net desc`, params);
    const orgWide = scope === null;
    const ads = orgWide ? await tx.query(
      `select is_sandbox, currency::text as currency, coalesce(sum(spend_minor), 0)::bigint as spend, coalesce(sum(clicks), 0)::bigint as clicks,
              coalesce(sum(impressions), 0)::bigint as impressions, count(*)::int as rows
         from ad_campaign_reports where org_id = $1 and report_date between $2::date and $3::date group by 1, 2`, [ctx.orgId, q.from, q.to]) : [];
    const expenses = await tx.one(
      `select coalesce(sum(e.amount_minor) filter (where e.currency::text = $5), 0)::bigint as amount, count(*)::int as rows,
              count(*) filter (where e.currency::text <> $5)::int as other_currency
         from expenses e join expense_categories ec on ec.id = e.category_id
        where e.org_id = $1 and ec.kind = 'marketing' and e.incurred_on between $3::date and $4::date
          and (($2::uuid[] is null) or e.branch_id = any($2))`, [ctx.orgId, scope, q.from, q.to, currency]);
    const real = campaigns.filter((c) => !c.is_sandbox);
    const sandbox = campaigns.filter((c) => c.is_sandbox);
    const adSpend = ads.filter((a) => !a.is_sandbox && a.currency === currency).reduce((s, a) => s + int(a.spend), 0);
    const attributedNet = real.reduce((s, c) => s + int(c.net), 0);
    const marketingCost = adSpend + int(expenses.amount);
    return {
      from: q.from, to: q.to, branchId: q.branchId ?? null, currency,
      attributed: {
        orders: real.reduce((s, c) => s + c.orders, 0), netMinor: attributedNet, netExVatMinor: real.reduce((s, c) => s + int(c.net_ex_vat), 0),
        campaigns: real.map((c) => ({ campaignId: c.id, name: c.name, channel: c.channel, orders: c.orders, netMinor: int(c.net), netExVatMinor: int(c.net_ex_vat) })),
      },
      costs: { adSpendMinor: adSpend, marketingExpensesMinor: int(expenses.amount), totalMinor: marketingCost,
        clicks: ads.filter((a) => !a.is_sandbox).reduce((s, a) => s + int(a.clicks), 0),
        impressions: ads.filter((a) => !a.is_sandbox).reduce((s, a) => s + int(a.impressions), 0) },
      returnOnSpend: marketingCost > 0 ? Math.round((attributedNet / marketingCost) * 100) / 100 : null,
      meta: this.meta(tz, 'Attributed = counted orders carrying a campaign id (orders.campaign_id) from campaigns that are not sandbox. This is attributed revenue, not proven incremental revenue: some of these guests would have ordered anyway. Costs = non-sandbox ad-platform spend (report date in the period, organization currency only) + expenses in marketing categories. Return on spend = attributed net revenue ÷ marketing cost. Ad spend is organization-level and is only included when no branch filter applies.', {
        excludedSandboxCampaignOrders: sandbox.reduce((s, c) => s + c.orders, 0),
        excludedSandboxCampaignNetMinor: sandbox.reduce((s, c) => s + int(c.net), 0),
        excludedSandboxAdSpendMinor: ads.filter((a) => a.is_sandbox).reduce((s, a) => s + int(a.spend), 0),
        adReportRowsInOtherCurrency: ads.filter((a) => !a.is_sandbox && a.currency !== currency).reduce((s, a) => s + a.rows, 0),
        expensesInOtherCurrency: expenses.other_currency,
        adSpendIncluded: orgWide,
      }),
    };
  }

  // -------------------------------------------------------------------------
  // Operations: kitchen and delivery performance
  // -------------------------------------------------------------------------
  async operations(tx: Tx, ctx: TenantContext, q: AnalyticsPeriodQuery) {
    const { scope, tz } = await this.context(tx, ctx, q.branchId);
    const params = [ctx.orgId, scope, q.from, q.to];
    const kitchen = await tx.one(
      `with ${SCOPED}, k as (select extract(epoch from ready_at - placed_at) / 60 as m, extract(epoch from accepted_at - placed_at) / 60 as a from scoped where counted)
       select count(m)::int as n, avg(m) as avg, percentile_cont(0.5) within group (order by m) as p50,
              percentile_cont(0.9) within group (order by m) as p90, count(a)::int as accepted_n, avg(a) as accept_avg,
              (select count(*) from scoped where counted)::int as orders from k`, params);
    const delivery = await tx.one(
      `with ${SCOPED}, j as (
         select d.status, extract(epoch from d.assigned_at - d.created_at) / 60 as assign_m,
                extract(epoch from d.delivered_at - d.picked_up_at) / 60 as transit_m,
                d.delivered_at, d.eta_at
           from delivery_jobs d join scoped s on s.id = d.order_id)
       select count(*)::int as jobs,
              count(*) filter (where status = 'delivered')::int as delivered, count(*) filter (where status = 'failed')::int as failed,
              count(*) filter (where status = 'cancelled')::int as cancelled,
              count(assign_m)::int as assigned_n, avg(assign_m) as assign_avg, percentile_cont(0.5) within group (order by assign_m) as assign_p50,
              count(transit_m)::int as transit_n, avg(transit_m) as transit_avg, percentile_cont(0.5) within group (order by transit_m) as transit_p50,
              count(*) filter (where status = 'delivered' and eta_at is not null)::int as with_eta,
              count(*) filter (where status = 'delivered' and eta_at is not null and delivered_at <= eta_at)::int as on_time
         from j`, params);
    return {
      from: q.from, to: q.to, branchId: q.branchId ?? null,
      kitchen: { ordersMeasured: kitchen.n, placedToReadyAvgMinutes: minutes(kitchen.avg), placedToReadyP50Minutes: minutes(kitchen.p50),
        placedToReadyP90Minutes: minutes(kitchen.p90), placedToAcceptedAvgMinutes: minutes(kitchen.accept_avg) },
      delivery: {
        jobs: delivery.jobs, delivered: delivery.delivered, failed: delivery.failed, cancelled: delivery.cancelled,
        failureRatePct: pct(delivery.failed, delivery.delivered + delivery.failed),
        assignmentAvgMinutes: minutes(delivery.assign_avg), assignmentP50Minutes: minutes(delivery.assign_p50),
        pickupToDeliveredAvgMinutes: minutes(delivery.transit_avg), pickupToDeliveredP50Minutes: minutes(delivery.transit_p50),
        onTimePct: pct(delivery.on_time, delivery.with_eta), onTimeMeasured: delivery.with_eta,
      },
      meta: this.meta(tz, 'Kitchen time = ready_at − placed_at for counted orders that reached ready. Delivery jobs belong to orders placed in the period: assignment = assigned_at − job created; pickup→delivered = delivered_at − picked_up_at; on time = delivered at or before the ETA shown (only jobs that had an ETA); failure rate = failed ÷ (delivered + failed). Medians and 90th percentiles are continuous percentiles.', {
        countedOrders: kitchen.orders, ordersWithoutReadyTime: kitchen.orders - kitchen.n, deliveryJobs: delivery.jobs,
        jobsWithoutAssignmentTime: delivery.jobs - delivery.assigned_n, deliveredWithoutEta: delivery.delivered - delivery.with_eta,
      }),
    };
  }

  // -------------------------------------------------------------------------
  // Sustainability: measured food waste value and paper-avoidance indicator
  // -------------------------------------------------------------------------
  async sustainability(tx: Tx, ctx: TenantContext, q: z.infer<typeof paperIndicatorQuery>) {
    const { scope, tz } = await this.context(tx, ctx, q.branchId);
    const params = [ctx.orgId, scope, q.from, q.to];
    const waste = await this.inventory.wasteReport(tx, ctx, { from: q.from, to: q.to, branchId: q.branchId });
    const digital = await tx.one(
      `with ${SCOPED} select count(*) filter (where counted and channel in ('qr', 'web', 'whatsapp', 'mcp'))::int as digital_orders,
              count(*) filter (where counted and channel = 'qr')::int as qr_orders,
              count(*) filter (where counted)::int as orders,
              count(distinct visit_id) filter (where channel = 'qr' and visit_id is not null)::int as qr_visits
         from scoped`, params);
    const receipts = await tx.one(
      `select count(*)::int as n from fiscal_documents f join branches b on b.id = f.branch_id join organizations org on org.id = f.org_id
        where f.org_id = $1 and ($2::uuid[] is null or f.branch_id = any($2))
          and (f.issued_at at time zone coalesce(b.timezone, org.timezone))::date between $3::date and $4::date`, params);
    const sheets = digital.digital_orders + receipts.n;
    const assumptions: AnalyticsMeta['assumptions'] = [];
    let estimatedPaperGrams: number | null = null;
    if (q.gramsPerSheet !== undefined) {
      assumptions.push({ key: 'gramsPerSheet', value: q.gramsPerSheet, source: 'caller' });
      assumptions.push({ key: 'sheetsAvoidedPerDigitalOrderOrDocument', value: 1, source: 'default' });
      estimatedPaperGrams = Math.round(sheets * q.gramsPerSheet);
    }
    return {
      from: q.from, to: q.to, branchId: q.branchId ?? null,
      foodWaste: waste.totals,
      paper: {
        digitalOrders: digital.digital_orders, qrOrders: digital.qr_orders, qrTableSessions: digital.qr_visits,
        electronicFiscalDocuments: receipts.n, countedOrders: digital.orders,
        printedTicketsAvoidedIndicator: sheets,
        estimatedPaperGrams, estimateLabel: estimatedPaperGrams === null ? null : 'Estimate from the assumption shown, not a measurement',
      },
      meta: this.meta(tz, 'Food waste: measured waste movements only (see the inventory waste report). Paper indicator: counts of orders placed digitally (QR, web, WhatsApp, MCP) plus electronic fiscal documents issued, each standing for one paper ticket or receipt that did not have to be printed. Resuto cannot see whether a guest also asked for a printed copy, so this is an indicator, not a measured saving. Paper weight is reported only when the caller supplies grams per sheet.', {
        wasteEntries: waste.meta.dataCoverage.wasteEntries as number, digitalOrderSharePct: pct(digital.digital_orders, digital.orders),
      }, assumptions, assumptions.length ? 'mixed' : 'measured'),
    };
  }

  // -------------------------------------------------------------------------
  // Owner home overview
  // -------------------------------------------------------------------------
  async overview(tx: Tx, ctx: TenantContext, branchId?: string) {
    const { scope, tz, currency } = await this.context(tx, ctx, branchId);
    const base = `t as (select (now() at time zone $3) as local_now)
      , base as (
        select o.total_minor, o.refunded_minor, (o.placed_at at time zone $3) as local_ts, o.status not in ('cancelled', 'awaiting_payment') as counted
          from orders o where o.org_id = $1 and ($2::uuid[] is null or o.branch_id = any($2)) and o.placed_at >= now() - interval '9 days')`;
    const params = [ctx.orgId, scope, tz];
    const kpi = await tx.one(
      `with ${base}
       select (select local_now::date from t)::text as today, to_char((select local_now from t), 'HH24:MI') as local_time,
              count(*) filter (where counted and local_ts::date = (select local_now::date from t))::int as today_orders,
              coalesce(sum(total_minor - refunded_minor) filter (where counted and local_ts::date = (select local_now::date from t)), 0)::bigint as today_net,
              coalesce(sum(total_minor) filter (where counted and local_ts::date = (select local_now::date from t)), 0)::bigint as today_billed,
              count(*) filter (where counted and local_ts::date = (select local_now::date from t) - 7 and local_ts::time <= (select local_now::time from t))::int as lw_orders,
              coalesce(sum(total_minor - refunded_minor) filter (where counted and local_ts::date = (select local_now::date from t) - 7 and local_ts::time <= (select local_now::time from t)), 0)::bigint as lw_net,
              coalesce(sum(total_minor) filter (where counted and local_ts::date = (select local_now::date from t) - 7 and local_ts::time <= (select local_now::time from t)), 0)::bigint as lw_billed,
              count(*) filter (where counted and local_ts::date = (select local_now::date from t) - 7)::int as lw_day_orders,
              coalesce(sum(total_minor - refunded_minor) filter (where counted and local_ts::date = (select local_now::date from t) - 7), 0)::bigint as lw_day_net
         from base`, params);
    const hourly = await tx.query(
      `with ${base}
       select extract(hour from local_ts)::int as hour,
              coalesce(sum(total_minor - refunded_minor) filter (where local_ts::date = (select local_now::date from t)), 0)::bigint as today,
              coalesce(sum(total_minor - refunded_minor) filter (where local_ts::date = (select local_now::date from t) - 7), 0)::bigint as last_week
         from base where counted and local_ts::date in ((select local_now::date from t), (select local_now::date from t) - 7)
        group by 1 order by 1`, params);
    const live = await tx.query(OVERVIEW_LIVE_SQL, [ctx.orgId, scope]);
    const visits = await tx.one(`select count(*)::int as n from visits where org_id = $1 and status = 'open' and ($2::uuid[] is null or branch_id = any($2))`, [ctx.orgId, scope]);
    const reservations = await tx.query(
      `select status::text as status, count(*)::int as n, coalesce(sum(party_size), 0)::int as guests from reservations
        where org_id = $1 and ($2::uuid[] is null or branch_id = any($2)) and (starts_at at time zone $3)::date = (now() at time zone $3)::date
        group by 1`, params);
    const alerts = await this.inventory.openAlerts(tx, ctx, branchId, { limit: 200 });
    const liveBy = Object.fromEntries(live.map((l) => [l.status, l.n]));
    const resBy = Object.fromEntries(reservations.map((r) => [r.status, r.n]));
    const activeRes = reservations.filter((r) => !['cancelled', 'expired', 'no_show'].includes(r.status));
    const todayAov = kpi.today_orders ? Math.round(int(kpi.today_billed) / kpi.today_orders) : 0;
    const lwAov = kpi.lw_orders ? Math.round(int(kpi.lw_billed) / kpi.lw_orders) : 0;
    return {
      date: kpi.today, localTime: kpi.local_time, currency, branchId: branchId ?? null,
      today: { orders: kpi.today_orders, netMinor: int(kpi.today_net), averageOrderMinor: todayAov },
      lastWeekSameTime: { date: addDays(kpi.today, -7), orders: kpi.lw_orders, netMinor: int(kpi.lw_net), averageOrderMinor: lwAov },
      lastWeekFullDay: { orders: kpi.lw_day_orders, netMinor: int(kpi.lw_day_net) },
      changePct: { orders: change(kpi.today_orders, kpi.lw_orders), netMinor: change(int(kpi.today_net), int(kpi.lw_net)), averageOrderMinor: change(todayAov, lwAov) },
      hourly: Array.from({ length: 24 }, (_, h) => {
        const r = hourly.find((x) => x.hour === h);
        return { hour: h, todayNetMinor: r ? int(r.today) : 0, lastWeekNetMinor: r ? int(r.last_week) : 0 };
      }),
      live: {
        openOrders: (liveBy.placed ?? 0) + (liveBy.accepted ?? 0) + (liveBy.preparing ?? 0) + (liveBy.ready ?? 0),
        byStatus: { awaitingPayment: liveBy.awaiting_payment ?? 0, placed: liveBy.placed ?? 0, accepted: liveBy.accepted ?? 0, preparing: liveBy.preparing ?? 0, ready: liveBy.ready ?? 0 },
        oldestOpenOrderAt: iso(live.filter((l) => l.status !== 'awaiting_payment').map((l) => l.oldest).sort()[0] ?? null),
        openVisits: visits.n,
      },
      reservationsToday: { total: activeRes.reduce((a, r) => a + r.n, 0), guests: activeRes.reduce((a, r) => a + r.guests, 0), byStatus: resBy },
      lowStock: { count: alerts.items.length, items: alerts.items.slice(0, 5) },
      meta: this.meta(tz, 'Today = local date in this timezone. Compared with the same weekday one week earlier up to the same local time (a like-for-like comparison); the full previous-week day is shown separately. Net = billed total − refunds for counted (confirmed, not cancelled) orders. Live counts are current open orders of any date.', {
        perBranchTimezones: false,
      }),
    };
  }

  // -------------------------------------------------------------------------
  // ROI calculator (hypothetical)
  // -------------------------------------------------------------------------
  async roi(tx: Tx, ctx: TenantContext, input: RoiInput) {
    const { scope, tz, currency } = await this.context(tx, ctx, input.branchId);
    // Measured baseline: the last `baselineDays` complete local days.
    const today = (await tx.one<{ d: string }>(`select (now() at time zone $1)::date::text as d`, [tz])).d;
    const period = { from: addDays(today, -input.baselineDays), to: addDays(today, -1) };
    const measuredRevenue = this.mapRevenue(await this.revenue(tx, ctx.orgId, scope, period));
    const costRow = await tx.one(
      `with ${HYBRID(true)}, ${PRODUCT_GRAIN}
       select coalesce(round(sum(net_ex_vat)), 0)::bigint as net, coalesce(round(sum(costed_net)), 0)::bigint as costed,
              coalesce(sum(cost), 0)::bigint as cost
         from sales_grain`, [ctx.orgId, scope, period.from, period.to]);
    const coverage = int(costRow.net) > 0 ? int(costRow.costed) / int(costRow.net) : 0;
    const measuredCostPct = int(costRow.costed) > 0 ? Math.round((int(costRow.cost) / int(costRow.costed)) * 10000) / 100 : null;
    const measuredMonthly = Math.round((measuredRevenue.netExVatMinor * 30) / input.baselineDays);

    const assumptions: AnalyticsMeta['assumptions'] = [];
    let baseline: number;
    if (input.baselineMonthlyNetRevenueMinor !== undefined) {
      baseline = input.baselineMonthlyNetRevenueMinor;
      assumptions.push({ key: 'baselineMonthlyNetRevenueMinor', value: baseline, source: 'caller' });
    } else {
      if (measuredRevenue.orders === 0) throw invalid('baseline_required', 'No orders in the baseline window. Enter your monthly revenue to run a scenario.');
      baseline = measuredMonthly;
      assumptions.push({ key: 'baselineMonthlyNetRevenueMinor', value: baseline, source: 'measured' });
    }
    let ingredientPct: number;
    if (input.ingredientCostPct !== undefined) {
      ingredientPct = input.ingredientCostPct;
      assumptions.push({ key: 'ingredientCostPct', value: ingredientPct, source: 'caller' });
    } else {
      if (measuredCostPct === null || coverage < 0.8) {
        throw invalid('ingredient_cost_required', 'Not enough product cost data to measure your food-cost ratio. Enter an ingredient cost % to run a scenario.',
          { costCoveragePct: Math.round(coverage * 10000) / 100 });
      }
      ingredientPct = measuredCostPct;
      assumptions.push({ key: 'ingredientCostPct', value: ingredientPct, source: 'measured' });
    }
    assumptions.push(
      { key: 'expectedUpliftPct', value: input.expectedUpliftPct, source: 'caller' },
      { key: 'variableCostPct', value: input.variableCostPct, source: 'caller' },
      { key: 'subscriptionMonthlyCostMinor', value: input.subscriptionMonthlyCostMinor, source: 'caller' },
      { key: 'otherMonthlyCostMinor', value: input.otherMonthlyCostMinor, source: 'caller' },
      { key: 'oneTimeSetupCostMinor', value: input.oneTimeSetupCostMinor, source: 'caller' },
      { key: 'months', value: input.months, source: 'caller' },
    );
    const bp = (p: number) => Math.round(p * 100);
    const ofBp = (amount: number, b: number) => Math.round((amount * b) / 10_000);
    const incrementalRevenue = ofBp(baseline, bp(input.expectedUpliftPct));
    const ingredientCost = ofBp(incrementalRevenue, bp(ingredientPct));
    const variableCost = ofBp(incrementalRevenue, bp(input.variableCostPct));
    const incrementalGrossProfit = incrementalRevenue - ingredientCost - variableCost;
    const fixedMonthly = input.subscriptionMonthlyCostMinor + input.otherMonthlyCostMinor;
    const netMonthly = incrementalGrossProfit - fixedMonthly;
    const totalCost = fixedMonthly * input.months + input.oneTimeSetupCostMinor;
    const netTotal = netMonthly * input.months - input.oneTimeSetupCostMinor;
    const contributionBp = 10_000 - bp(ingredientPct) - bp(input.variableCostPct);
    const breakEvenUpliftPct = baseline > 0 && contributionBp > 0 ? Math.round((fixedMonthly * 10_000 * 100 * 100) / (baseline * contributionBp)) / 100 : null;
    return {
      kind: 'hypothetical' as const,
      label: 'Hypothetical scenario based on the assumptions below. These are not measured results.',
      currency,
      measured: {
        window: period, orders: measuredRevenue.orders, netExVatMinor: measuredRevenue.netExVatMinor, monthlyNetExVatMinor: measuredMonthly,
        ingredientCostPct: measuredCostPct, costCoveragePct: Math.round(coverage * 10000) / 100,
      },
      hypothetical: {
        months: input.months,
        monthly: { incrementalRevenueMinor: incrementalRevenue, ingredientCostMinor: ingredientCost, variableCostMinor: variableCost,
          incrementalGrossProfitMinor: incrementalGrossProfit, subscriptionAndOtherCostMinor: fixedMonthly, incrementalNetProfitMinor: netMonthly },
        total: { incrementalRevenueMinor: incrementalRevenue * input.months, incrementalGrossProfitMinor: incrementalGrossProfit * input.months,
          costMinor: totalCost, incrementalNetProfitMinor: netTotal },
        roiPct: totalCost > 0 ? Math.round((netTotal / totalCost) * 10000) / 100 : null,
        paybackMonths: input.oneTimeSetupCostMinor === 0 ? (netMonthly > 0 ? 0 : null) : netMonthly > 0 ? Math.ceil(input.oneTimeSetupCostMinor / netMonthly) : null,
        breakEvenUpliftPct,
      },
      meta: this.meta(tz, 'Hypothetical. Incremental revenue = baseline monthly net revenue (ex-VAT) × expected uplift. Incremental gross profit = incremental revenue − ingredient cost % − other variable cost %. Incremental net profit = gross profit − subscription − other monthly costs (− one-time setup over the horizon). ROI = total incremental net profit ÷ total cost. Revenue is not profit: only the net profit lines measure return. Break-even uplift = uplift at which monthly net profit is zero. A measured baseline uses the last complete days in this timezone.', {
        baselineOrders: measuredRevenue.orders, baselineDays: input.baselineDays, costCoveragePct: Math.round(coverage * 10000) / 100,
      }, assumptions, 'hypothetical'),
    };
  }
}
