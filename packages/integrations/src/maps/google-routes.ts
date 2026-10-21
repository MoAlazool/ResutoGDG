// Google Maps Platform Routes API adapter (INT-29). Optional: used only when a restaurant connects its OWN Google Cloud
// API key (BYOK: Google bills that project; Resuto never funds routing calls). The key stays server-side (sealed
// connection credential); browsers only ever get the keyless navigation link from ./index.
//
// Docs (checked 2026-10-21):
//   computeRoutes  POST https://routes.googleapis.com/directions/v2:computeRoutes
//     headers X-Goog-Api-Key, X-Goog-FieldMask (required; no default field set)
//     body origin/destination/intermediates[] { location: { latLng: { latitude, longitude } } }, travelMode
//       (DRIVE, TWO_WHEELER, BICYCLE, WALK), routingPreference (TRAFFIC_UNAWARE | TRAFFIC_AWARE | TRAFFIC_AWARE_OPTIMAL,
//       only with DRIVE / TWO_WHEELER), optimizeWaypointOrder (needs routes.optimizedIntermediateWaypointIndex in the
//       field mask, not with TRAFFIC_AWARE_OPTIMAL, max 25 intermediates)
//     response routes[].duration ("123s"), routes[].distanceMeters, routes[].legs[].{duration,distanceMeters},
//       routes[].optimizedIntermediateWaypointIndex[]
//     https://developers.google.com/maps/documentation/routes/reference/rest/v2/TopLevel/computeRoutes
//     https://developers.google.com/maps/documentation/routes/compute_route_directions
//     https://developers.google.com/maps/documentation/routes/opt-way (waypoint optimisation is billed at a higher SKU)
//   Billing / quotas are set per Google Cloud project: https://developers.google.com/maps/documentation/routes/usage-and-billing
import { ProviderError, type AdapterContext, type HealthCheckResult, type ProviderDescriptor } from '../core';
import { nearestNeighbourSequencer, type DeliveryVehicle, type RoutePlan, type RoutePoint, type RouteSequenceInput } from './index';

export const GOOGLE_ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
/** Documented limit on intermediate waypoints per computeRoutes request. */
export const GOOGLE_ROUTES_MAX_INTERMEDIATES = 25;

export const googleRoutesDescriptor: ProviderDescriptor = {
  id: 'google_routes',
  name: 'Google Maps Routes (your own API key)',
  category: 'delivery',
  countries: ['EG', 'SA'],
  authType: 'api_key',
  readiness: 'implemented_unverified',
  activation: [
    'In the restaurant\'s own Google Cloud project: enable the Routes API, create an API key restricted to the Routes API (server key, no HTTP-referrer restriction) and set a daily quota in the Cloud console.',
    'Paste the key in Resuto → Integrations → Google Maps Routes and set the daily request cap (Resuto stops calling Google at the cap and uses the labelled baseline).',
    'Run the health check (one computeRoutes request, billed by Google to that project).',
  ],
  docsUrl: 'https://developers.google.com/maps/documentation/routes/compute_route_directions',
  capabilities: ['route_eta', 'multi_drop_optimised_order'],
};

type TravelMode = 'DRIVE' | 'TWO_WHEELER' | 'BICYCLE' | 'WALK';
const MODE: Record<DeliveryVehicle, TravelMode> = { motorbike: 'TWO_WHEELER', scooter: 'TWO_WHEELER', car: 'DRIVE', van: 'DRIVE', bicycle: 'BICYCLE', on_foot: 'WALK' };
export const travelModeFor = (v: DeliveryVehicle): TravelMode => MODE[v] ?? 'DRIVE';

const waypoint = (p: RoutePoint) => ({ location: { latLng: { latitude: p.latitude, longitude: p.longitude } } });

/** "123.5s" → 124 (Duration JSON encoding). */
export function parseDurationSeconds(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d+(?:\.\d+)?)s$/.exec(v.trim());
  return m ? Math.round(Number(m[1])) : null;
}

export interface ComputedRoute {
  durationSeconds: number;
  distanceMeters: number;
  legs: Array<{ durationSeconds: number; distanceMeters: number }>;
  /** Visiting order of the intermediates (zero-based), when optimisation was requested. */
  optimizedOrder: number[] | null;
}

export class GoogleRoutesClient {
  constructor(private readonly apiKey: string, private readonly http: typeof fetch, private readonly timeoutMs = 8_000) {
    if (!apiKey) throw new ProviderError('google_routes', 'no API key configured', false);
  }

