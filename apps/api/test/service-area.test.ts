import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { distanceM, inPolygon, nextOpening, openAt, zonesCovering, type ZoneRow } from '../src/modules/delivery/service-area';
import { addMember, auth, bootTestApp, createTenant, seedMenu, sql, unique, type SeededMenu, type TestApp, type TestTenant, type TestUser } from './helpers';

// FT-09: opening hours (branch time zone) and delivery zones are enforced server-side by the pricing engine.
describe('service-area rules (pure)', () => {
  const ZAMALEK = { latitude: 30.0626, longitude: 31.2197 };
  it('measures distance and point-in-polygon', () => {
    expect(Math.round(distanceM(ZAMALEK, { latitude: 30.0716, longitude: 31.2197 }))).toBeGreaterThan(990);
    expect(Math.round(distanceM(ZAMALEK, { latitude: 30.0716, longitude: 31.2197 }))).toBeLessThan(1010);
    const square: Array<[number, number]> = [[30, 31], [30, 31.1], [30.1, 31.1], [30.1, 31]];
    expect(inPolygon({ latitude: 30.05, longitude: 31.05 }, square)).toBe(true);
    expect(inPolygon({ latitude: 30.2, longitude: 31.05 }, square)).toBe(false);
    expect(inPolygon({ latitude: 30, longitude: 31.05 }, square)).toBe(true); // on an edge
  });

  it('picks the cheapest covering zone and never matches an area zone by point', () => {
    const z = (id: string, kind: ZoneRow['kind'], fee: number, extra: Partial<ZoneRow> = {}): ZoneRow =>
      ({ id, name: id, name_ar: null, kind, radius_m: null, polygon: null, fee_minor: fee, min_order_minor: 0, eta_min: null, sort_order: 0, ...extra });
    const zones = [z('far', 'radius', 4000, { radius_m: 5000 }), z('near', 'radius', 1500, { radius_m: 2000 }), z('area', 'area', 0)];
    expect(zonesCovering(zones, ZAMALEK, { latitude: 30.0716, longitude: 31.2197 }).map((x) => x.id)).toEqual(['near', 'far']);
    expect(zonesCovering(zones, ZAMALEK, { latitude: 30.1026, longitude: 31.2197 }).map((x) => x.id)).toEqual(['far']);
    expect(zonesCovering(zones, ZAMALEK, { latitude: 31, longitude: 31.2 })).toEqual([]);
    expect(zonesCovering(zones, null, ZAMALEK)).toEqual([]); // radius zones need branch coordinates
  });

  it('evaluates opening hours in the branch time zone, including windows past midnight', () => {
    const fri = [{ day: 5, opens: '18:00', closes: '02:00' }];
    // Saturday 00:30 in Riyadh (UTC+3) = Friday 21:30 UTC: still inside Friday's window.
    expect(openAt(fri, 'Asia/Riyadh', new Date('2026-10-23T21:30:00Z'))).toBe(true);
    // The same instant is Friday 21:30 in UTC, also open; Saturday 02:30 Riyadh is closed.
    expect(openAt(fri, 'Asia/Riyadh', new Date('2026-10-23T23:30:00Z'))).toBe(false);
    expect(openAt([], 'Asia/Riyadh', new Date())).toBe(true);
    // Next opening from Saturday 03:00 Riyadh is the next Friday 18:00 Riyadh (15:00 UTC).
    expect(nextOpening(fri, 'Asia/Riyadh', new Date('2026-10-24T00:00:00Z'))?.toISOString()).toBe('2026-10-30T15:00:00.000Z');
  });
});

let t: TestApp;
let tenant: TestTenant;
let other: TestTenant;
let menu: SeededMenu;
let waiter: TestUser;
beforeAll(async () => {
  t = await bootTestApp();
  tenant = await createTenant(t);
  other = await createTenant(t);
  menu = await seedMenu(tenant);
  waiter = await addMember(t, tenant, 'waiter');
  await sql(`update branches set timezone = 'Africa/Cairo', latitude = 30.0626, longitude = 31.2197, min_order_minor = 0 where id = $1`, [tenant.branchId]);
});
afterAll(async () => { await t.close(); });

let phoneSeq = Math.floor(Math.random() * 1_000_000);
const lines = () => [{ productId: menu.products.fries, quantity: 2 }];
const webOrder = (body: Record<string, unknown>) => t.http.post(`/v1/public/order/${tenant.slug}/orders`).set('Idempotency-Key', unique('k'))
  .send({ branchId: tenant.branchId, fulfillment: 'delivery', payment: 'cod', lines: lines(), customer: { name: 'Guest', phone: `0100${String(++phoneSeq).padStart(7, '0')}` }, ...body });
