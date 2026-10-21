// FT-09 (review regression): WhatsApp / Messenger / Instagram delivery ordering once a branch has delivery zones.
// A text address needs a zone choice on the hosted page; a shared location is priced by the zone that covers it,
// and the cart quote, a details change and checkout all price the same way (no price_changed loop).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inbound, lastOutbound, sandboxChannel, walkToMenu } from './growth-helpers';
import { auth, bootTestApp, createTenant, seedMenu, sql, type SeededMenu, type TestApp, type TestTenant } from './helpers';

process.env.WHATSAPP_APP_SECRET ??= 'test-whatsapp-app-secret';
process.env.WHATSAPP_VERIFY_TOKEN ??= 'verify-token-123';

let t: TestApp;
let tenant: TestTenant;
let menu: SeededMenu;
let channelId: string;
let seq = 0;
const phone = () => `+2010014${String(++seq).padStart(5, '0')}`;
const P = (token: string, path = '') => `/v1/public/connect/ordering/${token}${path}`;
const errCode = (res: { body: any }) => res.body?.error?.code ?? res.body?.code;

beforeAll(async () => {
  t = await bootTestApp();
  tenant = await createTenant(t);
  menu = await seedMenu(tenant);
  channelId = (await sandboxChannel(t, tenant)).id;
  await sql(`update branches set latitude = 30.0626, longitude = 31.2197, min_order_minor = 0 where id = $1`, [tenant.branchId]);
});
afterAll(async () => { await t.close(); });

async function zone(body: Record<string, unknown>) {
  const z = await t.http.post(`/v1/o/${tenant.orgId}/delivery-zones`).set(auth(tenant.owner)).send({ branchId: tenant.branchId, ...body });
  expect(z.status).toBe(201);
  return z.body.id as string;
}
const deactivate = (id: string) => sql(`update delivery_zones set is_active = false where id = $1`, [id]);