  async computeRoute(req: { origin: RoutePoint; destination: RoutePoint; intermediates?: RoutePoint[]; vehicle: DeliveryVehicle; optimize?: boolean; trafficAware?: boolean })
    : Promise<ComputedRoute> {
    const intermediates = req.intermediates ?? [];
    if (intermediates.length > GOOGLE_ROUTES_MAX_INTERMEDIATES) throw new ProviderError('google_routes', 'too many stops for one request', false);
    const mode = travelModeFor(req.vehicle);
    const optimize = !!req.optimize && intermediates.length >= 2;
    const fields = ['routes.duration', 'routes.distanceMeters', 'routes.legs.duration', 'routes.legs.distanceMeters', ...(optimize ? ['routes.optimizedIntermediateWaypointIndex'] : [])];
    const body = {
      origin: waypoint(req.origin), destination: waypoint(req.destination),
      ...(intermediates.length ? { intermediates: intermediates.map(waypoint) } : {}),
      travelMode: mode,
      // routingPreference is only valid for DRIVE / TWO_WHEELER; TRAFFIC_AWARE_OPTIMAL is not allowed with optimisation.
      ...(mode === 'DRIVE' || mode === 'TWO_WHEELER' ? { routingPreference: req.trafficAware === false ? 'TRAFFIC_UNAWARE' : 'TRAFFIC_AWARE' } : {}),
      ...(optimize ? { optimizeWaypointOrder: true } : {}),
      units: 'METRIC',
    };
    let res: Response;
    try {
      res = await this.http(GOOGLE_ROUTES_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': this.apiKey, 'X-Goog-FieldMask': fields.join(',') },
        body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new ProviderError('google_routes', `network error (${(e as Error).name})`, true);
    }
    const text = await res.text();
    // Never echo the body: Google's error text can quote the request.
    if (!res.ok) throw new ProviderError('google_routes', `HTTP ${res.status}`, res.status === 429 || res.status >= 500, res.status);
    let json: any;
    try { json = JSON.parse(text || '{}'); } catch { throw new ProviderError('google_routes', 'non-JSON response', true); }
    const route = Array.isArray(json?.routes) ? json.routes[0] : null;
    if (!route) throw new ProviderError('google_routes', 'no route found', false);
    const durationSeconds = parseDurationSeconds(route.duration);
    const distanceMeters = Number(route.distanceMeters);
    if (durationSeconds === null || !Number.isFinite(distanceMeters)) throw new ProviderError('google_routes', 'unexpected response shape', false);
    const legs = (Array.isArray(route.legs) ? route.legs : []).map((l: any) => ({
      durationSeconds: parseDurationSeconds(l?.duration) ?? 0, distanceMeters: Number(l?.distanceMeters) || 0,
    }));
    const order = Array.isArray(route.optimizedIntermediateWaypointIndex) ? route.optimizedIntermediateWaypointIndex.map(Number) : null;
    if (optimize) {
      const valid = order && order.length === intermediates.length && [...order].sort((a, b) => a - b).every((v, i) => v === i);
      if (!valid) throw new ProviderError('google_routes', 'invalid optimised order', false);
    }
    if (legs.length !== intermediates.length + 1) throw new ProviderError('google_routes', 'unexpected number of legs', false);
    return { durationSeconds, distanceMeters: Math.round(distanceMeters), legs, optimizedOrder: optimize ? order : null };
  }

  /**
   * Multi-drop plan: the baseline's last stop is kept as the destination (the Routes API needs one) and Google
   * optimises the order of the others. Leg times are Google's (traffic-aware for motor vehicles) plus the handling time.
   */
  async plan(input: RouteSequenceInput): Promise<RoutePlan> {
    const { origin, stops, vehicle = 'motorbike', serviceSecondsPerStop = 180 } = input;
    if (!stops.length) return { algorithm: 'google_routes_v1', order: [], legs: [], totalDistanceM: 0, totalSeconds: 0 };
    const baseline = nearestNeighbourSequencer.sequence(input);
    const byId = new Map(stops.map((s) => [s.id, s]));
    const last = byId.get(baseline.order.at(-1)!)!;
    const middle = baseline.order.slice(0, -1).map((id) => byId.get(id)!);
    const r = await this.computeRoute({ origin, destination: last.location, intermediates: middle.map((s) => s.location), vehicle, optimize: middle.length >= 2 });
    const visit = [...(r.optimizedOrder ?? middle.map((_, i) => i)).map((i) => middle[i]!), last];
    let elapsed = 0;
    const legs = visit.map((s, i) => {
      const leg = r.legs[i]!;
      elapsed += leg.durationSeconds;
      const out = { stopId: s.id, distanceM: leg.distanceMeters, travelSeconds: leg.durationSeconds, arrivalOffsetSeconds: elapsed };
      elapsed += serviceSecondsPerStop;
      return out;
    });
    return { algorithm: r.optimizedOrder ? 'google_routes_optimized_v1' : 'google_routes_v1', order: visit.map((s) => s.id), legs, totalDistanceM: r.distanceMeters, totalSeconds: elapsed };
  }
}

/** One short computeRoutes request between two fixed points in Cairo (billed by Google as one Routes request). */
export async function googleRoutesHealthCheck(ctx: AdapterContext): Promise<HealthCheckResult> {
  const key = ctx.credentials.apiKey;
  if (!key) return { ok: false, details: { reason: 'missing_api_key' } };
  const r = await new GoogleRoutesClient(key, ctx.fetch).computeRoute({
    origin: { latitude: 30.0444, longitude: 31.2357 }, destination: { latitude: 30.0511, longitude: 31.2435 }, vehicle: 'car', trafficAware: false,
  });
  return { ok: true, details: { durationSeconds: r.durationSeconds, distanceMeters: r.distanceMeters } };
}

export const routingAdapters = [{ descriptor: googleRoutesDescriptor, healthCheck: googleRoutesHealthCheck }];
