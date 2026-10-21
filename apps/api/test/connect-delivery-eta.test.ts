// FT-14: the WhatsApp "on the way" message carries the driver's ETA (branch-local time, Western digits) when known.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventDispatcher } from '../src/common/events/dispatcher.service';
import { ConnectEventsService } from '../src/modules/connect/connect-events.service';
import { lastOutbound, sandboxChannel, walkToMenu } from './growth-helpers';
import { bootTestApp, createTenant, seedMenu, sql, type SeededMenu, type TestApp, type TestTenant } from './helpers';

process.env.WHATSAPP_APP_SECRET ??= 'test-whatsapp-app-secret';
process.env.WHATSAPP_VERIFY_TOKEN ??= 'verify-token-123';

let t: TestApp;
let tenant: TestTenant;
let menu: SeededMenu;
let channelId: string;
let seq = 0;
const phone = () => `+2010015${String(++seq).padStart(5, '0')}`;

beforeAll(async () => {
  t = await bootTestApp();
  tenant = await createTenant(t);
  menu = await seedMenu(tenant);
  channelId = (await sandboxChannel(t, tenant)).id;
  await sql(`update branches set min_order_minor = 0, timezone = 'Africa/Cairo' where id = $1`, [tenant.branchId]);
});
afterAll(async () => { await t.close(); });

async function whatsappDeliveryOrder() {
  const { token, conversationId } = await walkToMenu(t, tenant, channelId, phone(), 'delivery');
  const P = (path = '') => `/v1/public/connect/ordering/${token}${path}`;
  const v0 = (await t.http.get(P())).body;
  const cart = await t.http.post(P('/cart')).send({ version: v0.version, lines: [{ productId: menu.products.fries, quantity: 1 }] });
  const done = await t.http.post(P('/checkout')).send({ version: cart.body.version, paymentMethod: 'cod', expectedTotalMinor: cart.body.quote.totalMinor });
  expect(done.status).toBeLessThan(300);
  await t.app.get(EventDispatcher).drain();
  return { orderId: done.body.order.id as string, conversationId };
}
// DF-14: "on the way" (with the ETA the driver app sets at pickup) is sent once, on picked_up.
const onTheWay = (orderId: string) => t.app.get(ConnectEventsService).deliveryStatus(
  { id: `ev-${orderId}`, orgId: tenant.orgId, type: 'delivery.status_changed', aggregateType: 'delivery_job', aggregateId: orderId, payload: { orderId, to: 'picked_up' }, createdAt: new Date().toISOString() } as any);

describe('FT-14 WhatsApp "on the way" with ETA', () => {
  it('includes the expected arrival time in the branch time zone', async () => {
    const { orderId, conversationId } = await whatsappDeliveryOrder();
    const [job] = await sql(`update delivery_jobs set eta_at = now() + interval '25 minutes' where order_id = $1 returning eta_at`, [orderId]);
    expect(job).toBeTruthy();
    await onTheWay(orderId);
    const msg = await lastOutbound(conversationId);
    const expected = new Intl.DateTimeFormat('en-GB', { timeStyle: 'short', timeZone: 'Africa/Cairo' }).format(new Date(job.eta_at));
    expect(msg.body).toContain('is on the way');
    expect(msg.body).toContain(`Expected around ${expected}`);
  });

  it('says only "on the way" when no ETA is known', async () => {
    const { orderId, conversationId } = await whatsappDeliveryOrder();
    await sql(`update delivery_jobs set eta_at = null where order_id = $1`, [orderId]);
    await onTheWay(orderId);
    const msg = await lastOutbound(conversationId);
    expect(msg.body).toContain('is on the way');
    expect(msg.body).not.toContain('Expected around');
  });
});
