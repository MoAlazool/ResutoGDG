import { Injectable, Logger } from '@nestjs/common';
import {
  GoogleRoutesClient, haversineMeters, RoutingEngine, TtlCache, type DeliveryVehicle, type EtaAnswer, type PlanAnswer, type RoutePoint, type RouteSequenceInput,
} from '@resuto/integrations';
import { DbService } from '../../common/db/db.service';
import { DomainError } from '../../common/errors/domain-error';
import { IntegrationConnectionsService } from '../integrations/connections.service';

export const ROUTING_PROVIDER = 'google_routes';
/** Daily Routes requests per restaurant when the connection does not set `dailyRequestCap`. */
export const DEFAULT_DAILY_ROUTES_CAP = 300;
/** A job's ETA is re-asked from the provider at most this often while the driver moves (location batches arrive every ~15 s). */
export const ETA_REFRESH_MS = 2 * 60_000;
/**
 * A provider route plan is kept for the same set of stops (job ids + drop-off points) and re-asked only after this
 * long, or once the driver has moved this far from where it was planned. The driver app polls its jobs every 10 s with
 * the driver's latest position as origin, so keying the plan on the origin would call Google on nearly every poll.
 */
export const PLAN_REFRESH_MS = 10 * 60_000;
export const PLAN_REFRESH_DISTANCE_M = 2_000;
/** Route plans may use at most this share of the daily cap, so ETA refinements always keep a budget of their own. */
export const PLAN_SHARE_OF_CAP = 0.5;
export type RoutesRequestKind = 'plan' | 'eta';

/**
 * INT-29: route plans and ETAs for the driver app through the RoutingEngine. With an enabled, connected
 * `google_routes` connection (the restaurant's own key, BYOK) answers come from Google Routes, cached per restaurant
 * and capped per day (usage_events metric `maps_requests`, cost owner merchant); otherwise, at the cap or on any
 * provider error, the offline baseline answers and says why. Provider calls never run inside a transaction (PCL-11):
 * callers commit first, then ask, then store the ETA with a guarded update.
 */
@Injectable()
export class RoutingService {
  private readonly logger = new Logger('Routing');
  private readonly caches = new Map<string, TtlCache<unknown>>();
  private readonly lastEta = new Map<string, number>();
  private readonly plans = new Map<string, { at: number; origin: RoutePoint; answer: PlanAnswer }>();

  constructor(private readonly db: DbService, private readonly connections: IntegrationConnectionsService) {}

  private cacheFor(orgId: string) {
    let c = this.caches.get(orgId);
    if (!c) {
      if (this.caches.size > 5_000) this.caches.clear();
      this.caches.set(orgId, (c = new TtlCache(3 * 60_000, 500)));
    }
    return c;
  }

  /** The engine for one restaurant: provider only when its own connection is enabled and connected. */
  async engine(orgId: string, kind: RoutesRequestKind = 'eta'): Promise<RoutingEngine> {
    let provider: GoogleRoutesClient | null = null;
    let cap = DEFAULT_DAILY_ROUTES_CAP;
    try {
      const conn = await this.connections.load(orgId, { provider: ROUTING_PROVIDER });
      const key = conn.adapter.credentials.apiKey;
      if (conn.enabled && conn.status === 'connected' && key) {
        provider = new GoogleRoutesClient(key, conn.adapter.fetch);
        const c = Number(conn.config.dailyRequestCap);
        if (Number.isInteger(c) && c >= 0) cap = Math.min(c, 100_000);
      }
    } catch (e) {
      if (!(e instanceof DomainError && e.status === 404)) throw e;
    }
    return new RoutingEngine({
      provider, cache: this.cacheFor(orgId),
      reserve: () => this.reserve(orgId, cap, kind),
      onProviderError: (err) => this.logger.warn(`routes provider error for org ${orgId}: ${err.message}`),
    });
  }

