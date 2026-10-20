import { Injectable, Logger } from '@nestjs/common';
import { formatMoney, type Currency, type Insight } from '@resuto/contracts';
import { TenantContext } from '../../common/auth/context';
import { DbService, type Tx } from '../../common/db/db.service';
import { DomainError, notFound } from '../../common/errors/domain-error';
import { Scheduled } from '../../common/events/events';
import { AuditService } from '../../common/platform/audit.service';
import { addDays, isoWeek } from './calendar';
import { IntelligenceDataService, SOLD } from './data.service';
import { IntelligenceService } from './intelligence.service';

type Severity = Insight['severity'];
interface Candidate {
  branchId: string | null; kind: string; severity: Severity; title: string; body: string;
  evidence: Record<string, unknown>; method: 'deterministic' | 'model'; dedupeKey: string;
}

/** Thresholds of the deterministic rules (documented in the dashboard and tests). */
export const RULES = {
  revenueDropPct: 25, revenueDropCriticalPct: 40, revenueWeeks: 4, revenueMinWeeks: 3,
  anomalyWindowDays: 28, anomalyZSpike: 3, anomalyZDrop: -2.5, anomalyMinMean: 3,
  stockCoverDays: 2, stockWindowDays: 14,
  valuableTopShare: 0.2, valuableMinOrders: 3, inactiveGapMultiple: 2, inactiveMinDays: 30,
  kitchenSlowerPct: 30, kitchenMinOrders: 3, kitchenBaselineDays: 14, kitchenMinBaselineOrders: 10,
  demandShiftPct: 30, modelRunEveryHours: 20,
} as const;

/** Deterministic stock rules whose open insights are closed once the condition clears. */
const STOCK_RULES: string[] = ['inventory_below_reorder_level', 'stock_cover_vs_14d_average'];

const pct = (a: number, b: number) => (b === 0 ? 0 : ((a - b) / b) * 100);
const round1 = (n: number) => Math.round(n * 10) / 10;

@Injectable()
export class InsightsService {
  private readonly logger = new Logger('Insights');

  constructor(
    private readonly db: DbService,
    private readonly data: IntelligenceDataService,
    private readonly intelligence: IntelligenceService,
    private readonly audit: AuditService,
  ) {}

  // -------------------------------------------------------------------------
  // Feed
  // -------------------------------------------------------------------------
  list(ctx: TenantContext, q: { status?: string; branchId?: string; limit: number; cursor?: string }) {
    if (q.branchId) ctx.assertBranch(q.branchId);
    return this.db.scoped(ctx, async (tx) => {
      const rows = await tx.query<any>(
        `select id, branch_id, kind, severity, title, body, evidence, method, status, created_at from ai_insights
          where org_id = $1 and ($2::text is null or status = $2) and ($3::uuid is null or branch_id = $3)
            and ($4::uuid[] is null or branch_id is null or branch_id = any($4::uuid[]))
            and ($5::timestamptz is null or created_at < $5)
          order by created_at desc, id limit $6`,
        [ctx.orgId, q.status ?? null, q.branchId ?? null, ctx.branchFilter, q.cursor ?? null, q.limit]);
      const items: Insight[] = rows.map((r) => ({ id: r.id, branchId: r.branch_id, kind: r.kind, severity: r.severity, title: r.title,
        body: r.body, evidence: r.evidence, method: r.method, status: r.status, createdAt: new Date(r.created_at).toISOString() }));
      return { items, nextCursor: rows.length === q.limit ? items.at(-1)!.createdAt : null };
    });
  }

