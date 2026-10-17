import { Injectable } from '@nestjs/common';
import type {
  ChurnResponse, ForecastQuery, ForecastResponse, ItemForecast, RecommendationsResponse, RecommendedItem, RoutePlanInput,
  RoutePlanResponse, SegmentKey, SegmentMember, SegmentsResponse,
} from '@resuto/contracts';
import { SEGMENT_KEYS } from '@resuto/contracts';
import type { TenantContext } from '../../common/auth/context';
import { DbService } from '../../common/db/db.service';
import { DomainError, notFound } from '../../common/errors/domain-error';
import { AI_TIMEOUT_MS, AiServiceClient, recordUsage } from './ai-client.service';
import { addDays, ramadanBetween, WEEKEND_DAYS, WEEKEND_NAMES } from './calendar';
import { IntelligenceDataService, type ProductRef } from './data.service';

interface AiForecastResult { id: string; model: ItemForecast['model']; [k: string]: unknown }

/**
 * Orchestrates the native models: extract (scoped read tx) → call the AI service (no tx held)
 * → persist the prediction and the usage event (scoped write tx).
 */
@Injectable()
export class IntelligenceService {
  constructor(private readonly db: DbService, private readonly data: IntelligenceDataService, private readonly ai: AiServiceClient) {}

  // -------------------------------------------------------------------------
  // Demand forecast
  // -------------------------------------------------------------------------
  async forecast(ctx: TenantContext, q: ForecastQuery, source: 'api' | 'insights' | 'assistant' = 'api'): Promise<ForecastResponse> {
    const prep = await this.db.scoped(ctx, async (tx) => {
      const b = await this.data.branch(tx, ctx, q.branchId);
      const asOf = addDays(b.today, -1); // last complete business day
      const from = addDays(asOf, -(q.historyDays - 1));
      let ids: string[];
      if (q.productId) {
        const p = await this.data.products(tx, ctx, [q.productId]);
        if (!p.size) throw notFound('Product');
        ids = [q.productId];
      } else {
        ids = await this.data.topProducts(tx, ctx, q.branchId, addDays(asOf, -55), asOf, q.top);
      }
      const products = await this.data.products(tx, ctx, ids);
      const history = await this.data.dailyQuantities(tx, ctx, q.branchId, ids, from, asOf);
      return { b, asOf, from, ids, products, history };
    });
    const { b, asOf, ids, products, history } = prep;
    const ramadan = ramadanBetween(prep.from, addDays(asOf, q.horizon));
    const generatedAt = new Date().toISOString();
    const base = {
      branchId: q.branchId, horizon: q.horizon, asOf, generatedAt,
      calendar: { weekendDays: WEEKEND_NAMES, ramadan, ramadanSource: 'approximate_table' }, isSyntheticData: false as const,
    };
    const series = ids.filter((id) => history.get(id)!.length > 0).map((id) => ({ id, history: history.get(id)! }));
    if (!series.length) return { ...base, items: [], computationMs: 0 };

    const res = await this.ai.post<{ results: AiForecastResult[]; computationMs: number }>('/forecast/demand', {
      series, horizon: q.horizon, end: asOf, weekendDays: WEEKEND_DAYS[b.country], ramadan, useRamadan: true, intervalLevel: 0.8, seed: 42,
    }, AI_TIMEOUT_MS.forecast);

    const items: ItemForecast[] = res.results.map((r) => {
      const p = products.get(r.id) as ProductRef;
      return { ...(r as any), productId: r.id, name: p?.name ?? r.id, nameAr: p?.nameAr ?? null, history: history.get(r.id)! };
    });
    await this.db.scoped(ctx, async (tx) => {
      for (const it of items) {
        const modelId = await this.data.modelId(tx, 'demand_forecast', it.model);
        await tx.query(
          `insert into ai_predictions(org_id, branch_id, model_id, kind, subject_type, subject_id, horizon_start, horizon_end, payload)
           values ($1, $2, $3, 'demand_forecast', 'product', $4, $5::date, $6::date, $7)`,
          [ctx.orgId, q.branchId, modelId, it.productId, it.forecast[0]?.date ?? asOf, it.forecast.at(-1)?.date ?? asOf,
            { source, model: it.model, fallbackReason: it.fallbackReason, candidates: it.candidates, backtest: it.backtest,
              interval: it.interval, forecast: it.forecast, coverage: it.coverage }]);
      }
      await recordUsage(tx, ctx, { endpoint: 'forecast/demand', provider: 'resuto-ai-service' });
    });
    for (const it of items) delete (it as any).id;
    return { ...base, items, computationMs: res.computationMs };
  }

