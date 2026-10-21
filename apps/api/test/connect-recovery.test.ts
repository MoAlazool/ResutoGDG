import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConnectEventsService } from '../src/modules/connect/connect-events.service';
import { inbound, outbound, sandboxChannel, walkToMenu } from './growth-helpers';
import { addMember, auth, bootTestApp, createTenant, seedMenu, sql, type SeededMenu, type TestApp, type TestTenant } from './helpers';

// FT-12: staff can resend a failed message and assign conversations. DF-14: "on the way" is sent once per delivery.

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

const C = (path: string) => `/v1/o/${tenant.orgId}/connect${path}`;

describe('"Order is on the way" is sent once per delivery (DF-14)', () => {
  it('a job moving picked_up → en_route messages the customer once', async () => {
    const { conversationId, token } = await walkToMenu(t, tenant, channelId, '+201001288881', 'pickup');
    const v0 = (await t.http.get(`/v1/public/connect/ordering/${token}`)).body;
    const cart = await t.http.post(`/v1/public/connect/ordering/${token}/cart`).send({ version: v0.version, lines: [{ productId: menu.products.fries, quantity: 1 }] });
    await t.http.post(`/v1/public/connect/ordering/${token}/details`).send({ version: cart.body.version, marketingConsent: false }).expect(200);
    const v1 = (await t.http.get(`/v1/public/connect/ordering/${token}`)).body;
    const done = await t.http.post(`/v1/public/connect/ordering/${token}/checkout`).send({ version: v1.version, paymentMethod: 'cod', expectedTotalMinor: cart.body.quote.totalMinor });
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    const orderId = done.body.order.id;
    const events = t.app.get(ConnectEventsService);
    const event = (to: string) => ({ id: `evt-${to}`, orgId: tenant.orgId, type: 'delivery.status_changed', aggregateType: 'delivery_job', aggregateId: orderId,
      payload: { orderId, to } } as any);
    // Before the fix both statuses sent "🛵 Order #n is on the way." (two messages 6 ms apart in the demo).
    await events.deliveryStatus(event('picked_up'));
    await events.deliveryStatus(event('en_route'));
    const onTheWay = (await outbound(conversationId)).filter((m) => /on the way/i.test(m.body ?? ''));
    expect(onTheWay).toHaveLength(1);
  });
});

describe('resend failed messages and assign conversations (FT-12)', () => {
  it('re-queues a failed message only under the current window rules, idempotently, and audits it', async () => {
    const a = await inbound(t, tenant, channelId, '+201001288882', { text: 'hello', name: 'Hany' });
    const reply = await t.http.post(C(`/conversations/${a.conversationId}/reply`)).set(auth(tenant.owner)).send({ text: 'We are open until midnight.', key: 'reply-ft12-1' });
    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
    const [msg] = (await outbound(a.conversationId)).filter((m) => m.body === 'We are open until midnight.');
    await sql(`update messages set status = 'failed', error = 'provider 131047', attempts = 6, next_attempt_at = null where id = $1`, [msg.id]);

    const r = await t.http.post(C(`/messages/${msg.id}/resend`)).set(auth(tenant.owner)).send({});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ messageId: msg.id, resent: true });
    const [after] = await sql(`select status, error, payload from messages where id = $1`, [msg.id]);
    expect(after.status).toBe('delivered'); // sandbox channels deliver at once
    expect(after.payload.previousErrors).toEqual([{ error: 'provider 131047', attempts: 6 }]);
    const again = await t.http.post(C(`/messages/${msg.id}/resend`)).set(auth(tenant.owner)).send({});
    expect(again.body).toMatchObject({ resent: false, status: 'delivered' });
    const audits = await sql(`select action from audit_logs where org_id = $1 and entity_id = $2`, [tenant.orgId, msg.id]);
    expect(audits).toEqual([{ action: 'connect.message_resent' }]);

    // Outside the 24-hour window free text cannot be resent.
    await sql(`update messages set status = 'failed' where id = $1`, [msg.id]);
    await sql(`update conversations set last_inbound_at = now() - interval '2 days' where id = $1`, [a.conversationId]);
    const late = await t.http.post(C(`/messages/${msg.id}/resend`)).set(auth(tenant.owner)).send({});
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('outside_window');
    // A role without connect:reply cannot resend.
    const host = await addMember(t, tenant, 'host');
    expect((await t.http.post(C(`/messages/${msg.id}/resend`)).set(auth(host)).send({})).status).toBe(403);
  });

  it('lists assignees who can reply and refuses to assign to someone who cannot', async () => {
    const a = await inbound(t, tenant, channelId, '+201001288883', { text: 'hi', name: 'Rana' });
    const marketing = await addMember(t, tenant, 'marketing');
    const kitchen = await addMember(t, tenant, 'kitchen');
    const list = await t.http.get(C('/assignees')).set(auth(tenant.owner));
    const ids = list.body.items.map((x: any) => x.userId);
    expect(ids).toContain(marketing.userId);
    expect(ids).not.toContain(kitchen.userId);
    const bad = await t.http.post(C(`/conversations/${a.conversationId}/assign`)).set(auth(tenant.owner)).send({ userId: kitchen.userId });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('cannot_reply');
    const ok = await t.http.post(C(`/conversations/${a.conversationId}/assign`)).set(auth(tenant.owner)).send({ userId: marketing.userId });
    expect(ok.status).toBe(200);
    const unassigned = await t.http.get(C('/conversations?assigned=unassigned')).set(auth(tenant.owner));
    expect(unassigned.body.items.map((x: any) => x.id)).not.toContain(a.conversationId);
  });
});