  setStatus(ctx: TenantContext, id: string, status: 'seen' | 'dismissed' | 'acted') {
    return this.db.scoped(ctx, async (tx) => {
      const cur = await tx.maybeOne<{ status: string; branch_id: string | null }>(`select status, branch_id from ai_insights where id = $1 and org_id = $2 for update`, [id, ctx.orgId]);
      if (!cur || !ctx.canAccessBranch(cur.branch_id)) throw notFound('Insight');
      if ((cur.status === 'dismissed' || cur.status === 'acted') && status === 'seen') {
        throw new DomainError('insight_closed', 'This insight was already closed', 409, { status: cur.status });
      }
      await tx.query(`update ai_insights set status = $2, status_changed_at = now(), status_changed_by = $3 where id = $1`, [id, status, ctx.userId]);
      await this.audit.record(tx, ctx, { action: 'intelligence.insight.status', entityType: 'ai_insight', entityId: id, branchId: cur.branch_id,
        metadata: { from: cur.status, to: status } });
      return { id, status };
    });
  }

  // -------------------------------------------------------------------------
  // Generation
  // -------------------------------------------------------------------------
  /** Periodic job: every tenant with the intelligence module. Deterministic rules every run; model rules at most every 20 h. */
  @Scheduled('intelligence.insights', 3600)
  async runScheduled() {
    // Cross-tenant listing of entitled organisations (job resolution only; all reads below are tenant-scoped).
    const orgs = await this.db.withPlatform((tx) => tx.query<{ id: string }>(
      `select id from organizations where status in ('active', 'onboarding') and app.module_enabled(id, 'intelligence') order by id`));
    const totals = { orgs: orgs.length, created: 0, failed: 0 };
    for (const o of orgs) {
      try {
        totals.created += (await this.generateForOrg(TenantContext.system(o.id, 'intelligence.insights'))).created;
      } catch (error) {
        totals.failed++;
        this.logger.warn(`insights for ${o.id} failed: ${(error as Error).message}`);
      }
    }
    return totals;
  }

  async generateForOrg(ctx: TenantContext, opts: { forceModel?: boolean } = {}) {
    const candidates: Candidate[] = [];
    const branches = await this.db.scoped(ctx, (tx) => tx.query<{ id: string; name: string; today: string; currency: Currency }>(
      `select b.id, b.name, (now() at time zone coalesce(b.timezone, o.timezone))::date::text as today, o.currency
         from branches b join organizations o on o.id = b.org_id
        where b.org_id = $1 and b.is_active and ($2::uuid[] is null or b.id = any($2::uuid[])) order by b.created_at`, [ctx.orgId, ctx.branchFilter]));
    await this.db.scoped(ctx, async (tx) => {
      for (const b of branches) {
        const yesterday = addDays(b.today, -1);
        candidates.push(...await this.revenueDrop(tx, ctx, b, yesterday));
        candidates.push(...await this.itemAnomalies(tx, ctx, b, yesterday));
        candidates.push(...await this.stockRisk(tx, ctx, b));
        candidates.push(...await this.slowKitchen(tx, ctx, b, yesterday));
      }
      if (branches.length) candidates.push(...await this.inactiveValuable(tx, ctx, branches[0]!.today, branches[0]!.currency));
    });

    const stats = { deterministic: candidates.length, model: 0, modelSkipped: null as string | null, created: 0, resolved: 0 };
    const due = opts.forceModel || !(await this.db.scoped(ctx, (tx) => tx.maybeOne(
      `select 1 from ai_predictions where org_id = $1 and kind = 'demand_forecast' and payload->>'source' = 'insights'
          and created_at > now() - make_interval(hours => $2) limit 1`, [ctx.orgId, RULES.modelRunEveryHours])));
    if (!due) stats.modelSkipped = 'ran_recently';
    else {
      try {
        const model = await this.modelInsights(ctx, branches);
        stats.model = model.length;
        candidates.push(...model);
      } catch (error) {
        // 503: AI service down/not configured. 402: the plan's AI quota is used up (FT-10); deterministic rules stay free.
        if (error instanceof DomainError && (error.status === 503 || error.code === 'plan_limit_reached')) stats.modelSkipped = error.code;
        else throw error;
      }
    }

    stats.created = await this.db.scoped(ctx, async (tx) => {
      let n = 0;
      for (const c of candidates) {
        const row = await tx.maybeOne(
          `insert into ai_insights(org_id, branch_id, kind, severity, title, body, evidence, method, dedupe_key)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           on conflict (org_id, dedupe_key) where dedupe_key is not null do nothing returning id`,
          [ctx.orgId, c.branchId, c.kind, c.severity, c.title, c.body, c.evidence, c.method, c.dedupeKey]);
        if (row) n++;
      }
      return n;
    });
    stats.resolved = await this.db.scoped(ctx, (tx) => this.resolveStockInsights(tx, ctx, branches.map((b) => b.id), candidates));
    return stats;
  }

