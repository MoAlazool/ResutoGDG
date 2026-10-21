import { Injectable, Logger } from '@nestjs/common';
import {
  GoogleRoutesClient, RoutingEngine, TtlCache, type DeliveryVehicle, type EtaAnswer, type PlanAnswer, type RoutePoint, type RouteSequenceInput,
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
  async engine(orgId: string): Promise<RoutingEngine> {
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
      reserve: () => this.reserve(orgId, cap),
      onProviderError: (err) => this.logger.warn(`routes provider error for org ${orgId}: ${err.message}`),
    });
  }

  /** Counts one provider request against today's cap (UTC day); false at the cap. Serialised per restaurant. */
  async reserve(orgId: string, cap: number): Promise<boolean> {
    if (cap <= 0) return false;
    return this.db.withTenant(orgId, async (tx) => {
      await tx.query(`select pg_advisory_xact_lock(hashtext('maps_requests:' || $1::text))`, [orgId]);
      const { n } = await tx.one<{ n: number }>(
        `select coalesce(sum(quantity), 0)::int as n from usage_events
          where org_id = $1 and metric = 'maps_requests' and occurred_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'`, [orgId]);
      if (n >= cap) return false;
      await tx.query(`insert into usage_events(org_id, metric, quantity, cost_owner, metadata) values ($1, 'maps_requests', 1, 'merchant', $2)`,
        [orgId, { provider: ROUTING_PROVIDER }]);
      return true;
    }, 'routing');
  }

  async plan(orgId: string, input: RouteSequenceInput): Promise<PlanAnswer> {
    return (await this.engine(orgId)).plan(input);
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
    const engine = await this.engine(orgId);
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
