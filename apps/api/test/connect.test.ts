import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { TenantContext } from '../src/common/auth/context';
import { DbService } from '../src/common/db/db.service';
import { EventDispatcher } from '../src/common/events/dispatcher.service';
import { MessagingService } from '../src/modules/connect/messaging.service';
import { OrderingService } from '../src/modules/connect/ordering.service';
import { ProviderHttp } from '../src/modules/integrations/provider-http';
import { PaymentLedgerService } from '../src/modules/kernel/payment-ledger.service';
import { MESSAGING_PORT, type MessagingPort } from '../src/modules/kernel/ports';
import { bootWithCheckout, bootWithoutCheckout, fakeCheckout, inbound, lastOutbound, outbound, sandboxChannel, walkToMenu, scriptedFetch } from './growth-helpers';
import { addMember, auth, bootTestApp, createTenant, seedMenu, sql, type SeededMenu, type TestApp, type TestTenant } from './helpers';

const APP_SECRET = 'test-whatsapp-app-secret';
process.env.WHATSAPP_APP_SECRET = APP_SECRET;
process.env.WHATSAPP_VERIFY_TOKEN = 'verify-token-123';

let t: TestApp;
let tenant: TestTenant;
let menu: SeededMenu;
let channelId: string;
let phoneSeq = 1000;
const nextPhone = () => `+2010012${String(++phoneSeq).padStart(5, '0')}`;

beforeAll(async () => {
  t = await bootTestApp();
  tenant = await createTenant(t);
  menu = await seedMenu(tenant);
  channelId = (await sandboxChannel(t, tenant)).id;
});
afterAll(async () => { await t.close(); });

const burger = (m: SeededMenu, qty = 1) => ({ productId: m.products.burger, quantity: qty, modifiers: [{ groupId: m.groups.size, optionId: m.options.large }] });