describe('connect ordering with delivery zones', () => {
  it('text address + area zone: the page offers the areas, the bot asks for one, checkout prices by the chosen area', async () => {
    const zamalek = await zone({ name: 'Zamalek', nameAr: 'الزمالك', kind: 'area', feeMinor: 1000, minOrderMinor: 0 });
    const { token, conversationId } = await walkToMenu(t, tenant, channelId, phone(), 'delivery');
    const v0 = (await t.http.get(P(token))).body;
    expect(v0.delivery).toMatchObject({ zoneId: null, hasLocation: false });
    expect(v0.delivery.zones).toEqual([expect.objectContaining({ id: zamalek, name: 'Zamalek', kind: 'area', feeMinor: 1000 })]);

    const cart = await t.http.post(P(token, '/cart')).send({ version: v0.version, lines: [{ productId: menu.products.fries, quantity: 2 }] });
    expect(cart.status).toBeLessThan(300);
    expect(cart.body.quote.deliveryZoneRequired).toBe(true);
    // The chat does not offer pay buttons that would fail: it sends the page link to choose the area.
    const msg = await lastOutbound(conversationId);
    expect(msg.body).toMatch(/delivery area/);
    expect(msg.payload?.buttons ?? []).toEqual([]);

    const early = await t.http.post(P(token, '/checkout')).send({ version: cart.body.version, paymentMethod: 'cod', expectedTotalMinor: cart.body.quote.totalMinor });
    expect(early.status).toBe(409);
    expect(errCode(early)).toBe('delivery_zone_required');

    const bogus = await t.http.post(P(token, '/details')).send({ version: cart.body.version, zoneId: '00000000-0000-4000-8000-000000000009' });
    expect(bogus.status).toBe(422);
    expect(errCode(bogus)).toBe('delivery_zone_invalid');

    const picked = await t.http.post(P(token, '/details')).send({ version: cart.body.version, zoneId: zamalek });
    expect(picked.status).toBeLessThan(300);
    expect(picked.body.delivery.zoneId).toBe(zamalek);
    expect(picked.body.quote).toMatchObject({ deliveryFeeMinor: 1000, deliveryZoneRequired: false, deliveryZone: { id: zamalek } });

    const done = await t.http.post(P(token, '/checkout')).send({ version: picked.body.version, paymentMethod: 'cod', expectedTotalMinor: picked.body.quote.totalMinor });
    expect(done.status).toBeLessThan(300);
    expect(done.body.order.totalMinor).toBe(picked.body.quote.totalMinor);
    const [o] = await sql(`select delivery_fee_minor, delivery_address from orders where id = $1`, [done.body.order.id]);
    expect(Number(o.delivery_fee_minor)).toBe(1000);
    await deactivate(zamalek);
  });

  it('shared location inside a radius zone: the cart is priced by that zone and checkout succeeds first time', async () => {
    const near = await zone({ name: '2 km', kind: 'radius', radiusM: 2000, feeMinor: 700 });
    const from = phone();
    const a = await inbound(t, tenant, channelId, from, { text: 'order', name: 'Mona' });
    await inbound(t, tenant, channelId, from, { reply: { id: 'ful:delivery' } });
    await inbound(t, tenant, channelId, from, { text: 'Mona Adel' });
    await inbound(t, tenant, channelId, from, { location: { latitude: 30.0716, longitude: 31.2197, name: 'Home', address: '1 Nile St' } });
    const token = String((await lastOutbound(a.conversationId)).payload.url).split('/o/')[1]!;
    const v0 = (await t.http.get(P(token))).body;
    expect(v0.delivery.hasLocation).toBe(true);
    const cart = await t.http.post(P(token, '/cart')).send({ version: v0.version, lines: [{ productId: menu.products.fries, quantity: 2 }] });
    expect(cart.body.quote).toMatchObject({ deliveryFeeMinor: 700, deliveryZoneRequired: false, deliveryZone: { id: near } });
    const done = await t.http.post(P(token, '/checkout')).send({ version: cart.body.version, paymentMethod: 'cod', expectedTotalMinor: cart.body.quote.totalMinor });
    expect(done.status).toBeLessThan(300);
    expect(done.body.order.totalMinor).toBe(cart.body.quote.totalMinor);
    await deactivate(near);
  });

  it('a shared location outside every zone is refused at the cart, before any order', async () => {
    const near = await zone({ name: '1 km', kind: 'radius', radiusM: 1000, feeMinor: 500 });
    const from = phone();
    const a = await inbound(t, tenant, channelId, from, { text: 'order', name: 'Mona' });
    await inbound(t, tenant, channelId, from, { reply: { id: 'ful:delivery' } });
    await inbound(t, tenant, channelId, from, { text: 'Mona Adel' });
    await inbound(t, tenant, channelId, from, { location: { latitude: 30.2, longitude: 31.5, name: 'Far', address: 'Far away' } });
    const token = String((await lastOutbound(a.conversationId)).payload.url).split('/o/')[1]!;
    const v0 = (await t.http.get(P(token))).body;
    const cart = await t.http.post(P(token, '/cart')).send({ version: v0.version, lines: [{ productId: menu.products.fries, quantity: 2 }] });
    expect(cart.status).toBe(409);
    expect(errCode(cart)).toBe('outside_delivery_area');
    await deactivate(near);
  });

  it('pickup sessions carry no delivery block and ignore zones', async () => {
    const z = await zone({ name: 'Any', kind: 'area', feeMinor: 900 });
    const { token } = await walkToMenu(t, tenant, channelId, phone(), 'pickup');
    const v0 = (await t.http.get(P(token))).body;
    expect(v0.delivery).toBeNull();
    const cart = await t.http.post(P(token, '/cart')).send({ version: v0.version, lines: [{ productId: menu.products.fries, quantity: 1 }] });
    expect(cart.body.quote).toMatchObject({ deliveryFeeMinor: 0, deliveryZoneRequired: false });
    expect((await t.http.post(P(token, '/details')).send({ version: cart.body.version, zoneId: z })).status).toBe(422);
    await deactivate(z);
  });
});