const addr = (extra: Record<string, unknown> = {}) => ({ line1: '12 Nile Street', ...extra });

describe('opening hours on guest channels', () => {
  it('refuses a website order while closed, accepts one scheduled inside the hours, and staff can still order', async () => {
    const dow = Number((await sql(`select extract(dow from now() at time zone 'Africa/Cairo')::int as d`))[0].d);
    await sql(`update branches set opening_hours = $2 where id = $1`, [tenant.branchId, JSON.stringify([{ day: (dow + 3) % 7, opens: '10:00', closes: '11:00' }])]);
    try {
      const closed = await webOrder({ fulfillment: 'pickup', payment: 'pay_at_pickup' });
      expect(closed.status).toBe(409);
      expect(closed.body.error.code).toBe('branch_closed');
      const nextOpenAt = closed.body.error.details.nextOpenAt as string;
      expect(nextOpenAt).toBeTruthy();
      const area = await t.http.get(`/v1/public/order/${tenant.slug}/service-area?branchId=${tenant.branchId}`);
      expect(area.body).toMatchObject({ openNow: false, hoursSet: true, nextOpenAt, timezone: 'Africa/Cairo' });

      const lateAt = new Date(new Date(nextOpenAt).getTime() + 2 * 3600_000).toISOString();
      const late = await webOrder({ fulfillment: 'pickup', payment: 'pay_at_pickup', scheduledFor: lateAt });
      expect(late.body.error.code).toBe('scheduled_while_closed');
      const past = await webOrder({ fulfillment: 'pickup', payment: 'pay_at_pickup', scheduledFor: new Date(Date.now() - 3600_000).toISOString() });
      expect(past.body.error.code).toBe('scheduled_in_past');
      const ok = await webOrder({ fulfillment: 'pickup', payment: 'pay_at_pickup', scheduledFor: new Date(new Date(nextOpenAt).getTime() + 10 * 60_000).toISOString() });
      expect(ok.status, JSON.stringify(ok.body)).toBe(201);

      const staff = await t.http.post(`/v1/o/${tenant.orgId}/orders`).set(auth(tenant.owner)).set('Idempotency-Key', unique('k'))
        .send({ branchId: tenant.branchId, fulfillment: 'pickup', lines: lines() });
      expect(staff.status, JSON.stringify(staff.body)).toBe(201);
    } finally {
      await sql(`update branches set opening_hours = '[]' where id = $1`, [tenant.branchId]);
    }
  });
});

