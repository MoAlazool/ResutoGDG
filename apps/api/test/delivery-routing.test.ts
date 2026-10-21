// INT-29: optional Google Routes (restaurant-owned key) behind the driver route plan and ETA, with a daily cap,
// caching and the labelled offline baseline as fallback. No real request is made: ProviderHttp is scripted.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { scriptedFetch } from './growth-helpers';
import { TenantContext } from '../src/common/auth/context';
import { DbService } from '../src/common/db/db.service';
import { EventDispatcher } from '../src/common/events/dispatcher.service';
import { RoutingService } from '../src/modules/delivery/routing.service';
import { ProviderHttp } from '../src/modules/integrations/provider-http';
import { OrdersKernelService } from '../src/modules/kernel/orders-kernel.service';
import { addMember, auth, bootTestApp, createTenant, seedMenu, sql, type SeededMenu, type TestApp, type TestTenant, type TestUser } from './helpers';

let t: TestApp;
let http: ProviderHttp;
let original: typeof fetch;
let routing: RoutingService;

const origin = { latitude: 30.0444, longitude: 31.2357 };
const drop = { latitude: 30.0626, longitude: 31.2197 };
const route = (legs: Array<[number, number]>) => ({ body: { routes: [{
  duration: `${legs.reduce((s, l) => s + l[0], 0)}s`, distanceMeters: legs.reduce((s, l) => s + l[1], 0), legs: legs.map(([d, m]) => ({ duration: `${d}s`, distanceMeters: m })),
}] } });

beforeAll(async () => {
  t = await bootTestApp();
  http = t.app.get(ProviderHttp);
  original = http.fetch;
  routing = t.app.get(RoutingService);
});
afterEach(() => { http.fetch = original; });
afterAll(async () => { await t.close(); });

async function connectRoutes(tenant: TestTenant, config: Record<string, unknown> = {}, status = 'connected') {
  const c = await t.http.post(`/v1/o/${tenant.orgId}/integrations/connections`).set(auth(tenant.owner))
    .send({ provider: 'google_routes', environment: 'live', credentials: { apiKey: 'AIzaROUTES-test-key-000000' }, config });
  expect(c.status).toBe(201);
  await sql(`update integration_connections set status = $2 where id = $1`, [c.body.id, status]);
  return c.body.id as string;
}
const used = async (orgId: string) => (await sql<{ n: number }>(
  `select coalesce(sum(quantity), 0)::int as n from usage_events where org_id = $1 and metric = 'maps_requests' and cost_owner = 'merchant'`, [orgId]))[0]!.n;

describe('RoutingService (INT-29)', () => {
  it('answers with the labelled baseline when the restaurant has no routing connection (no request made)', async () => {
    const tenant = await createTenant(t);
    const f = scriptedFetch([route([[1, 1]])]);
    http.fetch = f.fetch;
    const eta = await routing.eta(tenant.orgId, origin, drop, 'motorbike');
    expect(eta).toMatchObject({ source: 'baseline', fallbackReason: 'not_configured' });
    expect(eta.seconds).toBeGreaterThan(0);
    expect(f.calls).toHaveLength(0);
    expect(await used(tenant.orgId)).toBe(0);
  });

  it('uses Google Routes with the restaurant key, meters each request as merchant cost and caches answers', async () => {
    const tenant = await createTenant(t);
    await connectRoutes(tenant);
    const f = scriptedFetch([route([[640, 3200]])]);
    http.fetch = f.fetch;
    const first = await routing.eta(tenant.orgId, origin, drop, 'car');
    expect(first).toMatchObject({ source: 'google_routes', seconds: 640, distanceM: 3200, cached: false });
    expect(f.calls[0]!.headers['x-goog-api-key']).toBe('AIzaROUTES-test-key-000000');
    const again = await routing.eta(tenant.orgId, origin, drop, 'car');
    expect(again).toMatchObject({ source: 'google_routes', cached: true });
    expect(f.calls).toHaveLength(1);
    expect(await used(tenant.orgId)).toBe(1);
  });

  it('stops calling Google at the daily cap and says so', async () => {
    const tenant = await createTenant(t);
    await connectRoutes(tenant, { dailyRequestCap: 1 });
    const f = scriptedFetch([route([[100, 900]])]);
    http.fetch = f.fetch;
    expect((await routing.eta(tenant.orgId, origin, drop, 'car')).source).toBe('google_routes');
    const capped = await routing.eta(tenant.orgId, origin, { latitude: 30.0366, longitude: 31.2316 }, 'car');
    expect(capped).toMatchObject({ source: 'baseline', fallbackReason: 'quota_exhausted' });
    expect(f.calls).toHaveLength(1);
    expect(await used(tenant.orgId)).toBe(1);
  });

  it('ignores a disabled or unhealthy connection and falls back on provider errors', async () => {
    const tenant = await createTenant(t);
    const id = await connectRoutes(tenant, {}, 'error');
    const f = scriptedFetch([{ status: 403, body: { error: { message: 'API key not valid' } } }]);
    http.fetch = f.fetch;
    expect((await routing.eta(tenant.orgId, origin, drop, 'car')).fallbackReason).toBe('not_configured');
    await sql(`update integration_connections set status = 'connected' where id = $1`, [id]);
    const failed = await routing.eta(tenant.orgId, origin, drop, 'car');
    expect(failed).toMatchObject({ source: 'baseline', fallbackReason: 'provider_error' });
    expect(f.calls).toHaveLength(1);
  });
});

