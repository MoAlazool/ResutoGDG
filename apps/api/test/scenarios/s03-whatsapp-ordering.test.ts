// S03 — Structured WhatsApp ordering on a sandbox channel, with the real ResutoPay
// checkout behind CHECKOUT_PORT: (a) online payment through the simulated provider,
// (b) cash on delivery. HTTP only (inbound messages via the sandbox simulator endpoint).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventDispatcher } from '../../src/common/events/dispatcher.service';
import { inbound, lastOutbound, sandboxChannel } from '../growth-helpers';
import { addMember, auth, bootTestApp, createTenant, sql, type TestApp, type TestTenant, type TestUser } from '../helpers';
import { buildMenuViaApi, burgerLine, outboundMessages, payViaSandbox, PRICES, tokenFromUrl, type ApiMenu } from './support';

let t: TestApp;
let tenant: TestTenant;
let menu: ApiMenu;
let kitchen: TestUser;
let channelId: string;
let secondBranch: string;

const DELIVERY_FEE = 2500;
const cartLines = () => [burgerLine(menu, 1, { large: true, cheese: true }), { productId: menu.soda, quantity: 2 }];
const SUBTOTAL = PRICES.burger + PRICES.large + PRICES.cheese + 2 * PRICES.soda; // 28000
const TOTAL = SUBTOTAL + DELIVERY_FEE; // 30500

const kitchenHas = async (orderId: string) =>
  (await t.http.get(`/v1/o/${tenant.orgId}/kitchen/${tenant.branchId}`).set(auth(kitchen))).body.tickets.some((x: any) => x.id === orderId);

/** Walks the bot: order → branch → fulfillment → name → address → hosted menu link. */
async function converse(from: string) {
  const first = await inbound(t, tenant, channelId, from, { text: 'order', name: 'Mona' });
  const conversationId = first.conversationId;
  const askBranch = await lastOutbound(conversationId);
  expect(askBranch.kind).toBe('interactive');
  const branchIds = (askBranch.payload.buttons ?? askBranch.payload.sections?.[0]?.rows ?? []).map((b: any) => b.id);
  expect(branchIds.sort()).toEqual([`branch:${tenant.branchId}`, `branch:${secondBranch}`].sort());
  await inbound(t, tenant, channelId, from, { reply: { id: `branch:${tenant.branchId}`, title: 'Main branch' } });
  const askFulfillment = await lastOutbound(conversationId);
  expect(askFulfillment.payload.buttons.map((b: any) => b.id)).toEqual(['ful:pickup', 'ful:delivery']);
  // Free text is not an order: it re-prompts the current step.
  await inbound(t, tenant, channelId, from, { text: '2 burgers please' });
  expect((await lastOutbound(conversationId)).payload.buttons.map((b: any) => b.id)).toEqual(['ful:pickup', 'ful:delivery']);
  await inbound(t, tenant, channelId, from, { reply: { id: 'ful:delivery', title: 'Delivery' } });
  expect((await lastOutbound(conversationId)).payload.buttons[0].id).toBe('name:profile');
  await inbound(t, tenant, channelId, from, { text: 'Mona Adel' });
  await inbound(t, tenant, channelId, from, { text: '26 July St, building 4, floor 2' });
  const link = await lastOutbound(conversationId);
  expect(link.payload).toMatchObject({ type: 'cta_url', sandbox: true });
  expect(link.payload.url).toMatch(/^http:\/\/app\.test\/o\/[A-Za-z0-9_-]+$/);
  return { conversationId, token: tokenFromUrl(link.payload.url, '/o/') };
}

beforeAll(async () => {
  t = await bootTestApp();
  tenant = await createTenant(t, { country: 'EG' });
  menu = await buildMenuViaApi(t, tenant);
  kitchen = await addMember(t, tenant, 'kitchen', [tenant.branchId]);
  secondBranch = (await t.http.post(`/v1/o/${tenant.orgId}/branches`).set(auth(tenant.owner)).send({ name: 'Heliopolis', acceptsDelivery: true })).body.id;
  const ch = await sandboxChannel(t, tenant);
  expect(ch.sandbox).toBe(true);
  channelId = ch.id;
});
afterAll(async () => { await t.close(); });

