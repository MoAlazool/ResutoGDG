import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantContext } from '../src/common/auth/context';
import { DbService } from '../src/common/db/db.service';
import { EventDispatcher } from '../src/common/events/dispatcher.service';
import { OrdersKernelService } from '../src/modules/kernel/orders-kernel.service';
import { addMember, bootTestApp, createTenant, seedMenu, sql, type TestApp, type TestTenant } from './helpers';

// FT-14: the public tracking view shows delivery status, ETA and the driver's first name; a coarse driver position
// appears only while en route and fresh, never before pickup.
let t: TestApp;
let tenant: TestTenant;
let orderId: string;
let ref: string;
let driverId: string;
beforeAll(async () => {
  t = await bootTestApp();
  tenant = await createTenant(t);
  const menu = await seedMenu(tenant);
  await sql(`update branches set latitude = 30.0444, longitude = 31.2357 where id = $1`, [tenant.branchId]);
  const driver = await addMember(t, tenant, 'driver', [tenant.branchId]);
  await sql(`update drivers set display_name = 'Karim Mostafa Ali' where user_id = $1`, [driver.userId]);
  driverId = (await sql(`select id from drivers where user_id = $1`, [driver.userId]))[0].id;
  const db = t.app.get(DbService);
  const ctx = new TenantContext(tenant.orgId, 'owner', null, tenant.owner.userId, 'user', tenant.owner.userId);
  const o = await db.scoped(ctx, (tx) => t.app.get(OrdersKernelService).place(tx, ctx, {
    branchId: tenant.branchId, channel: 'web', fulfillment: 'delivery', lines: [{ productId: menu.products.fries, quantity: 2 }],
    customer: { name: 'Salma', phone: '+201005550001' },
    deliveryAddress: { line1: '5 Tahrir Sq', latitude: 30.045123, longitude: 31.240456 },
  }));
  orderId = o.id;
  ref = o.publicRef;
  await t.app.get(EventDispatcher).drain();
});
afterAll(async () => { await t.close(); });

const track = async () => (await t.http.get(`/v1/public/order/${tenant.slug}/orders/${ref}`).expect(200)).body.delivery;
const setJob = (fields: string, params: unknown[] = []) => sql(`update delivery_jobs set ${fields} where order_id = $1`, [orderId, ...params]);

describe('FT-14 public delivery tracking', () => {
  it('shows status only before a driver is assigned, with coarse restaurant and destination points', async () => {
    const d = await track();
    expect(d).toMatchObject({ status: 'unassigned', etaAt: null, driverFirstName: null, driver: null, restaurant: { latitude: 30.044, longitude: 31.236 } });
    expect(d.destination).toEqual({ latitude: 30.045, longitude: 31.24 });
    expect(JSON.stringify(d)).not.toContain('Salma');
    expect(JSON.stringify(d)).not.toContain('+20100');
  });

  it('names the driver by first name once assigned but never shares the position before en route', async () => {
    await sql(`update drivers set last_latitude = 30.046789, last_longitude = 31.238123, last_location_at = now() where id = $1`, [driverId]);
    await setJob(`driver_id = $2, status = 'accepted', eta_at = now() + interval '20 minutes'`, [driverId]);
    let d = await track();
    expect(d).toMatchObject({ status: 'accepted', driverFirstName: 'Karim', driver: null });
    expect(new Date(d.etaAt).getTime()).toBeGreaterThan(Date.now());
    await setJob(`status = 'picked_up', picked_up_at = now()`);
    d = await track();
    expect(d).toMatchObject({ status: 'picked_up', driver: null });
    expect(d.pickedUpAt).toBeTruthy();
  });

  it('shares a rounded, fresh position while en route only', async () => {
    await setJob(`status = 'en_route'`);
    let d = await track();
    expect(d.driver).toMatchObject({ latitude: 30.047, longitude: 31.238 });
    // Stale position (driver app offline): not shown.
    await sql(`update drivers set last_location_at = now() - interval '30 minutes' where id = $1`, [driverId]);
    d = await track();
    expect(d.driver).toBeNull();
    await sql(`update drivers set last_location_at = now() where id = $1`, [driverId]);
    await setJob(`status = 'delivered', delivered_at = now()`);
    d = await track();
    expect(d).toMatchObject({ status: 'delivered', etaAt: null, driver: null });
    expect(d.deliveredAt).toBeTruthy();
  });

  it('has no delivery block for pickup orders', async () => {
    const db = t.app.get(DbService);
    const ctx = new TenantContext(tenant.orgId, 'owner', null, tenant.owner.userId, 'user', tenant.owner.userId);
    const productId = (await sql(`select id from products where org_id = $1 and name = 'Soda'`, [tenant.orgId]))[0].id;
    const o = await db.scoped(ctx, (tx) => t.app.get(OrdersKernelService).place(tx, ctx, {
      branchId: tenant.branchId, channel: 'web', fulfillment: 'pickup', lines: [{ productId, quantity: 1 }], customer: { name: 'P', phone: '+201005550002' } }));
    const body = (await t.http.get(`/v1/public/order/${tenant.slug}/orders/${o.publicRef}`).expect(200)).body;
    expect(body.delivery).toBeNull();
  });
});