  /**
   * Counts one provider request against today's cap (UTC day); false at the cap. Route plans are also held to their
   * own share of the cap (PLAN_SHARE_OF_CAP), so plans can never use up the budget ETA refinements need. Serialised
   * per restaurant.
   */
  async reserve(orgId: string, cap: number, kind: RoutesRequestKind = 'eta'): Promise<boolean> {
    if (cap <= 0) return false;
    return this.db.withTenant(orgId, async (tx) => {
      await tx.query(`select pg_advisory_xact_lock(hashtext('maps_requests:' || $1::text))`, [orgId]);
      const { n, plans } = await tx.one<{ n: number; plans: number }>(
        `select coalesce(sum(quantity), 0)::int as n, coalesce(sum(quantity) filter (where metadata->>'kind' = 'plan'), 0)::int as plans from usage_events
          where org_id = $1 and metric = 'maps_requests' and occurred_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'`, [orgId]);
      if (n >= cap) return false;
      if (kind === 'plan' && plans >= Math.floor(cap * PLAN_SHARE_OF_CAP)) return false;
      await tx.query(`insert into usage_events(org_id, metric, quantity, cost_owner, metadata) values ($1, 'maps_requests', 1, 'merchant', $2)`,
        [orgId, { provider: ROUTING_PROVIDER, kind }]);
      return true;
    }, 'routing');
  }

  /**
   * Multi-drop plan. A provider plan is reused for the same stops (ids + drop-off points) until PLAN_REFRESH_MS has
   * passed or the driver moved PLAN_REFRESH_DISTANCE_M from where it was planned; a new or finished job changes the
   * stop set and plans again. Baseline answers are cheap and never stored.
   */
  async plan(orgId: string, input: RouteSequenceInput): Promise<PlanAnswer> {
    const setKey = `${orgId}|${input.vehicle ?? ''}|${input.serviceSecondsPerStop ?? ''}|${[...input.stops].sort((a, b) => a.id.localeCompare(b.id))
      .map((s) => `${s.id}@${s.location.latitude.toFixed(4)},${s.location.longitude.toFixed(4)}`).join(';')}`;
    const now = Date.now();
    const memo = this.plans.get(setKey);
    if (memo && now - memo.at < PLAN_REFRESH_MS && haversineMeters(memo.origin, input.origin) < PLAN_REFRESH_DISTANCE_M) return { ...memo.answer, cached: true };
    const answer = await (await this.engine(orgId, 'plan')).plan(input);
    if (answer.source === 'google_routes') {
      if (this.plans.size > 5_000) this.plans.clear();
      this.plans.set(setKey, { at: now, origin: input.origin, answer });
    }
    return answer;
  }

  async eta(orgId: string, from: RoutePoint, to: RoutePoint, vehicle: DeliveryVehicle): Promise<EtaAnswer> {
    return (await this.engine(orgId)).eta(from, to, vehicle);
  }

  /**
   * After the caller's transaction: refines a moving job's ETA with the provider (throttled per job). The baseline ETA
   * the caller already stored stays when there is no provider answer. Only jobs still picked up / en route change.
   */
  async refreshJobEta(orgId: string, jobId: string, from: RoutePoint | null, vehicle: DeliveryVehicle, opts: { force?: boolean } = {}): Promise<EtaAnswer | null> {
    if (!from) return null;
    const now = Date.now();
    if (!opts.force && now - (this.lastEta.get(jobId) ?? 0) < ETA_REFRESH_MS) return null;
    const job = await this.db.withTenant(orgId, (tx) => tx.maybeOne<{ lat: string | null; lng: string | null; status: string }>(
      `select dropoff_latitude as lat, dropoff_longitude as lng, status::text from delivery_jobs where id = $1 and org_id = $2`, [jobId, orgId]), 'routing');
    if (!job || job.lat === null || job.lng === null || !['picked_up', 'en_route'].includes(job.status)) return null;
    const engine = await this.engine(orgId, 'eta');
    if (this.lastEta.size > 20_000) this.lastEta.clear();
    this.lastEta.set(jobId, now);
    const answer = await engine.eta(from, { latitude: Number(job.lat), longitude: Number(job.lng) }, vehicle);
    // The baseline was already written by the caller; only a provider answer replaces it.
    if (answer.source !== 'google_routes') return answer;
    await this.db.withTenant(orgId, (tx) => tx.query(
      `update delivery_jobs set eta_at = $3 where id = $1 and org_id = $2 and status in ('picked_up', 'en_route')`,
      [jobId, orgId, new Date(Date.now() + answer.seconds * 1000)]), 'routing');
    return answer;
  }
}
