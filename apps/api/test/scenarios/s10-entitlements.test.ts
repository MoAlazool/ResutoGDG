// S10 — Entitlements: a Free restaurant is refused (402) on every paid module through
// staff APIs, guest/public routes that depend on a paid module, and cross-module ports;
// upgrading through billing unlocks exactly the plan's modules; a subscription that
// stays past due beyond its grace window (moved forward by the real billing lifecycle
// job with controlled timestamps — no SQL writes) is locked again.
// Studio has no API controller in this tree yet, so only its entitlement flag is checked.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventDispatcher } from '../../src/common/events/dispatcher.service';
import { BillingLifecycleService } from '../../src/modules/billing/lifecycle.service';
import { addMember, auth, bootTestApp, createTenant, sql, type TestApp, type TestTenant } from '../helpers';
import { qrTokenFor, saveFloor, table } from '../ops-fixtures';
import { buildMenuViaApi, cairoToday, key, PRICES, type ApiMenu } from './support';

let t: TestApp;
let free: TestTenant;
let menu: ApiMenu;
let visitToken: string;
let today: string;

const ents = async (tt: TestTenant) => (await t.http.get(`/v1/o/${tt.orgId}/billing/entitlements`).set(auth(tt.owner))).body;

/** One representative staff route per paid module (studio: no controller in this tree). */
const PAID_ROUTES = (orgId: string, branchId: string, day: string): Array<[module: string, method: 'get' | 'post', path: string, body?: unknown]> => [
  ['connect', 'get', `/v1/o/${orgId}/connect/conversations`],
  ['connect', 'post', `/v1/o/${orgId}/connect/channels`, { transport: 'sandbox', displayName: 'WhatsApp sandbox' }],
  ['marketing', 'get', `/v1/o/${orgId}/marketing/segments`],
  ['marketing', 'post', `/v1/o/${orgId}/marketing/campaigns`, { name: 'x', channel: 'whatsapp', content: { text: 'hi' } }],
  ['pay', 'get', `/v1/o/${orgId}/payments`],
  ['pay', 'post', `/v1/o/${orgId}/payments/links`, { amountMinor: 1000, key: 'link-key-12345678' }],
  ['driver', 'get', `/v1/o/${orgId}/delivery/board`],
  ['finance', 'get', `/v1/o/${orgId}/finance/overview?from=${day}&to=${day}`],
  ['compliance', 'get', `/v1/o/${orgId}/compliance/tax-profile`],
  ['intelligence', 'get', `/v1/o/${orgId}/intelligence/insights`],
  ['mcp', 'get', `/v1/o/${orgId}/mcp/clients`],
  ['mcp', 'post', `/v1/o/${orgId}/mcp/clients`, { name: 'x', actingRole: 'manager', allowedTools: ['list_orders'] }],
];

async function statusOf(tt: TestTenant, method: 'get' | 'post', path: string, body?: unknown) {
  const req = method === 'get' ? t.http.get(path) : t.http.post(path).send(body ?? {});
  return req.set(auth(tt.owner));
}

beforeAll(async () => {
  t = await bootTestApp();
  free = await createTenant(t, { country: 'EG', planId: 'free' });
  menu = await buildMenuViaApi(t, free); // core: allowed on Free
  today = await cairoToday();
  const f = await saveFloor(t, free, [table('T1', 200, 200)]);
  visitToken = (await t.http.post(`/v1/public/tables/${await qrTokenFor(t, free, f.tables[0].id)}/session`)).body.token;
});
afterAll(async () => { await t.close(); });