describe('structured WhatsApp ordering (sandbox)', () => {
  it('walks branch → fulfillment → name with interactive replies and sends a single-use menu link', async () => {
    const from = nextPhone();
    const first = await inbound(t, tenant, channelId, from, { text: 'order', name: 'Mona' });
    expect(first.sandbox).toBe(true);
    const ask = await lastOutbound(first.conversationId);
    // one branch → skipped; fulfillment asked with reply buttons
    expect(ask.kind).toBe('interactive');
    expect(ask.payload).toMatchObject({ type: 'buttons', sandbox: true });
    expect(ask.payload.buttons.map((b: any) => b.id)).toEqual(['ful:pickup', 'ful:delivery']);
    expect(ask.status).toBe('delivered');
    expect(ask.provider_message_id).toMatch(/^sandbox\./);

    // Free text is NOT an order: it re-prompts the current step.
    await inbound(t, tenant, channelId, from, { text: '2 burgers please' });
    expect((await lastOutbound(first.conversationId)).payload.buttons.map((b: any) => b.id)).toEqual(['ful:pickup', 'ful:delivery']);
    const [s1] = await sql(`select step, state from ordering_sessions where conversation_id = $1`, [first.conversationId]);
    expect(s1.step).toBe('fulfillment');
    expect(s1.state.cart).toBeUndefined();

    await inbound(t, tenant, channelId, from, { reply: { id: 'ful:pickup', title: 'Pickup' } });
    expect((await lastOutbound(first.conversationId)).payload.buttons[0].id).toBe('name:profile');
    await inbound(t, tenant, channelId, from, { reply: { id: 'name:profile' } });
    const link = await lastOutbound(first.conversationId);
    expect(link.payload.type).toBe('cta_url');
    expect(link.payload.url).toMatch(/^http:\/\/app\.test\/o\/[A-Za-z0-9_-]+$/);
    const token = link.payload.url.split('/o/')[1];

    const view = await t.http.get(`/v1/public/connect/ordering/${token}`);
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ step: 'menu', sandbox: true, fulfillment: 'pickup', customerName: 'Mona', expired: false });
    expect(view.body.menu.categories[0].products.map((p: any) => p.name)).toContain('Smash burger');
    expect(view.body.menu.categories[0].products.find((p: any) => p.name === 'Smash burger').modifierGroups).toHaveLength(2);

    // Asking for the link again rotates the token: the old link stops working.
    await inbound(t, tenant, channelId, from, { text: 'hello?' });
    expect((await t.http.get(`/v1/public/connect/ordering/${token}`)).status).toBe(404);
  });

  it('(a) COD: server-priced cart → review → order placed and confirmed in the conversation', async () => {
    const from = nextPhone();
    const { conversationId, token } = await walkToMenu(t, tenant, channelId, from, 'delivery');
    const v0 = (await t.http.get(`/v1/public/connect/ordering/${token}`)).body;
    expect(v0.address.line1).toBe('26 July St, building 4, floor 2');
    const cart = await t.http.post(`/v1/public/connect/ordering/${token}/cart`).send({ version: v0.version, lines: [burger(menu, 2), { productId: menu.products.fries, quantity: 1 }] });
    expect(cart.status).toBe(201);
    // (18500 + 3000) × 2 + 4500 = 47500, + 2500 delivery
    expect(cart.body.quote).toMatchObject({ subtotalMinor: 47500, deliveryFeeMinor: 2500, totalMinor: 50000, currency: 'EGP' });
    expect(cart.body.step).toBe('review');
    const review = await lastOutbound(conversationId);
    expect(review.payload.buttons.map((b: any) => b.id)).toEqual(['pay:online', 'pay:cod']); // ResutoPay is deployed → online offered
    expect(review.body).toMatch(/Total EGP\s500/);

    await t.http.post(`/v1/public/connect/ordering/${token}/details`).send({ version: cart.body.version, marketingConsent: true }).expect(201);
    const v1 = (await t.http.get(`/v1/public/connect/ordering/${token}`)).body;
    const done = await t.http.post(`/v1/public/connect/ordering/${token}/checkout`).send({ version: v1.version, paymentMethod: 'cod', expectedTotalMinor: 50000 });
    expect(done.status).toBe(201);
    expect(done.body).toMatchObject({ step: 'completed', paymentMethod: 'cod', order: { status: 'placed', totalMinor: 50000 } });
    const [order] = await sql(`select status, channel, fulfillment, conversation_id, total_minor, payment_status, customer_phone, delivery_address from orders where id = $1`, [done.body.order.id]);
    expect(order).toMatchObject({ status: 'placed', channel: 'whatsapp', fulfillment: 'delivery', conversation_id: conversationId, total_minor: 50000, payment_status: 'unpaid', customer_phone: from });
    expect(order.delivery_address.line1).toBe('26 July St, building 4, floor 2');
    const [cust] = await sql(`select marketing_consent, marketing_consent_source from customers where org_id = $1 and phone_e164 = $2`, [tenant.orgId, from]);
    expect(cust).toMatchObject({ marketing_consent: true, marketing_consent_source: 'whatsapp' });

    // Safe retry returns the same order; a different choice is refused.
    const again = await t.http.post(`/v1/public/connect/ordering/${token}/checkout`).send({ version: v1.version, paymentMethod: 'cod', expectedTotalMinor: 50000 });
    expect(again.body).toMatchObject({ replayed: true, order: { id: done.body.order.id } });
    expect((await sql(`select count(*)::int as n from orders where conversation_id = $1`, [conversationId]))[0].n).toBe(1);

    // order.placed handler sends the confirmation into the conversation.
    await t.app.get(EventDispatcher).drain();
    expect((await lastOutbound(conversationId)).body).toContain(`Order #${done.body.order.number} received`);
  });

  it('(b) online payment needs CHECKOUT_PORT: clear 503 and nothing is placed when it is absent', async () => {
    const noPay = await bootWithoutCheckout();
    const from = nextPhone();
    const { conversationId, token } = await walkToMenu(noPay, tenant, channelId, from);
    const v = (await noPay.http.get(`/v1/public/connect/ordering/${token}`)).body;
    const cart = await noPay.http.post(`/v1/public/connect/ordering/${token}/cart`).send({ version: v.version, lines: [burger(menu)] });
    expect(cart.body.paymentOnlineAvailable).toBe(false);
    const res = await noPay.http.post(`/v1/public/connect/ordering/${token}/checkout`).send({ version: cart.body.version, paymentMethod: 'online', expectedTotalMinor: cart.body.quote.totalMinor });
    await noPay.close();
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('module_unavailable');
    expect((await sql(`select count(*)::int as n from orders where conversation_id = $1`, [conversationId]))[0].n).toBe(0);
    expect((await sql(`select step from ordering_sessions where conversation_id = $1`, [conversationId]))[0].step).toBe('review');
  });

  it('prices cannot be tampered with: carts reject price fields and totals are checked server-side', async () => {
    const from = nextPhone();
    const { token } = await walkToMenu(t, tenant, channelId, from);
    const v = (await t.http.get(`/v1/public/connect/ordering/${token}`)).body;
    const withPrice = await t.http.post(`/v1/public/connect/ordering/${token}/cart`).send({ version: v.version, lines: [{ ...burger(menu), priceMinor: 1 }] });
    expect(withPrice.status).toBe(400);
    expect(withPrice.body.error.code).toBe('validation_failed');
    const withTotal = await t.http.post(`/v1/public/connect/ordering/${token}/cart`).send({ version: v.version, totalMinor: 1, lines: [burger(menu)] });
    expect(withTotal.status).toBe(400);
    const badModifier = await t.http.post(`/v1/public/connect/ordering/${token}/cart`).send({ version: v.version, lines: [{ productId: menu.products.burger, quantity: 1, modifiers: [] }] });
    expect(badModifier.status).toBe(422);
    expect(badModifier.body.error.code).toBe('invalid_modifiers');
    const cart = await t.http.post(`/v1/public/connect/ordering/${token}/cart`).send({ version: v.version, lines: [burger(menu)] });
    expect(cart.body.quote.totalMinor).toBe(21500);
    const cheap = await t.http.post(`/v1/public/connect/ordering/${token}/checkout`).send({ version: cart.body.version, paymentMethod: 'cod', expectedTotalMinor: 100 });
    expect(cheap.status).toBe(409);
    expect(cheap.body.error.code).toBe('price_changed');
    // Stale version (another tab) is rejected.
    const stale = await t.http.post(`/v1/public/connect/ordering/${token}/cart`).send({ version: v.version, lines: [burger(menu)] });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('stale_session');
  });

  it('expires idle sessions, tells the customer, and the link stops accepting carts', async () => {
    const from = nextPhone();
    const { conversationId, token } = await walkToMenu(t, tenant, channelId, from);
    await sql(`update ordering_sessions set expires_at = now() - interval '1 minute' where conversation_id = $1`, [conversationId]);
    const res = await t.app.get(OrderingService).expireDue();
    expect(res.expired).toBeGreaterThanOrEqual(1);
    expect((await sql(`select step from ordering_sessions where conversation_id = $1`, [conversationId]))[0].step).toBe('expired');
    expect((await lastOutbound(conversationId)).body).toContain('expired');
    const view = await t.http.get(`/v1/public/connect/ordering/${token}`);
    expect(view.body.expired).toBe(true);
    const cart = await t.http.post(`/v1/public/connect/ordering/${token}/cart`).send({ version: view.body.version, lines: [burger(menu)] });
    expect(cart.status).toBe(410);
    // Restartable: "order" starts a new session.
    await inbound(t, tenant, channelId, from, { text: 'order' });
    expect((await sql(`select count(*)::int as n from ordering_sessions where conversation_id = $1 and step = 'fulfillment'`, [conversationId]))[0].n).toBe(1);
  });

  it('is cancellable by the customer at any step', async () => {
    const from = nextPhone();
    const { conversationId } = await walkToMenu(t, tenant, channelId, from);
    await inbound(t, tenant, channelId, from, { text: 'cancel' });
    expect((await sql(`select step from ordering_sessions where conversation_id = $1`, [conversationId]))[0].step).toBe('cancelled');
    expect((await lastOutbound(conversationId)).body).toContain('cancelled');
  });

  it('human handoff at any step pauses the bot until resolved', async () => {
    const from = nextPhone();
    const first = await inbound(t, tenant, channelId, from, { text: 'order' });
    await inbound(t, tenant, channelId, from, { reply: { id: 'handoff' } });
    const conv = await t.http.get(`/v1/o/${tenant.orgId}/connect/conversations/${first.conversationId}`).set(auth(tenant.owner));
    expect(conv.body).toMatchObject({ status: 'handoff', botActive: false, handoff: { status: 'requested' } });
    const before = (await outbound(first.conversationId)).length;
    await inbound(t, tenant, channelId, from, { reply: { id: 'ful:pickup' } });
    await inbound(t, tenant, channelId, from, { text: 'order' });
    expect((await outbound(first.conversationId)).length).toBe(before); // bot silent
    // Staff reply works during handoff; then resolving resumes the bot.
    await t.http.post(`/v1/o/${tenant.orgId}/connect/conversations/${first.conversationId}/reply`).set(auth(tenant.owner)).send({ text: 'Hi, Ahmed here', key: 'reply-handoff-1' }).expect(201);
    await t.http.post(`/v1/o/${tenant.orgId}/connect/conversations/${first.conversationId}/handoff/resolve`).set(auth(tenant.owner)).expect(201);
    await inbound(t, tenant, channelId, from, { reply: { id: 'ful:pickup' } });
    expect((await lastOutbound(first.conversationId)).body).toContain('What name');
  });
});