  /**
   * Closes open stock insights whose condition no longer holds (restocked, reorder
   * level lowered, item deactivated): the stock rules ran for these branches just
   * now and no longer flag that item, so the stale quantity is not left on the feed.
   */
  private async resolveStockInsights(tx: Tx, ctx: TenantContext, branchIds: string[], candidates: Candidate[]) {
    if (!branchIds.length) return 0;
    const live = candidates.filter((c) => STOCK_RULES.includes(c.evidence.rule as string))
      .map((c) => `${c.branchId}:${c.evidence.itemId ?? c.evidence.productId}`);
    const rows = await tx.query(
      `update ai_insights set status = 'acted', status_changed_at = now(), status_changed_by = null
        where org_id = $1 and branch_id = any($2::uuid[]) and status in ('new', 'seen') and method = 'deterministic'
          and evidence->>'rule' = any($3::text[])
          and not (branch_id::text || ':' || coalesce(evidence->>'itemId', evidence->>'productId') = any($4::text[]))
        returning id`, [ctx.orgId, branchIds, STOCK_RULES, live]);
    return rows.length;
  }

  /** Yesterday's revenue vs the same weekday in the previous four weeks. */
  private async revenueDrop(tx: Tx, ctx: TenantContext, b: { id: string; name: string; currency: Currency }, day: string): Promise<Candidate[]> {
    const days = [day, ...Array.from({ length: RULES.revenueWeeks }, (_, i) => addDays(day, -7 * (i + 1)))];
    const rows = await tx.query<{ d: string; revenue: number; orders: number }>(
      `select o.business_date::text as d, sum(o.total_minor)::bigint as revenue, count(*)::int as orders from orders o
        where o.org_id = $1 and o.branch_id = $2 and ${SOLD} and o.business_date = any($3::date[]) group by 1`, [ctx.orgId, b.id, days]);
    const by = new Map(rows.map((r) => [r.d, r]));
    const weeks = days.slice(1).map((d) => ({ date: d, revenueMinor: by.get(d)?.revenue ?? 0 })).filter((w) => w.revenueMinor > 0);
    if (weeks.length < RULES.revenueMinWeeks) return [];
    const baseline = Math.round(weeks.reduce((s, w) => s + w.revenueMinor, 0) / weeks.length);
    const actual = by.get(day)?.revenue ?? 0;
    const drop = -pct(actual, baseline);
    if (drop < RULES.revenueDropPct) return [];
    const fmt = (m: number) => formatMoney(m, b.currency, 'en');
    return [{
      branchId: b.id, kind: 'sales', method: 'deterministic', severity: drop >= RULES.revenueDropCriticalPct ? 'critical' : 'warning',
      title: `Revenue down ${round1(drop)}% at ${b.name}`,
      body: `Revenue on ${day} was ${fmt(actual)} against an average of ${fmt(baseline)} on the same weekday over the previous ${weeks.length} weeks.`,
      evidence: { rule: 'revenue_vs_same_weekday_4w', date: day, revenueMinor: actual, baselineMinor: baseline, dropPct: round1(drop), weeks, currency: b.currency,
        orders: by.get(day)?.orders ?? 0 },
      dedupeKey: `revenue_drop:${b.id}:${day}`,
    }];
  }