  // -------------------------------------------------------------------------
  // Customer segments (RFM)
  // -------------------------------------------------------------------------
  async segments(ctx: TenantContext): Promise<SegmentsResponse> {
    const orders = await this.db.scoped(ctx, (tx) => this.data.customerOrders(tx, ctx));
    const asOf = new Date().toISOString();
    if (!orders.length) {
      return { asOf, method: 'rfm_quintiles', totalCustomers: 0, predictionId: '', segments: SEGMENT_KEYS.map((key) => ({ key, count: 0 })) };
    }
    const res = await this.ai.post<{ customers: Array<{ customerId: string; segment: SegmentKey; r: number; f: number; m: number; recencyDays: number; frequency: number; monetaryMinor: number }>; segments: Record<SegmentKey, number> }>(
      '/customers/segment', { orders, asOf });
    const predictionId = await this.db.scoped(ctx, async (tx) => {
      const modelId = await this.data.modelId(tx, 'customer_segmentation', 'rfm_quintiles');
      const row = await tx.one<{ id: string }>(
        `insert into ai_predictions(org_id, model_id, kind, subject_type, subject_id, payload)
         values ($1, $2, 'segment_assignment', 'organization', $3, $4) returning id`,
        [ctx.orgId, modelId, ctx.orgId, { asOf, segments: res.segments, assignments: res.customers, branchScope: ctx.branchFilter }]);
      await recordUsage(tx, ctx, { endpoint: 'customers/segment', provider: 'resuto-ai-service' });
      return row.id;
    });
    return {
      asOf, method: 'rfm_quintiles', totalCustomers: res.customers.length, predictionId,
      segments: SEGMENT_KEYS.map((key) => ({ key, count: res.segments[key] ?? 0 })),
    };
  }

  /** Members of one segment from the latest assignment (computed within 24 h, else recomputed). */
  async segmentMembers(ctx: TenantContext, segment: SegmentKey, limit: number, offset: number) {
    const scope = JSON.stringify(ctx.branchFilter);
    const latest = () => this.db.scoped(ctx, (tx) => tx.maybeOne<{ payload: any }>(
      `select payload from ai_predictions where org_id = $1 and kind = 'segment_assignment' and created_at > now() - interval '24 hours'
          and coalesce((payload->'branchScope')::text, 'null') = $2 order by created_at desc limit 1`, [ctx.orgId, scope]));
    let row = await latest();
    if (!row) {
      await this.segments(ctx);
      row = await latest();
    }
    const all = ((row?.payload.assignments ?? []) as Array<Omit<SegmentMember, 'displayName'>>)
      .filter((a) => a.segment === segment).sort((a, b) => b.monetaryMinor - a.monetaryMinor || a.customerId.localeCompare(b.customerId));
    const page = all.slice(offset, offset + limit);
    const names = await this.db.scoped(ctx, (tx) => this.data.customerNames(tx, ctx, page.map((p) => p.customerId)));
    return {
      segment, asOf: row?.payload.asOf ?? null, total: all.length,
      items: page.map((p) => ({ ...p, displayName: names.get(p.customerId) ?? null })),
      nextCursor: offset + limit < all.length ? String(offset + limit) : null,
    };
  }

