import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventDispatcher } from '../src/common/events/dispatcher.service';
import { outbound, sandboxChannel, walkToMenu } from './growth-helpers';
import { bootTestApp, createTenant, seedMenu, sql, type SeededMenu, type TestApp, type TestTenant } from './helpers';

// Audit PCL-01: delivery is at least once. A worker can commit a handler's customer message and stop before the
// dispatcher records the handler as succeeded; the retry then sent the WhatsApp notification again. The connect
// handlers now record the message as an effect of (event, handler) in the same transaction (onceForEvent), so a
// retried delivery sends nothing.

let t: TestApp;
let tenant: TestTenant;
let menu: SeededMenu;
let channelId: string;

beforeAll(async () => {
  t = await bootTestApp();
  tenant = await createTenant(t);
  menu = await seedMenu(tenant);
  channelId = (await sandboxChannel(t, tenant)).id;
});
afterAll(async () => { await t.close(); });

describe('customer notifications are sent once per event', () => {
  it('a redelivered order.placed (worker stopped before recording success) does not message the customer twice', async () => {
    const dispatcher = t.app.get(EventDispatcher);
    await dispatcher.drain();
    const { conversationId, token } = await walkToMenu(t, tenant, channelId, '+201001299991', 'pickup');
    const v0 = (await t.http.get(`/v1/public/connect/ordering/${token}`)).body;
    const cart = await t.http.post(`/v1/public/connect/ordering/${token}/cart`).send({ version: v0.version, lines: [{ productId: menu.products.fries, quantity: 1 }] });
    await t.http.post(`/v1/public/connect/ordering/${token}/details`).send({ version: cart.body.version, marketingConsent: false }).expect(200);
    const v1 = (await t.http.get(`/v1/public/connect/ordering/${token}`)).body;
    const done = await t.http.post(`/v1/public/connect/ordering/${token}/checkout`).send({ version: v1.version, paymentMethod: 'cod', expectedTotalMinor: cart.body.quote.totalMinor });
    expect(done.status).toBe(201);
    const received = `Order #${done.body.order.number} received`;

    await dispatcher.drain();
    const sent = async () => (await outbound(conversationId)).filter((m) => m.body?.includes(received)).length;
    expect(await sent()).toBe(1);

    // The worker "stopped" after the message committed: success was never recorded and the event is due again.
    const [event] = await sql<{ id: string }>(`select id from outbox_events where event_type = 'order.placed' and aggregate_id = $1`, [done.body.order.id]);
    await sql(`update event_handlings set status = 'failed', next_attempt_at = now(), lease_until = null where event_id = $1 and handler = 'connect.order-placed'`, [event.id]);
    await sql(`update outbox_events set published_at = null, available_at = now() where id = $1`, [event.id]);
    await dispatcher.drain();

    expect(await sql(`select status, attempts from event_handlings where event_id = $1 and handler = 'connect.order-placed'`, [event.id]))
      .toEqual([{ status: 'succeeded', attempts: 2 }]);
    expect(await sent()).toBe(1);
    expect(await sql(`select effect from event_effects where event_id = $1 and handler = 'connect.order-placed'`, [event.id])).toEqual([{ effect: 'customer-message' }]);
  });
});