describe('delivery zones', () => {
  let areaZone: string, nearZone: string;
  it('are managed with branches:manage and validated', async () => {
    const url = `/v1/o/${tenant.orgId}/delivery-zones`;
    expect((await t.http.post(url).set(auth(waiter)).send({ branchId: tenant.branchId, name: 'X', kind: 'area' })).status).toBe(403);
    expect((await t.http.post(url).set(auth(tenant.owner)).send({ branchId: tenant.branchId, name: 'X', kind: 'radius' })).status).toBe(400);
    expect((await t.http.post(url).set(auth(tenant.owner)).send({ branchId: tenant.branchId, name: 'X', kind: 'polygon', polygon: [[30, 31], [30, 31.1]] })).status).toBe(400);
    expect((await t.http.post(url).set(auth(other.owner)).send({ branchId: tenant.branchId, name: 'X', kind: 'area' })).status).toBe(404);
    const a = await t.http.post(url).set(auth(tenant.owner)).send({ branchId: tenant.branchId, name: 'Zamalek island', nameAr: 'جزيرة الزمالك', kind: 'area', feeMinor: 1000, minOrderMinor: 5000, etaMin: 25 });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    areaZone = a.body.id;
    const n = await t.http.post(url).set(auth(tenant.owner)).send({ branchId: tenant.branchId, name: 'Within 2 km', kind: 'radius', radiusM: 2000, feeMinor: 1500, etaMin: 30 });
    expect(n.status).toBe(201);
    nearZone = n.body.id;
    const list = await t.http.get(`${url}?branchId=${tenant.branchId}`).set(auth(waiter));
    expect(list.body.items.map((z: any) => z.name)).toEqual(['Within 2 km', 'Zamalek island']);
    expect((await sql(`select count(*)::int as n from audit_logs where org_id = $1 and action = 'delivery.zone_created'`, [tenant.orgId]))[0].n).toBe(2);
    const pub = await t.http.get(`/v1/public/order/${tenant.slug}/service-area?branchId=${tenant.branchId}`);
    expect(pub.body.delivery.zones).toHaveLength(2);
    expect(pub.body.delivery.zones[0]).not.toHaveProperty('radiusM');
    expect(pub.body.openNow).toBe(true);
  });

  it('prices delivery by zone and refuses addresses outside coverage on the website', async () => {
    const quote = (deliveryAddress?: Record<string, unknown>) => t.http.post(`/v1/public/order/${tenant.slug}/quote`)
      .send({ branchId: tenant.branchId, fulfillment: 'delivery', lines: lines(), ...(deliveryAddress ? { deliveryAddress } : {}) });
    const none = await quote();
    expect(none.status).toBe(200);
    expect(none.body).toMatchObject({ deliveryZone: null, deliveryZoneRequired: true });
    expect((await webOrder({ deliveryAddress: addr() })).body.error.code).toBe('delivery_zone_required');

    // Area zone: its fee and its minimum (fries ×2 = 9000 ≥ 5000).
    const q = await quote({ zoneId: areaZone });
    expect(q.body).toMatchObject({ deliveryFeeMinor: 1000, deliveryZone: { id: areaZone, name: 'Zamalek island', nameAr: 'جزيرة الزمالك', etaMin: 25 }, deliveryZoneRequired: false });
    const placed = await webOrder({ deliveryAddress: addr({ zoneId: areaZone }), expectedTotalMinor: q.body.totalMinor });
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    expect((await sql(`select delivery_fee_minor::int as fee from orders where public_ref = $1`, [placed.body.order.publicRef]))[0].fee).toBe(1000);
    const small = await webOrder({ lines: [{ productId: menu.products.soda, quantity: 1 }], deliveryAddress: addr({ zoneId: areaZone }) });
    expect(small.body.error).toMatchObject({ code: 'below_minimum', details: { minOrderMinor: 5000 } });

    // Radius zone: needs a shared location from a guest; inside → its fee; outside every geometry zone → refused.
    expect((await webOrder({ deliveryAddress: addr({ zoneId: nearZone }) })).body.error.code).toBe('location_required');
    const inside = await webOrder({ deliveryAddress: addr({ latitude: 30.0716, longitude: 31.2197 }) });
    expect(inside.status, JSON.stringify(inside.body)).toBe(201);
    expect((await sql(`select delivery_fee_minor::int as fee from orders where public_ref = $1`, [inside.body.order.publicRef]))[0].fee).toBe(1500);
    expect((await webOrder({ deliveryAddress: addr({ zoneId: nearZone, latitude: 30.2, longitude: 31.2197 }) })).body.error.code).toBe('outside_delivery_area');

    // Another restaurant's zone id is not accepted.
    const [foreign] = await sql(`insert into delivery_zones(org_id, branch_id, name, kind) values ($1, $2, 'Elsewhere', 'area') returning id`, [other.orgId, other.branchId]);
    expect((await webOrder({ deliveryAddress: addr({ zoneId: foreign.id }) })).body.error.code).toBe('delivery_zone_invalid');
  });

  it('lets staff place a delivery without choosing a zone (branch fee) and only area zones apply without a point', async () => {
    const r = await t.http.post(`/v1/o/${tenant.orgId}/orders`).set(auth(tenant.owner)).set('Idempotency-Key', unique('k'))
      .send({ branchId: tenant.branchId, fulfillment: 'delivery', lines: lines(), customer: { name: 'Phone', phone: '+201001234567' }, deliveryAddress: addr() });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.deliveryFeeMinor ?? (await sql(`select delivery_fee_minor::int as fee from orders where id = $1`, [r.body.id]))[0].fee).toBe(2500);
  });

  it('bounds guest deliveries by the branch radius when no zones exist', async () => {
    await sql(`update delivery_zones set is_active = false where branch_id = $1`, [tenant.branchId]);
    await sql(`update branches set delivery_radius_m = 3000 where id = $1`, [tenant.branchId]);
    try {
      expect((await webOrder({ deliveryAddress: addr({ latitude: 30.2, longitude: 31.2197 }) })).body.error.code).toBe('outside_delivery_area');
      expect((await webOrder({ deliveryAddress: addr({ latitude: 30.07, longitude: 31.22 }) })).status).toBe(201);
      expect((await webOrder({ deliveryAddress: addr() })).status).toBe(201); // no point: the team confirms the address
    } finally {
      await sql(`update branches set delivery_radius_m = null where id = $1`, [tenant.branchId]);
    }
  });
});