  /** Product sales anomalies: z-score of yesterday's quantity vs the previous 28 days (zeros filled). */
  private async itemAnomalies(tx: Tx, ctx: TenantContext, b: { id: string; name: string }, day: string): Promise<Candidate[]> {
    const from = addDays(day, -RULES.anomalyWindowDays);
    const rows = await tx.query<{ product_id: string; name: string; d: string; qty: number }>(
      `select ol.product_id, p.name, o.business_date::text as d, sum(ol.quantity)::int as qty
         from order_lines ol join orders o on o.id = ol.order_id join products p on p.id = ol.product_id
        where o.org_id = $1 and o.branch_id = $2 and ${SOLD} and ol.kitchen_status <> 'cancelled' and o.business_date between $3::date and $4::date
        group by 1, 2, 3`, [ctx.orgId, b.id, from, day]);
    const per = new Map<string, { name: string; q: Map<string, number> }>();
    for (const r of rows) {
      if (!per.has(r.product_id)) per.set(r.product_id, { name: r.name, q: new Map() });
      per.get(r.product_id)!.q.set(r.d, r.qty);
    }
    const out: Candidate[] = [];
    for (const [pid, { name, q }] of per) {
      const hist = Array.from({ length: RULES.anomalyWindowDays }, (_, i) => q.get(addDays(from, i)) ?? 0);
      const mean = hist.reduce((s, x) => s + x, 0) / hist.length;
      const sd = Math.sqrt(hist.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(hist.length - 1, 1));
      const scale = Math.max(sd, Math.sqrt(Math.max(mean, 1))); // Poisson floor avoids huge z on flat series
      const actual = q.get(day) ?? 0;
      const z = (actual - mean) / scale;
      const spike = z >= RULES.anomalyZSpike;
      const dropped = z <= RULES.anomalyZDrop && mean >= RULES.anomalyMinMean;
      if (!spike && !dropped) continue;
      out.push({
        branchId: b.id, kind: 'anomaly', method: 'deterministic', severity: spike ? 'opportunity' : 'warning',
        title: spike ? `${name} sold far above normal` : `${name} sold far below normal`,
        body: `${name} sold ${actual} on ${day}; the previous ${RULES.anomalyWindowDays}-day average was ${round1(mean)} per day (z = ${round1(z)}).`,
        evidence: { rule: 'item_sales_zscore_28d', productId: pid, date: day, quantity: actual, mean: round1(mean), sd: round1(sd), z: round1(z) },
        dedupeKey: `item_anomaly:${b.id}:${pid}:${day}`,
      });
    }
    return out;
  }

  /** Stock-out risk: tracked stock vs trailing 14-day average daily sales; inventory below reorder level. */
  private async stockRisk(tx: Tx, ctx: TenantContext, b: { id: string; name: string; today: string }): Promise<Candidate[]> {
    const out: Candidate[] = [];
    const from = addDays(b.today, -RULES.stockWindowDays);
    const products = await tx.query<{ id: string; name: string; stock: number; sold: number }>(
      `select p.id, p.name, s.stock_qty as stock,
              coalesce((select sum(ol.quantity) from order_lines ol join orders o on o.id = ol.order_id
                         where ol.product_id = p.id and o.branch_id = $2 and ${SOLD} and ol.kitchen_status <> 'cancelled'
                           and o.business_date >= $3::date and o.business_date < $4::date), 0)::int as sold
         from products p join product_branch_settings s on s.product_id = p.id and s.branch_id = $2
        where p.org_id = $1 and p.is_active and p.track_stock and s.stock_qty is not null`, [ctx.orgId, b.id, from, b.today]);
    for (const p of products) {
      const daily = p.sold / RULES.stockWindowDays;
      if (daily <= 0) continue;
      const cover = p.stock / daily;
      if (cover >= RULES.stockCoverDays) continue;
      out.push({
        branchId: b.id, kind: 'inventory', method: 'deterministic', severity: p.stock === 0 ? 'critical' : 'warning',
        title: p.stock === 0 ? `${p.name} is sold out` : `${p.name} may sell out within ${round1(cover)} days`,
        body: `${p.stock} left at ${b.name}; it sold ${round1(daily)} per day on average over the last ${RULES.stockWindowDays} days.`,
        evidence: { rule: 'stock_cover_vs_14d_average', productId: p.id, stock: p.stock, averageDailySales: round1(daily), coverDays: round1(cover) },
        dedupeKey: `stockout:${b.id}:${p.id}:${b.today}`,
      });
    }
    const items = await tx.query<{ id: string; name: string; unit: string; quantity: string; reorder_level: string }>(
      `select i.id, i.name, i.unit, l.quantity::text, i.reorder_level::text from inventory_items i
         join stock_levels l on l.item_id = i.id and l.branch_id = $2
        where i.org_id = $1 and i.is_active and i.reorder_level > 0 and l.quantity <= i.reorder_level`, [ctx.orgId, b.id]);
    for (const i of items) {
      out.push({
        branchId: b.id, kind: 'inventory', method: 'deterministic', severity: Number(i.quantity) <= 0 ? 'critical' : 'warning',
        title: `${i.name} is below its reorder level`,
        body: `${Number(i.quantity)} ${i.unit} in stock at ${b.name}; reorder level ${Number(i.reorder_level)} ${i.unit}.`,
        evidence: { rule: 'inventory_below_reorder_level', itemId: i.id, quantity: Number(i.quantity), reorderLevel: Number(i.reorder_level), unit: i.unit },
        dedupeKey: `low_stock:${b.id}:${i.id}:${b.today}`,
      });
    }
    return out;
  }