describe('S10 entitlements: Free → 402, upgrade → unlocked, past due beyond grace → locked', () => {
  it('1. a Free restaurant has only core, and core works (QR ordering, staff orders, kitchen)', async () => {
    const view = await ents(free);
    expect(view.planId).toBe('free');
    for (const m of ['connect', 'pay', 'marketing', 'driver', 'studio', 'finance', 'compliance', 'intelligence', 'mcp']) {
      expect(view.modules[m], m).toEqual({ enabled: false, source: 'none' });
    }
    expect(view.modules.core).toEqual({ enabled: true, source: 'plan' });
    const qr = await t.http.post('/v1/public/visits/current/orders').set('X-Visit-Token', visitToken).set('Idempotency-Key', key()).send({ lines: [{ productId: menu.soda, quantity: 1 }] });
    expect(qr.status).toBe(201);
    const staff = await t.http.post(`/v1/o/${free.orgId}/orders`).set(auth(free.owner)).set('Idempotency-Key', key())
      .send({ branchId: free.branchId, fulfillment: 'pickup', lines: [{ productId: menu.fries, quantity: 1 }] });
    expect(staff.status).toBe(201);
    expect((await t.http.get(`/v1/o/${free.orgId}/kitchen/${free.branchId}`).set(auth(free.owner))).status).toBe(200);
  });

  it('2. every paid module answers 402 module_not_entitled on its staff routes', async () => {
    for (const [module, method, path, body] of PAID_ROUTES(free.orgId, free.branchId, today)) {
      const res = await statusOf(free, method, path, body);
      expect(res.status, `${module} ${method.toUpperCase()} ${path}`).toBe(402);
      expect(res.body.error).toMatchObject({ code: 'module_not_entitled', details: { module } });
    }
  });

  it('3. public guest routes that depend on ResutoPay answer 402, and nothing is created', async () => {
    const bill = await t.http.get('/v1/public/payments/visit/bill').set('X-Visit-Token', visitToken);
    expect(bill.status).toBe(402);
    expect(bill.body.error.code).toBe('module_not_entitled');
    expect((await t.http.post('/v1/public/payments/visit/split').set('X-Visit-Token', visitToken).send({ mode: 'equal', people: 2, key: key() })).status).toBe(402);
    expect((await t.http.post('/v1/public/payments/visit/checkout').set('X-Visit-Token', visitToken).send({ key: key() })).status).toBe(402);
    const before = (await sql(`select count(*)::int as n from orders where org_id = $1`, [free.orgId]))[0].n;
    const online = await t.http.post(`/v1/public/order/${free.slug}/orders`).set('Idempotency-Key', key()).send({
      branchId: free.branchId, fulfillment: 'pickup', payment: 'online', lines: [{ productId: menu.soda, quantity: 1 }],
      customer: { name: 'Hala', phone: '+201007770001' }, expectedTotalMinor: PRICES.soda,
    });
    expect(online.status).toBe(402);
    expect(online.body.error.code).toBe('module_not_entitled');
    expect((await sql(`select count(*)::int as n from orders where org_id = $1`, [free.orgId]))[0].n).toBe(before);
    expect((await sql(`select count(*)::int as n from checkout_sessions where org_id = $1`, [free.orgId]))[0].n).toBe(0);
  });

  // DEFECT: G-02 The public web-ordering menu offers online payment to a restaurant without ResutoPay; checkout then fails with 402.
  it.fails('4. the public ordering page does not offer online payment without ResutoPay', async () => {
    const page = await t.http.get(`/v1/public/order/${free.slug}`);
    expect(page.status).toBe(200);
    expect(page.body.payment.online).toBe(false);
  });

  it('5. module-gated reactions (ports/handlers) do nothing for Free: no delivery job, no fiscal document', async () => {
    const cod = await t.http.post(`/v1/public/order/${free.slug}/orders`).set('Idempotency-Key', key()).send({
      branchId: free.branchId, fulfillment: 'delivery', payment: 'cod', lines: [{ productId: menu.fries, quantity: 1 }],
      customer: { name: 'Hala', phone: '+201007770001' }, deliveryAddress: { line1: '1 Nile St', city: 'Cairo' },
    });
    expect(cod.status, JSON.stringify(cod.body)).toBe(201);
    const cashier = await addMember(t, free, 'cashier');
    const paid = await t.http.post(`/v1/o/${free.orgId}/orders/${cod.body.order.id}/collect`).set(auth(cashier)).set('Idempotency-Key', key()).send({ method: 'cash' });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    await t.app.get(EventDispatcher).drain();
    expect((await sql(`select count(*)::int as n from delivery_jobs where order_id = $1`, [cod.body.order.id]))[0].n).toBe(0);
    expect((await sql(`select count(*)::int as n from fiscal_documents where order_id = $1`, [cod.body.order.id]))[0].n).toBe(0);
  });

  it('6. a port call for an unentitled module is refused: MCP payment link on a plan without ResutoPay', async () => {
    // "Build Your Resuto" with only the MCP add-on: MCP works, ResutoPay does not.
    const custom = await createTenant(t, { country: 'EG', planId: 'free' });
    const order = await t.http.post(`/v1/o/${custom.orgId}/orders`).set(auth(custom.owner)).set('Idempotency-Key', key())
      .send({ branchId: custom.branchId, fulfillment: 'pickup', lines: [{ productId: (await buildMenuViaApi(t, custom)).soda, quantity: 2 }] });
    expect(order.status).toBe(201);
    const change = await t.http.post(`/v1/o/${custom.orgId}/billing/change-plan`).set(auth(custom.owner)).send({ planId: 'custom', addons: ['mcp'] });
    expect(change.status, JSON.stringify(change.body)).toBe(200);
    const view = await ents(custom);
    expect(view.modules.mcp.enabled).toBe(true);
    expect(view.modules.pay.enabled).toBe(false);
    const client = await t.http.post(`/v1/o/${custom.orgId}/mcp/clients`).set(auth(custom.owner))
      .send({ name: 'Bot', actingRole: 'manager', allowedTools: ['list_orders', 'create_payment_link'] });
    expect(client.status, JSON.stringify(client.body)).toBe(201);
    const K = { Authorization: `Bearer ${client.body.key}` };
    const tools = await t.http.get(`/v1/o/${custom.orgId}/mcp/tools`).set(K);
    expect(tools.body.items.map((x: any) => x.name)).toEqual(['list_orders']);
    const pay = await t.http.post(`/v1/o/${custom.orgId}/mcp/tools/create_payment_link`).set(K).send({ input: { orderId: order.body.id, description: 'x' } });
    expect(pay.status).toBe(402);
    expect(pay.body.error.code).toBe('module_not_entitled');
    expect((await sql(`select count(*)::int as n from mcp_approvals where client_id = $1`, [client.body.id]))[0].n).toBe(0);
    expect((await sql(`select count(*)::int as n from checkout_sessions where org_id = $1`, [custom.orgId]))[0].n).toBe(0);
  });

  it('7. upgrading to Growth through billing unlocks exactly Growth’s modules', async () => {
    const res = await t.http.post(`/v1/o/${free.orgId}/billing/change-plan`).set(auth(free.owner)).send({ planId: 'growth' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ outcome: 'applied', subscription: { planId: 'growth', status: 'trialing' } });
    const view = await ents(free);
    for (const m of ['core', 'pay', 'connect', 'marketing', 'studio', 'intelligence']) expect(view.modules[m], m).toMatchObject({ enabled: true, source: 'plan' });
    for (const m of ['driver', 'finance', 'compliance', 'mcp']) expect(view.modules[m].enabled, m).toBe(false);
    expect((await t.http.get(`/v1/o/${free.orgId}/connect/conversations`).set(auth(free.owner))).status).toBe(200);
    expect((await t.http.get(`/v1/o/${free.orgId}/marketing/segments`).set(auth(free.owner))).status).toBe(200);
    expect((await t.http.get(`/v1/o/${free.orgId}/payments`).set(auth(free.owner))).status).toBe(200);
    expect((await t.http.get('/v1/public/payments/visit/bill').set('X-Visit-Token', visitToken)).status).toBe(200);
    // Still not entitled outside the plan.
    expect((await t.http.get(`/v1/o/${free.orgId}/finance/overview?from=${today}&to=${today}`).set(auth(free.owner))).status).toBe(402);
    expect((await t.http.get(`/v1/o/${free.orgId}/delivery/board`).set(auth(free.owner))).status).toBe(402);
  });

  it('8. the trial ends unpaid: past due keeps modules during grace; beyond grace everything locks', async () => {
    const lifecycle = t.app.get(BillingLifecycleService);
    const trialEnd = new Date((await ents(free)).trialEndsAt);
    expect(trialEnd.getTime()).toBeGreaterThan(Date.now());
    const t1 = new Date(trialEnd.getTime() + 5 * 60_000);
    expect(await lifecycle.run(t1, { orgIds: [free.orgId] })).toMatchObject({ trialsEnded: 1, invoicesDrafted: 1 });
    const pastDue = await ents(free);
    expect(pastDue.status).toBe('past_due');
    expect(new Date(pastDue.graceUntil).getTime()).toBe(t1.getTime() + 7 * 864e5);
    expect((await t.http.get(`/v1/o/${free.orgId}/connect/conversations`).set(auth(free.owner))).status).toBe(200); // within grace
    // The job runs again after the grace window: the subscription becomes unpaid.
    const t2 = new Date(t1.getTime() + 8 * 864e5);
    expect(await lifecycle.run(t2, { orgIds: [free.orgId] })).toMatchObject({ graceExpired: 1 });
    expect((await ents(free)).status).toBe('unpaid');
    const locked = await t.http.get(`/v1/o/${free.orgId}/connect/conversations`).set(auth(free.owner));
    expect(locked.status).toBe(402);
    expect(locked.body.error.code).toBe('module_not_entitled');
    expect((await t.http.get(`/v1/o/${free.orgId}/marketing/segments`).set(auth(free.owner))).status).toBe(402);
    expect((await t.http.get('/v1/public/payments/visit/bill').set('X-Visit-Token', visitToken)).status).toBe(402);
    const types = (await sql(`select event_type from subscription_events where org_id = $1 order by id`, [free.orgId])).map((r) => r.event_type);
    expect(types).toEqual(expect.arrayContaining(['upgraded', 'trial_ended', 'grace_expired']));
  });

  it('9. falling back to Free restores core immediately; paid modules stay locked', async () => {
    const down = await t.http.post(`/v1/o/${free.orgId}/billing/change-plan`).set(auth(free.owner)).send({ planId: 'free' });
    expect(down.body).toMatchObject({ outcome: 'applied', subscription: { planId: 'free', status: 'active' } });
    expect((await t.http.get(`/v1/o/${free.orgId}/menu`).set(auth(free.owner))).status).toBe(200);
    expect((await t.http.get(`/v1/o/${free.orgId}/connect/conversations`).set(auth(free.owner))).status).toBe(402);
  });
});