describe('S03 (a) WhatsApp order paid online', () => {
  let conversationId: string;
  let token: string;
  let orderId: string;
  let checkoutUrl: string;

  it('1. inbound "order" starts the structured flow; interactive replies pick branch, fulfillment, name and address', async () => {
    ({ conversationId, token } = await converse('+201001110001'));
    const view = await t.http.get(`/v1/public/connect/ordering/${token}`);
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ step: 'menu', sandbox: true, fulfillment: 'delivery', customerName: 'Mona Adel', branch: { id: tenant.branchId } });
    expect(view.body.address.line1).toBe('26 July St, building 4, floor 2');
    const burger = view.body.menu.categories.flatMap((c: any) => c.products).find((p: any) => p.id === menu.burger);
    expect(burger.modifierGroups.map((g: any) => g.name)).toEqual(['Size', 'Extras']);
  });

  it('2. the cart is priced on the server; client prices and totals are rejected', async () => {
    const v = (await t.http.get(`/v1/public/connect/ordering/${token}`)).body;
    const tampered = await t.http.post(`/v1/public/connect/ordering/${token}/cart`).send({ version: v.version, lines: [{ ...burgerLine(menu), priceMinor: 1 }] });
    expect(tampered.status).toBe(400);
    expect(tampered.body.error.code).toBe('validation_failed');
    const total = await t.http.post(`/v1/public/connect/ordering/${token}/cart`).send({ version: v.version, totalMinor: 1, lines: cartLines() });
    expect(total.status).toBe(400);
    const badModifier = await t.http.post(`/v1/public/connect/ordering/${token}/cart`).send({ version: v.version, lines: [{ productId: menu.burger, quantity: 1, modifiers: [] }] });
    expect(badModifier.body.error.code).toBe('invalid_modifiers');
    const cart = await t.http.post(`/v1/public/connect/ordering/${token}/cart`).send({ version: v.version, lines: cartLines() });
    expect(cart.status, JSON.stringify(cart.body)).toBe(201);
    expect(cart.body.quote).toMatchObject({ subtotalMinor: SUBTOTAL, deliveryFeeMinor: DELIVERY_FEE, totalMinor: TOTAL, currency: 'EGP' });
    expect(cart.body.step).toBe('review');
    expect(cart.body.paymentOnlineAvailable).toBe(true);
    expect((await lastOutbound(conversationId)).payload.buttons.map((b: any) => b.id)).toEqual(['pay:online', 'pay:cod']);
    // A lowered expected total at checkout is refused.
    const cheap = await t.http.post(`/v1/public/connect/ordering/${token}/checkout`).send({ version: cart.body.version, paymentMethod: 'online', expectedTotalMinor: TOTAL - 1000 });
    expect(cheap.status).toBe(409);
    expect(cheap.body.error.code).toBe('price_changed');
  });

  it('3. online checkout leaves the order awaiting_payment and sends the pay link into the chat', async () => {
    const v = (await t.http.get(`/v1/public/connect/ordering/${token}`)).body;
    const res = await t.http.post(`/v1/public/connect/ordering/${token}/checkout`).send({ version: v.version, paymentMethod: 'online', expectedTotalMinor: TOTAL });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ step: 'awaiting_payment', paymentMethod: 'online', order: { status: 'awaiting_payment', totalMinor: TOTAL } });
    expect(res.body.checkoutUrl).toMatch(/^http:\/\/app\.test\/pay\/[A-Za-z0-9_-]+$/);
    orderId = res.body.order.id;
    checkoutUrl = res.body.checkoutUrl;
    const pay = await lastOutbound(conversationId);
    expect(pay.payload).toMatchObject({ type: 'cta_url', url: checkoutUrl });
    const [order] = await sql(`select status, payment_status, channel, conversation_id from orders where id = $1`, [orderId]);
    expect(order).toEqual({ status: 'awaiting_payment', payment_status: 'unpaid', channel: 'whatsapp', conversation_id: conversationId });
    expect(await kitchenHas(orderId)).toBe(false);
    // A chat message claiming payment changes nothing.
    await inbound(t, tenant, channelId, '+201001110001', { text: 'paid ✅' });
    expect((await sql(`select payment_status from orders where id = $1`, [orderId]))[0].payment_status).toBe('unpaid');
  });

  it('4. the simulated provider payment (signed webhook) places the order and the kitchen sees it', async () => {
    const checkoutToken = tokenFromUrl(checkoutUrl, '/pay/');
    const view = await t.http.get(`/v1/public/pay/${checkoutToken}`);
    expect(view.body).toMatchObject({ status: 'open', purpose: 'order', amountMinor: TOTAL, currency: 'EGP', sandbox: true });
    const { view: done } = await payViaSandbox(t, checkoutToken);
    expect(done.status).toBe('paid');
    const [order] = await sql(`select status, payment_status, paid_minor from orders where id = $1`, [orderId]);
    expect(order).toEqual({ status: 'placed', payment_status: 'paid', paid_minor: TOTAL });
    expect(await kitchenHas(orderId)).toBe(true);
  });

  it('5. reactions: the ordering session completes and a WhatsApp payment confirmation is queued', async () => {
    await t.app.get(EventDispatcher).drain();
    const [s] = await sql(`select step from ordering_sessions where order_id = $1`, [orderId]);
    expect(s.step).toBe('completed');
    const bodies = (await outboundMessages(conversationId)).map((m) => m.body).join('\n');
    expect(bodies).toContain('Payment received');
    const view = (await t.http.get(`/v1/public/connect/ordering/${token}`)).body;
    expect(view.step).toBe('completed');
    // Prepaid delivery: a delivery job exists once paid, with nothing to collect at the door.
    const [job] = await sql(`select status, cod_amount_minor, cash_status from delivery_jobs where order_id = $1`, [orderId]);
    expect(job).toEqual({ status: 'unassigned', cod_amount_minor: 0, cash_status: 'none' });
  });
});

