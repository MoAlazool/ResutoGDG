import { describe, expect, it } from 'vitest';
import { runAcceptance } from '../acceptance';
import { mapsChecks } from '../acceptance/maps';
import { scriptedFetch } from '../messaging/testing/scripted-fetch';
import { GoogleRoutesClient, googleRoutesHealthCheck, parseDurationSeconds, travelModeFor } from './google-routes';
import { RoutingEngine, TtlCache } from './routing';
import { nearestNeighbourSequencer } from './index';

const KEY = 'AIzaROUTES-fake-000000000000';
const origin = { latitude: 30.0444, longitude: 31.2357 };
const stops = [
  { id: 'a', location: { latitude: 30.0626, longitude: 31.2197 } },
  { id: 'b', location: { latitude: 30.0366, longitude: 31.2316 } },
  { id: 'c', location: { latitude: 30.0385, longitude: 31.2123 } },
];
const route = (legs: Array<[number, number]>, order?: number[]) => ({
  body: { routes: [{
    duration: `${legs.reduce((s, l) => s + l[0], 0)}s`, distanceMeters: legs.reduce((s, l) => s + l[1], 0),
    legs: legs.map(([d, m]) => ({ duration: `${d}s`, distanceMeters: m })), ...(order ? { optimizedIntermediateWaypointIndex: order } : {}),
  }] },
});

describe('Google Routes client (INT-29)', () => {
  it('sends the documented computeRoutes request: key + field mask headers, latLng waypoints, traffic-aware two-wheeler', async () => {
    const { fetch, calls } = scriptedFetch([route([[612.4, 3100]])]);
    const r = await new GoogleRoutesClient(KEY, fetch).computeRoute({ origin, destination: stops[0]!.location, vehicle: 'motorbike' });
    expect(calls[0].url).toBe('https://routes.googleapis.com/directions/v2:computeRoutes');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers['x-goog-api-key']).toBe(KEY);
    expect(calls[0].headers['x-goog-fieldmask']).toBe('routes.duration,routes.distanceMeters,routes.legs.duration,routes.legs.distanceMeters');
    const body = JSON.parse(calls[0].body!);
    expect(body.origin).toEqual({ location: { latLng: { latitude: 30.0444, longitude: 31.2357 } } });
    expect(body.travelMode).toBe('TWO_WHEELER');
    expect(body.routingPreference).toBe('TRAFFIC_AWARE');
    expect(body.optimizeWaypointOrder).toBeUndefined();
    expect(r).toEqual({ durationSeconds: 612, distanceMeters: 3100, legs: [{ durationSeconds: 612, distanceMeters: 3100 }], optimizedOrder: null });
  });

  it('omits routingPreference for modes that do not accept it', async () => {
    const { fetch, calls } = scriptedFetch([route([[900, 2000]])]);
    await new GoogleRoutesClient(KEY, fetch).computeRoute({ origin, destination: stops[0]!.location, vehicle: 'bicycle' });
    const body = JSON.parse(calls[0].body!);
    expect(body.travelMode).toBe('BICYCLE');
    expect(body.routingPreference).toBeUndefined();
    expect(travelModeFor('on_foot')).toBe('WALK');
    expect(travelModeFor('van')).toBe('DRIVE');
  });

  it('plans multi-drop with waypoint optimisation and maps the optimised order back to stop ids', async () => {
    const baseline = nearestNeighbourSequencer.sequence({ origin, stops });
    // Destination = baseline's last stop; the two others are intermediates; Google says visit intermediate 1 then 0.
    const { fetch, calls } = scriptedFetch([route([[300, 1000], [400, 1500], [500, 2000]], [1, 0])]);
    const plan = await new GoogleRoutesClient(KEY, fetch).plan({ origin, stops, vehicle: 'car', serviceSecondsPerStop: 60 });
    const body = JSON.parse(calls[0].body!);
    expect(body.optimizeWaypointOrder).toBe(true);
    expect(calls[0].headers['x-goog-fieldmask']).toContain('routes.optimizedIntermediateWaypointIndex');
    expect(body.intermediates).toHaveLength(2);
    const middle = baseline.order.slice(0, -1);
    expect(plan.order).toEqual([middle[1], middle[0], baseline.order.at(-1)]);
    expect(plan.algorithm).toBe('google_routes_optimized_v1');
    expect(plan.legs.map((l) => l.arrivalOffsetSeconds)).toEqual([300, 300 + 60 + 400, 300 + 60 + 400 + 60 + 500]);
    expect(plan.totalDistanceM).toBe(4500);
  });

  it('rejects an invalid optimised order and an unexpected number of legs', async () => {
    const bad1 = scriptedFetch([route([[1, 1], [1, 1], [1, 1]], [0, 0])]);
    await expect(new GoogleRoutesClient(KEY, bad1.fetch).plan({ origin, stops })).rejects.toThrow('invalid optimised order');
    const bad2 = scriptedFetch([route([[1, 1]])]);
    await expect(new GoogleRoutesClient(KEY, bad2.fetch).computeRoute({ origin, destination: stops[0]!.location, intermediates: [stops[1]!.location], vehicle: 'car' }))
      .rejects.toThrow('unexpected number of legs');
  });

  it('never echoes Google error bodies, and fails closed without a key', async () => {
    const { fetch } = scriptedFetch([{ status: 403, body: { error: { message: `API key ${KEY} is not authorized` } } }]);
    const err = await new GoogleRoutesClient(KEY, fetch).computeRoute({ origin, destination: stops[0]!.location, vehicle: 'car' }).catch((e) => e);
    expect(err.message).toBe('google_routes: HTTP 403');
    expect(() => new GoogleRoutesClient('', fetch)).toThrow('no API key configured');
    expect(await googleRoutesHealthCheck({ environment: 'live', credentials: {}, config: {}, fetch })).toEqual({ ok: false, details: { reason: 'missing_api_key' } });
  });

  it('parses Duration strings', () => {
    expect(parseDurationSeconds('165s')).toBe(165);
    expect(parseDurationSeconds('3.5s')).toBe(4);
    expect(parseDurationSeconds('PT3M')).toBeNull();
    expect(parseDurationSeconds(12)).toBeNull();
  });
});

