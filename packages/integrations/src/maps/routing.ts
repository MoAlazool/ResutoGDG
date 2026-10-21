// Routing engine (INT-29): one ETA + multi-drop interface over an optional provider (Google Routes with the
// restaurant's own key) and the offline baseline (haversine × road factor, nearest neighbour). Every answer says which
// one produced it; the baseline is a labelled fallback, never presented as provider data.
//
// Cost control: answers are cached (coordinates rounded to ~11 m, short TTL because traffic changes), and every
// provider call first asks `reserve()` (the API backs it with a per-restaurant daily cap); at the cap, or on any
// provider error, the baseline answers with the reason.
import { ProviderError } from '../core';
import { estimateTravelSeconds, haversineMeters, nearestNeighbourSequencer, type DeliveryVehicle, type RoutePlan, type RoutePoint, type RouteSequenceInput } from './index';

export type RoutingSource = 'google_routes' | 'baseline';
export type RoutingFallbackReason = 'not_configured' | 'quota_exhausted' | 'provider_error' | 'too_many_stops';

export interface EtaAnswer { seconds: number; distanceM: number; source: RoutingSource; fallbackReason: RoutingFallbackReason | null; cached: boolean }
export interface PlanAnswer extends RoutePlan { source: RoutingSource; fallbackReason: RoutingFallbackReason | null; cached: boolean }

/** A provider behind the engine (GoogleRoutesClient satisfies it). */
export interface RoutingProvider {
  computeRoute(req: { origin: RoutePoint; destination: RoutePoint; vehicle: DeliveryVehicle }): Promise<{ durationSeconds: number; distanceMeters: number }>;
  plan(input: RouteSequenceInput): Promise<RoutePlan>;
}

/** Small TTL + size-bounded cache (insertion order eviction). */
export class TtlCache<V> {
  private readonly map = new Map<string, { v: V; exp: number }>();
  constructor(private readonly ttlMs: number, private readonly max = 1_000, private readonly now = () => Date.now()) {}
  get(k: string): V | undefined {
    const e = this.map.get(k);
    if (!e) return undefined;
    if (e.exp <= this.now()) { this.map.delete(k); return undefined; }
    return e.v;
  }
  set(k: string, v: V) {
    this.map.delete(k);
    this.map.set(k, { v, exp: this.now() + this.ttlMs });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }
  get size() { return this.map.size; }
}

const r4 = (p: RoutePoint) => `${p.latitude.toFixed(4)},${p.longitude.toFixed(4)}`;

export interface RoutingEngineOptions {
  /** null: no provider configured (baseline, fallbackReason not_configured). */
  provider: RoutingProvider | null;
  /** Called before each provider request; false = cap reached. */
  reserve?: () => Promise<boolean>;
  /** Shared cache (per restaurant); a fresh one per engine when omitted. */
  cache?: TtlCache<unknown>;
  /** Called with the provider error (already key-free) for logging. */
  onProviderError?: (e: ProviderError) => void;
  maxStops?: number;
}

export function baselineEta(origin: RoutePoint, destination: RoutePoint, vehicle: DeliveryVehicle) {
  const d = haversineMeters(origin, destination);
  return { seconds: estimateTravelSeconds(d, vehicle), distanceM: Math.round(d) };
}

export class RoutingEngine {
  private readonly cache: TtlCache<unknown>;
  constructor(private readonly opts: RoutingEngineOptions) {
    this.cache = opts.cache ?? new TtlCache(3 * 60_000);
  }

  async eta(origin: RoutePoint, destination: RoutePoint, vehicle: DeliveryVehicle): Promise<EtaAnswer> {
    const fallback = (reason: RoutingFallbackReason): EtaAnswer => ({ ...baselineEta(origin, destination, vehicle), source: 'baseline', fallbackReason: reason, cached: false });
    if (!this.opts.provider) return fallback('not_configured');
    const key = `eta|${vehicle}|${r4(origin)}|${r4(destination)}`;
    const hit = this.cache.get(key) as EtaAnswer | undefined;
    if (hit) return { ...hit, cached: true };
    return this.call(key, fallback, async (p) => {
      const r = await p.computeRoute({ origin, destination, vehicle });
      return { seconds: r.durationSeconds, distanceM: r.distanceMeters, source: 'google_routes', fallbackReason: null, cached: false } as EtaAnswer;
    });
  }

  async plan(input: RouteSequenceInput): Promise<PlanAnswer> {
    const fallback = (reason: RoutingFallbackReason): PlanAnswer => ({ ...nearestNeighbourSequencer.sequence(input), source: 'baseline', fallbackReason: reason, cached: false });
    if (!this.opts.provider) return fallback('not_configured');
    if (input.stops.length > (this.opts.maxStops ?? 26)) return fallback('too_many_stops');
    const stopsKey = [...input.stops].sort((a, b) => a.id.localeCompare(b.id)).map((s) => `${s.id}@${r4(s.location)}`).join(';');
    const key = `plan|${input.vehicle ?? 'motorbike'}|${input.serviceSecondsPerStop ?? 180}|${r4(input.origin)}|${stopsKey}`;
    const hit = this.cache.get(key) as PlanAnswer | undefined;
    if (hit) return { ...hit, cached: true };
    return this.call(key, fallback, async (p) => ({ ...(await p.plan(input)), source: 'google_routes', fallbackReason: null, cached: false } as PlanAnswer));
  }

  private async call<T>(key: string, fallback: (r: RoutingFallbackReason) => T, run: (p: RoutingProvider) => Promise<T>): Promise<T> {
    if (this.opts.reserve && !(await this.opts.reserve())) return fallback('quota_exhausted');
    try {
      const out = await run(this.opts.provider!);
      this.cache.set(key, out);
      return out;
    } catch (e) {
      const pe = e instanceof ProviderError ? e : new ProviderError('google_routes', 'unexpected error', false);
      this.opts.onProviderError?.(pe);
      return fallback('provider_error');
    }
  }
}