describe('24-hour customer-service window', () => {
  it('blocks free-form replies outside the window and allows a sandbox template', async () => {
    const from = nextPhone();
    const { conversationId } = await inbound(t, tenant, channelId, from, { text: 'hi' });
    await sql(`update conversations set last_inbound_at = now() - interval '25 hours' where id = $1`, [conversationId]);
    const free = await t.http.post(`/v1/o/${tenant.orgId}/connect/conversations/${conversationId}/reply`).set(auth(tenant.owner)).send({ text: 'Are you there?', key: 'reply-window-1' });
    expect(free.status).toBe(409);
    expect(free.body.error.code).toBe('outside_window');

    const tpl = await t.http.post(`/v1/o/${tenant.orgId}/connect/templates`).set(auth(tenant.owner))
      .send({ name: 'order_update', language: 'en', category: 'utility', body: 'Update on order {{1}}: {{2}}', variables: ['order_number', 'status'] });
    expect(tpl.status).toBe(201);
    const draftUse = await t.http.post(`/v1/o/${tenant.orgId}/connect/conversations/${conversationId}/reply`).set(auth(tenant.owner))
      .send({ templateName: 'order_update', variables: ['#7', 'ready'], key: 'reply-window-2' });
    expect(draftUse.status).toBe(409);
    expect(draftUse.body.error.code).toBe('template_not_approved');
    const submitted = await t.http.post(`/v1/o/${tenant.orgId}/connect/templates/${tpl.body.id}/submit`).set(auth(tenant.owner));
    expect(submitted.body).toMatchObject({ providerStatus: 'sandbox', sandbox: true });
    expect(submitted.body.note).toMatch(/not reviewed by Meta/);
    const ok = await t.http.post(`/v1/o/${tenant.orgId}/connect/conversations/${conversationId}/reply`).set(auth(tenant.owner))
      .send({ templateName: 'order_update', variables: ['#7', 'ready'], key: 'reply-window-3' });
    expect(ok.status).toBe(201);
    expect((await lastOutbound(conversationId))).toMatchObject({ kind: 'template', body: 'Update on order #7: ready' });

    // MESSAGING_PORT: outside the window without a usable template → skipped, not sent.
    const port = t.app.get<MessagingPort>(MESSAGING_PORT);
    const db = t.app.get(DbService);
    const ctx = TenantContext.system(tenant.orgId);
    const r1 = await db.withTenant(tenant.orgId, (tx) => port.enqueueToCustomer(tx, ctx, { phone: from, text: 'Your order is ready', reason: 'order.ready' }));
    expect(r1).toEqual({ messageId: null, skipped: 'outside_window' });
    const r2 = await db.withTenant(tenant.orgId, (tx) => port.enqueueToCustomer(tx, ctx, { phone: from, text: 'x', templateName: 'order_update', variables: { order_number: '#9', status: 'ready' }, reason: 'order.ready' }));
    expect(r2.messageId).toBeTruthy();
    const r3 = await db.withTenant(tenant.orgId, (tx) => port.enqueueToCustomer(tx, ctx, { phone: '+201099999999', text: 'x', reason: 'order.ready' }));
    expect(r3).toEqual({ messageId: null, skipped: 'no_channel' });
    const r4 = await db.withTenant(tenant.orgId, (tx) => port.enqueueToCustomer(tx, ctx, { phone: from, text: 'Promo!', reason: 'marketing' }));
    expect(r4).toEqual({ messageId: null, skipped: 'no_consent' });
  });

  it('replies are idempotent per key', async () => {
    const from = nextPhone();
    const { conversationId } = await inbound(t, tenant, channelId, from, { text: 'hi' });
    const body = { text: 'Welcome!', key: 'idem-reply-123' };
    const a = await t.http.post(`/v1/o/${tenant.orgId}/connect/conversations/${conversationId}/reply`).set(auth(tenant.owner)).send(body);
    const b = await t.http.post(`/v1/o/${tenant.orgId}/connect/conversations/${conversationId}/reply`).set(auth(tenant.owner)).send(body);
    expect(a.body.messageId).toBe(b.body.messageId);
    expect((await outbound(conversationId)).filter((m) => m.body === 'Welcome!')).toHaveLength(1);
  });
});