describe('S03 (b) WhatsApp order with cash on delivery', () => {
  it('places the order immediately, unpaid, visible to the kitchen, and confirms it in the chat', async () => {
    const { conversationId, token } = await converse('+201001110002');
    const v = (await t.http.get(`/v1/public/connect/ordering/${token}`)).body;
    const cart = await t.http.post(`/v1/public/connect/ordering/${token}/cart`).send({ version: v.version, lines: cartLines() });
    expect(cart.body.quote.totalMinor).toBe(TOTAL);
    await t.http.post(`/v1/public/connect/ordering/${token}/details`).send({ version: cart.body.version, marketingConsent: true }).expect(201);
    const v2 = (await t.http.get(`/v1/public/connect/ordering/${token}`)).body;
    const res = await t.http.post(`/v1/public/connect/ordering/${token}/checkout`).send({ version: v2.version, paymentMethod: 'cod', expectedTotalMinor: TOTAL });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ step: 'completed', paymentMethod: 'cod', order: { status: 'placed', totalMinor: TOTAL } });
    const [order] = await sql(`select status, payment_status, channel, fulfillment, customer_phone from orders where id = $1`, [res.body.order.id]);
    expect(order).toEqual({ status: 'placed', payment_status: 'unpaid', channel: 'whatsapp', fulfillment: 'delivery', customer_phone: '+201001110002' });
    expect(await kitchenHas(res.body.order.id)).toBe(true);
    const [cust] = await sql(`select marketing_consent, marketing_consent_source from customers where org_id = $1 and phone_e164 = $2`, [tenant.orgId, '+201001110002']);
    expect(cust).toEqual({ marketing_consent: true, marketing_consent_source: 'whatsapp' });
    // A safe retry replays the same order.
    const again = await t.http.post(`/v1/public/connect/ordering/${token}/checkout`).send({ version: v2.version, paymentMethod: 'cod', expectedTotalMinor: TOTAL });
    expect(again.body).toMatchObject({ replayed: true, order: { id: res.body.order.id } });
    await t.app.get(EventDispatcher).drain();
    expect((await lastOutbound(conversationId)).body).toContain(`Order #${res.body.order.number} received`);
  });
});