  /** Kitchen speed: yesterday's median placed→ready minutes vs the previous 14 days. */
  private async slowKitchen(tx: Tx, ctx: TenantContext, b: { id: string; name: string }, day: string): Promise<Candidate[]> {
    const r = await tx.one<{ y_med: number | null; y_n: number; b_med: number | null; b_n: number }>(
      `with t as (
         select o.business_date, extract(epoch from (o.ready_at - o.placed_at)) / 60 as minutes from orders o
          where o.org_id = $1 and o.branch_id = $2 and o.ready_at is not null and o.ready_at > o.placed_at
            and o.business_date between $3::date and $4::date)
       select percentile_cont(0.5) within group (order by minutes) filter (where business_date = $4::date) as y_med,
              count(*) filter (where business_date = $4::date)::int as y_n,
              percentile_cont(0.5) within group (order by minutes) filter (where business_date < $4::date) as b_med,
              count(*) filter (where business_date < $4::date)::int as b_n from t`,
      [ctx.orgId, b.id, addDays(day, -RULES.kitchenBaselineDays), day]);
    if (r.y_med === null || r.b_med === null || r.y_n < RULES.kitchenMinOrders || r.b_n < RULES.kitchenMinBaselineOrders) return [];
    const slower = pct(r.y_med, r.b_med);
    if (slower < RULES.kitchenSlowerPct) return [];
    return [{
      branchId: b.id, kind: 'operations', method: 'deterministic', severity: 'warning',
      title: `Kitchen ${round1(slower)}% slower at ${b.name}`,
      body: `Median time from order to ready on ${day} was ${round1(r.y_med)} min (${r.y_n} orders) vs ${round1(r.b_med)} min over the previous ${RULES.kitchenBaselineDays} days.`,
      evidence: { rule: 'median_ready_minutes_vs_14d', date: day, medianMinutes: round1(r.y_med), orders: r.y_n, baselineMedianMinutes: round1(r.b_med), baselineOrders: r.b_n },
      dedupeKey: `slow_kitchen:${b.id}:${day}`,
    }];
  }