describe('driver app with Google Routes', () => {
  let tenant: TestTenant;
  let menu: SeededMenu;
  let ownerCtx: TenantContext;
  let manager: TestUser;
  let driver: TestUser;
  let driverId: string;

  beforeAll(async () => {
    tenant = await createTenant(t, { country: 'EG' });
    menu = await seedMenu(tenant);
    ownerCtx = new TenantContext(tenant.orgId, 'owner', null, tenant.owner.userId, 'user', tenant.owner.userId);
    await sql(`update branches set latitude = 30.0444, longitude = 31.2357 where id = $1`, [tenant.branchId]);
    manager = await addMember(t, tenant, 'manager');
    driver = await addMember(t, tenant, 'driver', [tenant.branchId]);
    driverId = (await sql(`select id from drivers where org_id = $1 and user_id = $2`, [tenant.orgId, driver.userId]))[0].id;
    await t.http.patch(`/v1/o/${tenant.orgId}/driver/me/availability`).set(auth(driver)).send({ availability: 'available' }).expect(200);
  });

  async function acceptedJob(lat: number, lng: number) {
    const db = t.app.get(DbService);
    const o = await db.scoped(ownerCtx, (tx) => t.app.get(OrdersKernelService).place(tx, ownerCtx, {
      branchId: tenant.branchId, channel: 'web', fulfillment: 'delivery', lines: [{ productId: menu.products.fries, quantity: 1 }],
      customer: { name: 'Salma', phone: '+201005550001' }, deliveryAddress: { line1: '5 Tahrir Sq', city: 'Cairo', latitude: lat, longitude: lng },
      initialStatus: 'placed',
    }));
    await t.app.get(EventDispatcher).drain();
    const job = (await sql(`select id from delivery_jobs where order_id = $1`, [o.id]))[0];
    await t.http.post(`/v1/o/${tenant.orgId}/delivery/jobs/${job.id}/assign`).set(auth(manager)).send({ driverId }).expect(200);
    await t.http.post(`/v1/o/${tenant.orgId}/driver/jobs/${job.id}/accept`).set(auth(driver)).send({}).expect(200);
    return { orderId: o.id as string, jobId: job.id as string };
  }

  it('labels the multi-drop plan with its source: baseline without a connection, Google Routes with one', async () => {
    await acceptedJob(30.0626, 31.2197);
    await acceptedJob(30.0366, 31.2316);
    const before = await t.http.get(`/v1/o/${tenant.orgId}/driver/jobs`).set(auth(driver));
    expect(before.status).toBe(200);
    expect(before.body.route).toMatchObject({ source: 'baseline', fallbackReason: 'not_configured', algorithm: 'nearest_neighbour_v1' });

    await connectRoutes(tenant);
    const f = scriptedFetch([route([[300, 1500], [420, 2100]])]);
    http.fetch = f.fetch;
    const after = await t.http.get(`/v1/o/${tenant.orgId}/driver/jobs`).set(auth(driver));
    expect(after.body.route).toMatchObject({ source: 'google_routes', fallbackReason: null, algorithm: 'google_routes_v1' });
    expect(after.body.route.order).toHaveLength(2);
    expect(after.body.route.legs.map((l: any) => l.travelSeconds)).toEqual([300, 420]);
    expect(f.calls).toHaveLength(1);
  });

  it('a moving driver polling every 10 s does not re-ask Google for the same jobs; a changed job set does (review: daily cap)', async () => {
    // Same two jobs as above, already planned once; the driver now moves ~150 m between polls.
    const f = scriptedFetch([route([[300, 1500], [420, 2100]])]);
    http.fetch = f.fetch;
    const before = await used(tenant.orgId);
    for (let i = 1; i <= 6; i++) {
      await sql(`update drivers set last_latitude = $2, last_longitude = $3, last_location_at = now() where id = $1`, [driverId, 30.0444 + i * 0.0014, 31.2357]);
      const res = await t.http.get(`/v1/o/${tenant.orgId}/driver/jobs`).set(auth(driver));
      expect(res.body.route).toMatchObject({ source: 'google_routes', cached: true });
    }
    expect(f.calls).toHaveLength(0);
    expect(await used(tenant.orgId)).toBe(before);
    // Far from where it was planned (> 2 km): planned again, once.
    await sql(`update drivers set last_latitude = 30.0700, last_longitude = 31.2600 where id = $1`, [driverId]);
    expect((await t.http.get(`/v1/o/${tenant.orgId}/driver/jobs`).set(auth(driver))).body.route).toMatchObject({ source: 'google_routes', cached: false });
    expect(f.calls).toHaveLength(1);
    await t.http.get(`/v1/o/${tenant.orgId}/driver/jobs`).set(auth(driver));
    expect(f.calls).toHaveLength(1);
  });

  it('route plans use at most half of the daily cap, so ETA refinements keep their own budget', async () => {
    const other = await createTenant(t);
    await connectRoutes(other, { dailyRequestCap: 4 });
    const f = scriptedFetch([route([[100, 900], [100, 900]])]);
    http.fetch = f.fetch;
    const stops = (k: number) => [{ id: `a${k}`, location: drop }, { id: `b${k}`, location: { latitude: 30.0366, longitude: 31.2316 } }];
    const answers = [];
    for (let k = 0; k < 4; k++) answers.push(await routing.plan(other.orgId, { origin, stops: stops(k), vehicle: 'car' }));
    expect(answers.map((a) => a.source)).toEqual(['google_routes', 'google_routes', 'baseline', 'baseline']);
    expect(answers[2]).toMatchObject({ fallbackReason: 'quota_exhausted' });
    // ETA requests still get the rest of the cap.
    http.fetch = scriptedFetch([route([[200, 1000]])]).fetch;
    expect((await routing.eta(other.orgId, origin, drop, 'car')).source).toBe('google_routes');
    expect((await routing.eta(other.orgId, origin, { latitude: 30.05, longitude: 31.25 }, 'car')).source).toBe('google_routes');
    expect((await routing.eta(other.orgId, origin, { latitude: 30.06, longitude: 31.26 }, 'car')).fallbackReason).toBe('quota_exhausted');
  });

  it('refines the en-route ETA with Google after the transaction, and keeps the baseline when Google fails', async () => {
    const { orderId, jobId } = await acceptedJob(30.0626, 31.2197);
    for (const s of ['accepted', 'preparing', 'ready'] as const) {
      await t.app.get(DbService).scoped(ownerCtx, (tx) => t.app.get(OrdersKernelService).transition(tx, ownerCtx, orderId, s));
    }
    http.fetch = scriptedFetch([{ status: 500, body: {} }]).fetch;
    const picked = await t.http.post(`/v1/o/${tenant.orgId}/driver/jobs/${jobId}/pickup`).set(auth(driver)).send({});
    expect(picked.body.status).toBe('picked_up');
    expect(picked.body.etaAt).not.toBeNull(); // baseline kept
    http.fetch = scriptedFetch([route([[1800, 6000]])]).fetch;
    const t0 = Date.now();
    const en = await t.http.post(`/v1/o/${tenant.orgId}/driver/jobs/${jobId}/en-route`).set(auth(driver)).send({ latitude: 30.05, longitude: 31.24 });
    expect(en.body.status).toBe('en_route');
    const eta = Date.parse(en.body.etaAt) - t0;
    expect(eta).toBeGreaterThan(1795_000);
    expect(eta).toBeLessThan(1810_000);
  });
});