describe('inbox access control', () => {
  it('lists conversations with sandbox labels, validates input, enforces roles, tenants and entitlements', async () => {
    const list = await t.http.get(`/v1/o/${tenant.orgId}/connect/conversations?limit=5`).set(auth(tenant.owner));
    expect(list.status).toBe(200);
    expect(list.body.items.length).toBeGreaterThan(0);
    expect(list.body.items[0]).toHaveProperty('sandbox', true);
    expect(list.body.items[0].window).toHaveProperty('open');
    expect((await t.http.get(`/v1/o/${tenant.orgId}/connect/conversations?unread=maybe`).set(auth(tenant.owner))).status).toBe(400);
    expect((await t.http.post(`/v1/o/${tenant.orgId}/connect/sandbox/inbound`).set(auth(tenant.owner)).send({ channelId, from: '12', text: 'x' })).status).toBe(400);

    const waiter = await addMember(t, tenant, 'waiter');
    expect((await t.http.get(`/v1/o/${tenant.orgId}/connect/conversations`).set(auth(waiter))).status).toBe(403);
    const marketer = await addMember(t, tenant, 'marketing');
    expect((await t.http.get(`/v1/o/${tenant.orgId}/connect/conversations`).set(auth(marketer))).status).toBe(200);
    expect((await t.http.post(`/v1/o/${tenant.orgId}/connect/sandbox/inbound`).set(auth(marketer)).send({ channelId, from: nextPhone(), text: 'x' })).status).toBe(403);

    const other = await createTenant(t);
    const convId = list.body.items[0].id;
    expect((await t.http.get(`/v1/o/${tenant.orgId}/connect/conversations/${convId}`).set(auth(other.owner))).status).toBe(404);
    expect((await t.http.get(`/v1/o/${other.orgId}/connect/conversations/${convId}`).set(auth(other.owner))).status).toBe(404);

    const free = await createTenant(t, { planId: 'free' });
    const denied = await t.http.get(`/v1/o/${free.orgId}/connect/conversations`).set(auth(free.owner));
    expect(denied.status).toBe(402);
    expect(denied.body.error.code).toBe('module_not_entitled');
  });

  it('refuses the simulator on non-sandbox channels', async () => {
    const conn = await t.http.post(`/v1/o/${tenant.orgId}/integrations/connections`).set(auth(tenant.owner))
      .send({ provider: 'whatsapp_cloud', environment: 'live', credentials: { accessToken: 'EAAG-sim-test-token-0001' }, config: { phoneNumberId: '900000000000001', wabaId: '900000000000002' } });
    const ch = await t.http.post(`/v1/o/${tenant.orgId}/connect/channels`).set(auth(tenant.owner))
      .send({ transport: 'meta_cloud', displayName: 'Live', phoneNumberId: '900000000000001', wabaId: '900000000000002', connectionId: conn.body.id });
    expect(ch.status).toBe(201);
    expect(ch.body).toMatchObject({ sandbox: false, status: 'pending' });
    const res = await t.http.post(`/v1/o/${tenant.orgId}/connect/sandbox/inbound`).set(auth(tenant.owner)).send({ channelId: ch.body.id, from: nextPhone(), text: 'order' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('not_sandbox');
  });
});

describe('WhatsApp Cloud API webhook', () => {
  let live: TestTenant;
  const PHONE_ID = '106540352242922';
  const sign = (body: string, secret = APP_SECRET) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  const post = (body: string, sig: string) => t.http.post('/v1/webhooks/whatsapp').set('Content-Type', 'application/json').set('X-Hub-Signature-256', sig).send(body);
  const inboundPayload = (id: string, text: string, from = '201005550001') => JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: '102290129340398', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '15550783881', phone_number_id: PHONE_ID },
      contacts: [{ profile: { name: 'Karim' }, wa_id: from }], messages: [{ from, id, timestamp: '1750000000', type: 'text', text: { body: text } }] } }] }],
  });

  beforeAll(async () => {
    live = await createTenant(t);
    await seedMenu(live);
    const conn = await t.http.post(`/v1/o/${live.orgId}/integrations/connections`).set(auth(live.owner))
      .send({ provider: 'whatsapp_cloud', environment: 'live', credentials: { accessToken: 'EAAG-live-token-abcdef' }, config: { phoneNumberId: PHONE_ID, wabaId: '102290129340398' } });
    expect(conn.status).toBe(201);
    const ch = await t.http.post(`/v1/o/${live.orgId}/connect/channels`).set(auth(live.owner))
      .send({ transport: 'meta_cloud', displayName: 'Main WhatsApp', phoneNumberId: PHONE_ID, wabaId: '102290129340398', connectionId: conn.body.id });
    expect(ch.status).toBe(201);
  });

  it('answers the verification handshake only with the right token', async () => {
    const ok = await t.http.get('/v1/webhooks/whatsapp').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-token-123', 'hub.challenge': '8812' });
    expect(ok.status).toBe(200);
    expect(ok.text).toBe('8812');
    expect((await t.http.get('/v1/webhooks/whatsapp').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '8812' })).status).toBe(403);
  });

  it('rejects a bad signature before parsing and stores nothing for the tenant', async () => {
    const body = inboundPayload('wamid.BAD1', 'order');
    const res = await post(body, sign(body, 'not-the-secret'));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('invalid_signature');
    expect((await sql(`select count(*)::int as n from messages where provider_message_id = 'wamid.BAD1'`))[0].n).toBe(0);
    const [rej] = await sql(`select status, signature_valid, payload from webhook_inbox where provider = 'whatsapp' and signature_valid = false order by received_at desc limit 1`);
    expect(rej).toMatchObject({ status: 'rejected', signature_valid: false });
    expect(rej.payload.rejected).toBe(true);
    expect((await post(body.replace('order', 'ordeR'), sign(body))).status).toBe(401); // body changed after signing
  });

  it('accepts a signed message, resolves the tenant by phone_number_id, queues the bot reply and ignores duplicates', async () => {
    const body = inboundPayload('wamid.IN1', 'order');
    const res = await post(body, sign(body));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: 1, processed: 1, duplicates: 0 });
    const [msg] = await sql(`select m.org_id, m.conversation_id, m.body from messages m where provider_message_id = 'wamid.IN1'`);
    expect(msg).toMatchObject({ org_id: live.orgId, body: 'order' });
    const [conv] = await sql(`select external_contact, contact_name, customer_id from conversations where id = $1`, [msg.conversation_id]);
    expect(conv).toMatchObject({ external_contact: '201005550001', contact_name: 'Karim' });
    expect(conv.customer_id).toBeTruthy();

    const dup = await post(body, sign(body));
    expect(dup.body).toMatchObject({ received: 1, processed: 0, duplicates: 1 });
    expect((await sql(`select count(*)::int as n from messages where provider_message_id = 'wamid.IN1'`))[0].n).toBe(1);
    expect((await sql(`select count(*)::int as n from ordering_sessions where conversation_id = $1`, [msg.conversation_id]))[0].n).toBe(1);

    // The reply is queued for the Cloud API (not sandbox) and sent by the sender job with retries.
    const queued = await lastOutbound(msg.conversation_id);
    expect(queued).toMatchObject({ status: 'queued' });
    expect(queued.payload.sandbox).toBeUndefined();
    const http = t.app.get(ProviderHttp);
    const original = http.fetch;
    const f = scriptedFetch([{ status: 503, body: { error: { message: 'temporarily unavailable' } } }, { body: { messages: [{ id: 'wamid.OUT-REPLY-1' }] } }]);
    http.fetch = f.fetch;
    try {
      const sender = t.app.get(MessagingService);
      const r1 = await sender.runSender();
      expect(r1).toMatchObject({ retried: 1, sent: 0 });
      const [afterFail] = await sql(`select status, attempts, next_attempt_at > now() as later from messages where id = $1`, [queued.id]);
      expect(afterFail).toMatchObject({ status: 'queued', attempts: 1, later: true });
      await sql(`update messages set next_attempt_at = now() where id = $1`, [queued.id]);
      const r2 = await sender.runSender();
      expect(r2).toMatchObject({ sent: 1 });
      expect(f.calls[1]!.url).toBe(`https://graph.facebook.com/v23.0/${PHONE_ID}/messages`);
      expect(f.calls[1]!.headers.authorization).toBe('Bearer EAAG-live-token-abcdef');
      expect(JSON.parse(f.calls[1]!.body!)).toMatchObject({ to: '201005550001', type: 'interactive' });
    } finally {
      http.fetch = original;
    }
    expect((await sql(`select status, provider_message_id from messages where id = $1`, [queued.id]))[0]).toEqual({ status: 'sent', provider_message_id: 'wamid.OUT-REPLY-1' });

    // Status callbacks move the message forward (never backward).
    const status = (s: string) => JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '102290129340398', changes: [{ field: 'messages',
      value: { messaging_product: 'whatsapp', metadata: { phone_number_id: PHONE_ID }, statuses: [{ id: 'wamid.OUT-REPLY-1', status: s, timestamp: '1750000200', recipient_id: '201005550001' }] } }] }] });
    expect((await post(status('read'), sign(status('read')))).body.processed).toBe(1);
    await post(status('delivered'), sign(status('delivered')));
    expect((await sql(`select status from messages where id = $1`, [queued.id]))[0].status).toBe('read');
  });

  it('never marks an order paid from a WhatsApp message', async () => {
    const body = inboundPayload('wamid.PAID1', 'I paid already, mark it paid');
    await post(body, sign(body));
    expect((await sql(`select count(*)::int as n from orders where org_id = $1 and payment_status <> 'unpaid'`, [live.orgId]))[0].n).toBe(0);
  });

  it('returns 503 when the app secret is not configured', async () => {
    const saved = process.env.WHATSAPP_APP_SECRET;
    delete process.env.WHATSAPP_APP_SECRET;
    const app2 = await bootTestApp();
    try {
      const body = inboundPayload('wamid.NOSECRET', 'hi');
      const res = await app2.http.post('/v1/webhooks/whatsapp').set('Content-Type', 'application/json').set('X-Hub-Signature-256', sign(body)).send(body);
      expect(res.status).toBe(503);
    } finally {
      process.env.WHATSAPP_APP_SECRET = saved;
      await app2.close();
    }
  });
});