  /** Valuable customers (top 20 % spend, ≥ 3 orders) who are overdue: > 2× their usual gap and > 30 days. */
  private async inactiveValuable(tx: Tx, ctx: TenantContext, today: string, currency: Currency): Promise<Candidate[]> {
    const rows = await tx.query<{ customer_id: string; spend: number; n: number; last_days: number; gap_days: number }>(
      `with c as (
         select o.customer_id, sum(o.total_minor)::bigint as spend, count(*)::int as n,
                extract(epoch from now() - max(o.placed_at)) / 86400 as last_days,
                extract(epoch from max(o.placed_at) - min(o.placed_at)) / 86400 / greatest(count(*) - 1, 1) as gap_days
           from orders o where o.org_id = $1 and o.customer_id is not null and ${SOLD} and o.placed_at > now() - interval '365 days'
            and ($2::uuid[] is null or o.branch_id = any($2::uuid[]))
          group by o.customer_id),
       ranked as (select *, percent_rank() over (order by spend) as pr from c)
       select customer_id, spend, n, last_days::float8, gap_days::float8 from ranked
        where pr >= $3 and n >= $4 and last_days > greatest(gap_days * $5, $6) order by spend desc limit 50`,
      [ctx.orgId, ctx.branchFilter, 1 - RULES.valuableTopShare, RULES.valuableMinOrders, RULES.inactiveGapMultiple, RULES.inactiveMinDays]);
    if (!rows.length) return [];
    const spend = rows.reduce((s, r) => s + Number(r.spend), 0);
    return [{
      branchId: null, kind: 'customers', method: 'deterministic', severity: 'opportunity',
      title: `${rows.length} valuable customers have gone quiet`,
      body: `${rows.length} customers in your top ${RULES.valuableTopShare * 100}% by spend (${formatMoney(spend, currency, 'en')} in the last year) are overdue by more than twice their usual gap. Consider a win-back message.`,
      evidence: { rule: 'top20_spend_overdue_2x_gap', customers: rows.length, spendMinor: spend, currency,
        customerIds: rows.map((r) => r.customer_id) },
      dedupeKey: `inactive_valuable:${isoWeek(today)}`,
    }];
  }

  /** Model-based: forecast vs last week for top items, and high churn risk counts. */
  private async modelInsights(ctx: TenantContext, branches: Array<{ id: string; name: string; today: string }>): Promise<Candidate[]> {
    const out: Candidate[] = [];
    for (const b of branches) {
      const fc = await this.intelligence.forecast(ctx, { branchId: b.id, horizon: 7, top: 5, historyDays: 365 }, 'insights');
      for (const it of fc.items) {
        const last7 = it.history.filter((h) => h.date > addDays(fc.asOf, -7)).reduce((s, h) => s + h.quantity, 0);
        const next7 = it.forecast.reduce((s, p) => s + p.yhat, 0);
        if (last7 < 5) continue;
        const change = pct(next7, last7);
        if (Math.abs(change) < RULES.demandShiftPct) continue;
        const up = change > 0;
        out.push({
          branchId: b.id, kind: 'sales', method: 'model', severity: up ? 'opportunity' : 'info',
          title: up ? `Demand for ${it.name} expected to rise ${round1(change)}%` : `Demand for ${it.name} expected to fall ${round1(-change)}%`,
          body: `Forecast for the next 7 days is ${round1(next7)} units (model ${it.model}, ${it.interval.level * 100}% interval per day) vs ${last7} sold in the last 7 days at ${b.name}.`,
          evidence: { rule: 'forecast_next7_vs_last7', productId: it.productId, model: it.model, next7: round1(next7), last7, changePct: round1(change),
            backtest: it.candidates.find((c) => c.model === it.model)?.metrics ?? null },
          dedupeKey: `demand_shift:${b.id}:${it.productId}:${isoWeek(b.today)}`,
        });
      }
    }
    const churn = await this.intelligence.churn(ctx, 200, 60);
    const high = churn.customers.filter((c) => c.band === 'high');
    if (high.length && branches.length) {
      out.push({
        branchId: null, kind: 'customers', method: 'model', severity: 'warning',
        title: `${high.length} customers at high churn risk`,
        body: `${high.length} customers have a churn risk of 70% or more for the next ${churn.windowDays} days (${churn.isHeuristic ? 'recency heuristic' : 'logistic regression'}).`,
        evidence: { rule: 'churn_risk_high_band', method: churn.method, isHeuristic: churn.isHeuristic, customers: high.length,
          customerIds: high.slice(0, 50).map((c) => c.customerId) },
        dedupeKey: `churn_risk:${isoWeek(branches[0]!.today)}`,
      });
    }
    return out;
  }
}