  // -------------------------------------------------------------------------
  // Churn risk
  // -------------------------------------------------------------------------
  async churn(ctx: TenantContext, limit: number, windowDays: number): Promise<ChurnResponse> {
    const { orders, org } = await this.db.scoped(ctx, async (tx) => ({ orders: await this.data.customerOrders(tx, ctx), org: await this.data.org(tx, ctx) }));
    const asOf = new Date().toISOString();
    if (!orders.length) {
      return { method: 'heuristic', isHeuristic: true, reason: 'no_customer_orders', windowDays, currency: org.currency,
        labelCohort: { cutoff: asOf, customers: 0, churned: 0, retained: 0 }, evaluation: null, customers: [] };
    }
    const res = await this.ai.post<Omit<ChurnResponse, 'currency'>>('/customers/churn', { orders, asOf, windowDays, seed: 42 });
    const top = res.customers.slice(0, limit);
    const names = await this.db.scoped(ctx, async (tx) => {
      const modelId = await this.data.modelId(tx, 'churn', res.method === 'heuristic' ? 'recency_heuristic' : 'logistic_regression');
      await tx.query(
        `insert into ai_predictions(org_id, model_id, kind, subject_type, subject_id, payload) values ($1, $2, 'churn_risk', 'organization', $3, $4)`,
        [ctx.orgId, modelId, ctx.orgId, { asOf, method: res.method, isHeuristic: res.isHeuristic, reason: res.reason, windowDays,
          labelCohort: res.labelCohort, evaluation: res.evaluation,
          scores: res.customers.slice(0, 1000).map((c) => ({ customerId: c.customerId, risk: c.risk, band: c.band })) }]);
      await recordUsage(tx, ctx, { endpoint: 'customers/churn', provider: 'resuto-ai-service' });
      return this.data.customerNames(tx, ctx, top.map((c) => c.customerId));
    });
    return { ...res, currency: org.currency, customers: top.map((c) => ({ ...c, displayName: names.get(c.customerId) ?? null })) };
  }

  // -------------------------------------------------------------------------
  // Recommendations
  // -------------------------------------------------------------------------
  async recommendations(ctx: TenantContext, q: { branchId: string; productId?: string; customerId?: string; k: number }): Promise<RecommendationsResponse> {
    const prep = await this.db.scoped(ctx, async (tx) => {
      const b = await this.data.branch(tx, ctx, q.branchId);
      if (q.productId && !(await this.data.products(tx, ctx, [q.productId])).size) throw notFound('Product');
      if (q.customerId && !(await tx.maybeOne('select 1 from customers where id = $1 and org_id = $2', [q.customerId, ctx.orgId]))) throw notFound('Customer');
      const items = q.productId ? [q.productId] : await this.data.topProducts(tx, ctx, q.branchId, addDays(b.today, -56), b.today, 5);
      return { baskets: await this.data.baskets(tx, ctx, q.branchId), unavailable: await this.data.unavailableProducts(tx, ctx, q.branchId), items };
    });
    type Rec = { itemId: string; source: RecommendedItem['source']; [k: string]: unknown };
    const res = await this.ai.post<{ method: string; weights: Record<string, number>; items: Record<string, Rec[]>; customers: Record<string, Rec[]>;
      popular: Rec[]; stats: RecommendationsResponse['stats'] }>('/recommend/items', {
      baskets: prep.baskets.map((b) => ({ customerId: b.customerId ?? undefined, at: b.at, items: b.items.slice(0, 60) })),
      items: prep.items, customers: q.customerId ? [q.customerId] : [], unavailable: prep.unavailable, k: q.k, minPairCount: 2,
    });
    const allIds = new Set<string>([...prep.items, ...Object.values(res.items).flat().map((r) => r.itemId), ...res.popular.map((r) => r.itemId),
      ...Object.values(res.customers).flat().map((r) => r.itemId)]);
    const products = await this.db.scoped(ctx, async (tx) => {
      const p = await this.data.products(tx, ctx, [...allIds]);
      const modelId = await this.data.modelId(tx, 'recommendation', q.customerId ? 'hybrid_next_basket' : 'association_rules');
      await tx.query(
        `insert into ai_predictions(org_id, branch_id, model_id, kind, subject_type, subject_id, payload) values ($1, $2, $3, 'recommendation', $4, $5, $6)`,
        [ctx.orgId, q.branchId, modelId, q.customerId ? 'customer' : 'product', q.customerId ?? q.productId ?? null,
          { items: res.items, customers: res.customers, popular: res.popular, stats: res.stats, weights: res.weights }]);
      await recordUsage(tx, ctx, { endpoint: 'recommend/items', provider: 'resuto-ai-service' });
      return p;
    });
    const named = (r: Rec): RecommendedItem => {
      const { itemId, ...rest } = r;
      return { ...(rest as any), productId: itemId, name: products.get(itemId)?.name ?? itemId, nameAr: products.get(itemId)?.nameAr ?? null };
    };
    return {
      branchId: q.branchId, method: res.method, weights: res.weights, stats: res.stats,
      items: prep.items.map((id) => ({ productId: id, name: products.get(id)?.name ?? id, nameAr: products.get(id)?.nameAr ?? null,
        frequentlyBoughtWith: (res.items[id] ?? []).map(named) })),
      customer: q.customerId ? { customerId: q.customerId, nextItems: (res.customers[q.customerId] ?? []).map(named) } : null,
      popular: res.popular.map(named),
    };
  }