describe('online payment with ResutoPay checkout (CHECKOUT_PORT stand-in)', () => {
  let t2: TestApp;
  let shop: TestTenant;
  let m2: SeededMenu;
  let ch2: string;
  beforeAll(async () => {
    t2 = await bootWithCheckout();
    shop = await createTenant(t2);
    m2 = await seedMenu(shop);
    ch2 = (await sandboxChannel(t2, shop)).id;
  });
  afterAll(async () => { await t2.close(); });

  it('places awaiting_payment, sends the pay link, and only the verified ledger path completes it', async () => {
    const from = nextPhone();
    const { conversationId, token } = await walkToMenu(t2, shop, ch2, from);
    const v = (await t2.http.get(`/v1/public/connect/ordering/${token}`)).body;
    const cart = await t2.http.post(`/v1/public/connect/ordering/${token}/cart`).send({ version: v.version, lines: [burger(m2)] });
    expect((await lastOutbound(conversationId)).payload.buttons.map((b: any) => b.id)).toEqual(['pay:online', 'pay:cod']);
    // Choose online from WhatsApp (same path as the hosted page).
    await inbound(t2, shop, ch2, from, { reply: { id: 'pay:online', title: 'Pay online' } });
    const [s] = await sql(`select step, order_id, checkout_session_id, state from ordering_sessions where conversation_id = $1`, [conversationId]);
    expect(s.step).toBe('awaiting_payment');
    expect(s.checkout_session_id).toBeTruthy();
    expect(fakeCheckout.calls.at(-1)).toMatchObject({ purpose: 'order', orderId: s.order_id, channel: 'whatsapp' });
    const [order] = await sql(`select status, total_minor, channel, conversation_id from orders where id = $1`, [s.order_id]);
    expect(order).toMatchObject({ status: 'awaiting_payment', total_minor: cart.body.quote.totalMinor, channel: 'whatsapp', conversation_id: conversationId });
    const pay = await lastOutbound(conversationId);
    expect(pay.payload).toMatchObject({ type: 'cta_url' });
    expect(pay.payload.url).toMatch(/^http:\/\/app\.test\/pay\//);
    const view = (await t2.http.get(`/v1/public/connect/ordering/${token}`)).body;
    expect(view).toMatchObject({ step: 'awaiting_payment', checkoutUrl: pay.payload.url });

    // A chat message claiming payment changes nothing.
    await inbound(t2, shop, ch2, from, { text: 'paid ✅' });
    expect((await sql(`select status, payment_status from orders where id = $1`, [s.order_id]))[0]).toEqual({ status: 'awaiting_payment', payment_status: 'unpaid' });

    // What ResutoPay does after a VERIFIED provider webhook: ledger confirm.
    const db = t2.app.get(DbService);
    const ledger = t2.app.get(PaymentLedgerService);
    const sys = TenantContext.system(shop.orgId, 'test-provider-webhook', 'webhook');
    await db.withTenant(shop.orgId, async (tx) => {
      const p = await ledger.createPending(tx, sys, { branchId: shop.branchId, orderId: s.order_id, checkoutSessionId: s.checkout_session_id, method: 'card', provider: 'simulated',
        amountMinor: order.total_minor, currency: 'EGP', isTest: true });
      await ledger.confirm(tx, sys, p.id, { amountMinor: order.total_minor, currency: 'EGP' });
    });
    await t2.app.get(EventDispatcher).drain();
    expect((await sql(`select status, payment_status from orders where id = $1`, [s.order_id]))[0]).toEqual({ status: 'placed', payment_status: 'paid' });
    expect((await sql(`select step from ordering_sessions where conversation_id = $1`, [conversationId]))[0].step).toBe('completed');
    expect((await outbound(conversationId)).map((x) => x.body).join('\n')).toContain('Payment received');
  });

  it('online checkout from the hosted page returns the checkout URL', async () => {
    const from = nextPhone();
    const { token } = await walkToMenu(t2, shop, ch2, from);
    const v = (await t2.http.get(`/v1/public/connect/ordering/${token}`)).body;
    const cart = await t2.http.post(`/v1/public/connect/ordering/${token}/cart`).send({ version: v.version, lines: [burger(m2), { productId: m2.products.soda, quantity: 2 }] });
    const res = await t2.http.post(`/v1/public/connect/ordering/${token}/checkout`).send({ version: cart.body.version, paymentMethod: 'online', expectedTotalMinor: cart.body.quote.totalMinor });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ step: 'awaiting_payment', paymentMethod: 'online', order: { status: 'awaiting_payment', totalMinor: 26500 } });
    expect(res.body.checkoutUrl).toMatch(/^http:\/\/app\.test\/pay\//);
  });
});