describe('RoutingEngine', () => {
  const provider = (fetch: typeof globalThis.fetch) => new GoogleRoutesClient(KEY, fetch);

  it('uses the labelled baseline when no provider is configured', async () => {
    const e = new RoutingEngine({ provider: null });
    const eta = await e.eta(origin, stops[0]!.location, 'motorbike');
    expect(eta).toMatchObject({ source: 'baseline', fallbackReason: 'not_configured' });
    expect(eta.seconds).toBeGreaterThan(0);
    const plan = await e.plan({ origin, stops });
    expect(plan).toMatchObject({ source: 'baseline', fallbackReason: 'not_configured', algorithm: 'nearest_neighbour_v1' });
  });

  it('caches provider answers (coordinates rounded to ~11 m) and stops calling at the daily cap', async () => {
    const { fetch, calls } = scriptedFetch([route([[600, 3000]])]);
    let allowance = 1;
    const e = new RoutingEngine({ provider: provider(fetch), reserve: async () => allowance-- > 0 });
    const first = await e.eta(origin, stops[0]!.location, 'car');
    expect(first).toMatchObject({ source: 'google_routes', seconds: 600, cached: false });
    const again = await e.eta({ latitude: 30.04441, longitude: 31.23571 }, stops[0]!.location, 'car');
    expect(again).toMatchObject({ source: 'google_routes', cached: true });
    expect(calls).toHaveLength(1);
    const other = await e.eta(origin, stops[1]!.location, 'car');
    expect(other).toMatchObject({ source: 'baseline', fallbackReason: 'quota_exhausted' });
    expect(calls).toHaveLength(1);
  });

  it('falls back to the baseline on provider errors and reports them', async () => {
    const errors: string[] = [];
    const { fetch } = scriptedFetch([{ status: 500, body: {} }]);
    const e = new RoutingEngine({ provider: provider(fetch), onProviderError: (x) => errors.push(x.message) });
    const plan = await e.plan({ origin, stops });
    expect(plan).toMatchObject({ source: 'baseline', fallbackReason: 'provider_error', algorithm: 'nearest_neighbour_v1' });
    expect(errors).toEqual(['google_routes: HTTP 500']);
  });

  it('refuses to send more stops than one request allows', async () => {
    const { fetch, calls } = scriptedFetch([route([[1, 1]])]);
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, location: { latitude: 30 + i / 1000, longitude: 31.2 } }));
    const plan = await new RoutingEngine({ provider: provider(fetch) }).plan({ origin, stops: many });
    expect(plan.fallbackReason).toBe('too_many_stops');
    expect(calls).toHaveLength(0);
  });

  it('TtlCache expires entries and bounds its size', () => {
    let now = 0;
    const c = new TtlCache<number>(1000, 2, () => now);
    c.set('a', 1); c.set('b', 2); c.set('c', 3);
    expect(c.get('a')).toBeUndefined();
    expect(c.get('c')).toBe(3);
    now = 1001;
    expect(c.get('c')).toBeUndefined();
  });
});

describe('google_routes acceptance check', () => {
  it('is not_run without GOOGLE_ROUTES_API_KEY', async () => {
    const [r] = await runAcceptance(mapsChecks, { mode: 'official_test', env: {} });
    expect(r).toMatchObject({ status: 'not_run', reason: 'not configured: GOOGLE_ROUTES_API_KEY' });
  });

  it('passes against a scripted transport', async () => {
    const { fetch } = scriptedFetch([route([[600, 3000]]), route([[300, 1000], [400, 1500], [500, 2000]], [1, 0])]);
    const [r] = await runAcceptance(mapsChecks, { mode: 'official_test', env: { GOOGLE_ROUTES_API_KEY: KEY }, fetch });
    expect(r.status).toBe('passed');
    expect(JSON.stringify(r.evidence)).not.toContain(KEY);
  });
});