  // -------------------------------------------------------------------------
  // Route plan for one driver
  // -------------------------------------------------------------------------
  async routePlan(ctx: TenantContext, input: RoutePlanInput): Promise<RoutePlanResponse> {
    const prep = await this.db.scoped(ctx, async (tx) => {
      const b = await this.data.branch(tx, ctx, input.branchId);
      return { b, ...(await this.data.openJobs(tx, ctx, input.branchId, input.driverId, input.promiseMinutes)) };
    });
    const { b, driver, jobs } = prep;
    const routable = jobs.filter((j) => j.lat !== null && j.lng !== null);
    const skipped = jobs.filter((j) => j.lat === null || j.lng === null).map((j) => ({ jobId: j.id as string, reason: 'missing_coordinates' as const }));
    if (!routable.length) throw new DomainError('no_routable_jobs', 'This driver has no open delivery jobs with coordinates', 422, { skipped });
    const useDriver = driver.fresh && driver.lat !== null && driver.lng !== null;
    if (!useDriver && (b.lat === null || b.lng === null)) throw new DomainError('branch_location_missing', 'Set the branch location to plan routes', 422);
    const start = useDriver ? { lat: Number(driver.lat), lng: Number(driver.lng), source: 'driver_location' as const }
      : { lat: Number(b.lat), lng: Number(b.lng), source: 'branch' as const };
    const departAt = new Date().toISOString();
    const res = await this.ai.post<any>('/routing/optimize', {
      start: { lat: start.lat, lng: start.lng }, departAt, speedKmh: input.speedKmh, objective: input.objective,
      stops: routable.map((j) => ({ id: j.id, lat: j.lat, lng: j.lng, windowEnd: j.promised_at })),
    });
    const byId = new Map(routable.map((j, i) => [j.id as string, { j, naive: i + 1 }]));
    const legs = new Map<string, any>(res.route.legs.map((l: any) => [l.stopId, l]));
    const stops = (res.route.order as string[]).map((id, i) => {
      const { j, naive } = byId.get(id)!;
      const leg = legs.get(id);
      return { jobId: id, orderId: j.order_id, orderNumber: j.number, sequence: i + 1, naiveSequence: naive, lat: j.lat, lng: j.lng,
        address: j.address, promisedAt: j.promised_at, arrivesAt: leg?.arrivesAt ?? null, lateMinutes: leg?.lateMinutes ?? 0 };
    });
    const out = {
      driverId: input.driverId, branchId: input.branchId, method: res.method, objective: res.objective, start, stops, skipped,
      distanceKm: res.route.distanceKm, durationMinutes: res.route.durationMinutes,
      violations: res.route.violations.map((v: any) => ({ jobId: v.stopId, lateMinutes: v.lateMinutes })),
      naive: { distanceKm: res.naive.distanceKm, durationMinutes: res.naive.durationMinutes, violations: res.naive.violations.length },
      distanceSavingPct: res.distanceSavingPct, computationMs: res.computationMs, distanceModel: res.distanceModel,
    };
    const predictionId = await this.db.scoped(ctx, async (tx) => {
      const modelId = await this.data.modelId(tx, 'routing', 'nn_2opt');
      const row = await tx.one<{ id: string }>(
        `insert into ai_predictions(org_id, branch_id, model_id, kind, subject_type, subject_id, payload)
         values ($1, $2, $3, 'route_plan', 'driver', $4, $5) returning id`,
        [ctx.orgId, input.branchId, modelId, input.driverId, { ...out, stops: stops.map(({ address, ...s }) => s) }]);
      await recordUsage(tx, ctx, { endpoint: 'routing/optimize', provider: 'resuto-ai-service' });
      return row.id;
    });
    return { predictionId, ...out };
  }
}
