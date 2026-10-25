// 21-CRM (plan §6.7): customers.first_touch (migration 20261027210001).
// - Set once, at the commit of the customer's first identified interaction (order, attributed event, conversation),
//   from attribution_events / tracked-link sessions / order attribution, inferred otherwise; never overwritten.
// - A tracked link click stores the link id, so the first touch names the link.
// - app.backfill_first_touch(org) fills customers that have none (idempotent).
// - Customer 360 and the overview's acquisition read the stored touch (`stored: true`, dataCoverage
//   acquisitionStoredFirstTouch) without changing their response shapes; branch-scoped callers fall back to the
//   derived touch when the stored one rests on another branch.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inbound, sandboxChannel } from './growth-helpers';
import { addMember, auth, bootTestApp, createTenant, seedMenu, sql, testDb, unique, type SeededMenu, type TestApp, type TestTenant } from './helpers';
import { addBranch, placeOrder } from './insights-fixtures';

let t: TestApp;
let tenant: TestTenant;
let menu: SeededMenu;
let north: string;
const firstTouch = async (customerId: string) => (await sql(`select first_touch from customers where id = $1`, [customerId]))[0].first_touch;
const friesLine = () => [{ productId: menu.products.fries, quantity: 1 }];
const webOrder = (phone: string, attribution: Record<string, string> = {}, name = 'Guest') =>
  t.http.post(`/v1/public/order/${tenant.slug}/orders`).set('Idempotency-Key', unique('ft'))
    .send({ branchId: tenant.branchId, fulfillment: 'pickup', payment: 'pay_at_pickup', lines: [{ productId: menu.products.soda, quantity: 1 }],
      customer: { name, phone }, attribution });

beforeAll(async () => {
  t = await bootTestApp();
  tenant = await createTenant(t);
  menu = await seedMenu(tenant);
  north = await addBranch(t, tenant, 'North');
});
afterAll(async () => { await t.close(); });

describe('customers.first_touch', () => {
  it('stores a tracked link click as the first touch, with its link and campaign, when the guest orders from that session', async () => {
    const [campaign] = await sql(`insert into campaigns(org_id, name, channel, utm_campaign, is_sandbox) values ($1, 'Eid', 'whatsapp', $2, false) returning id`, [tenant.orgId, unique('eid')]);
    const link = await t.http.post(`/v1/o/${tenant.orgId}/marketing/links`).set(auth(tenant.owner))
      .send({ campaignId: campaign.id, destinationPath: `/order/${tenant.slug}`, utm: { source: 'instagram', medium: 'story' } });
    expect(link.status).toBe(201);
    const click = await t.http.get(`/v1/public/l/${link.body.code}`);
    const dest = new URL(click.body.destination, 'http://app.test');
    const [ev] = await sql(`select link_id from attribution_events where kind = 'link_click' and session_key = $1`, [dest.searchParams.get('rsid')]);
    expect(ev.link_id).toBe(link.body.id);
    const res = await webOrder('+201008880001', { utm_source: 'instagram', utm_campaign: dest.searchParams.get('utm_campaign')!,
      campaignId: dest.searchParams.get('rcid')!, sessionKey: dest.searchParams.get('rsid')! }, 'Linked');
    expect(res.status).toBe(201);
    const [o] = await sql(`select customer_id from orders where id = $1`, [res.body.order.id]);
    const ft = await firstTouch(o.customer_id);
    expect(ft).toMatchObject({ basis: 'tracked_link_click', inferred: false, linkId: link.body.id, campaignId: campaign.id, orderId: null,
      branchId: tenant.branchId, setBy: 'live', utm: { source: 'instagram', medium: 'story', campaign: expect.any(String) } });
    // Customer 360 reads it (same response shape, plus the additive linkId / stored).
    const c360 = (await t.http.get(`/v1/o/${tenant.orgId}/customers/${o.customer_id}/360`).set(auth(tenant.owner))).body;
    expect(c360.acquisition.firstTouch).toMatchObject({ basis: 'tracked_link_click', inferred: false, stored: true, linkId: link.body.id,
      campaignId: campaign.id, campaignName: 'Eid', orderId: null, utm: { source: 'instagram', medium: 'story' } });
    expect(Object.keys(c360.acquisition.firstTouch).sort()).toEqual(['basis', 'campaignId', 'campaignName', 'channel', 'inferred', 'linkId', 'occurredAt',
      'orderId', 'stored', 'utm']);
  });

  it('is set once and never overwritten: later attributed orders and direct updates leave it as it was', async () => {
    const plain = await placeOrder(t, tenant, { channel: 'qr', fulfillment: 'dine_in', tableId: menu.tableId, lines: friesLine(), customer: { name: 'Walk-in', phone: '+201008880002' } });
    const before = await firstTouch(plain.customerId!);
    expect(before).toMatchObject({ basis: 'first_order_channel', inferred: true, channel: 'qr', orderId: plain.id, branchId: tenant.branchId });
    // A later campaign order is a later touch, not the first one.
    const later = await webOrder('+201008880002', { utm_source: 'facebook', utm_campaign: 'later' });
    expect(later.status).toBe(201);
    expect(await firstTouch(plain.customerId!)).toEqual(before);
    // Even a direct update by the owner connection keeps the stored value (trigger customers_first_touch_keep).
    await sql(`update customers set first_touch = '{"basis":"attribution_event","occurredAt":"2020-01-01T00:00:00.000Z"}' where id = $1`, [plain.customerId]);
    expect(await firstTouch(plain.customerId!)).toEqual(before);
    await sql(`update customers set first_touch = null where id = $1`, [plain.customerId]);
    expect(await firstTouch(plain.customerId!)).toEqual(before);
    // The 360 shows the stored first touch rather than the later campaign.
    const c360 = (await t.http.get(`/v1/o/${tenant.orgId}/customers/${plain.customerId}/360`).set(auth(tenant.owner))).body;
    expect(c360.acquisition.firstTouch).toMatchObject({ basis: 'first_order_channel', inferred: true, stored: true, channel: 'qr' });
  });

  it('prefers the attribution event written with an order to the order itself (same moment)', async () => {
    const res = await webOrder('+201008880003', { utm_source: 'meta', utm_campaign: 'ramadan' }, 'Ad click');
    const [o] = await sql(`select id, customer_id from orders where id = $1`, [res.body.order.id]);
    const [ev] = await sql(`select id from attribution_events where order_id = $1 and kind = 'order_placed'`, [o.id]);
    expect(await firstTouch(o.customer_id)).toMatchObject({ basis: 'attribution_event', inferred: false, channel: 'web', orderId: o.id, eventId: Number(ev.id),
      utm: { source: 'meta', campaign: 'ramadan', medium: null } });
  });

  it('records a WhatsApp chat as an inferred first touch (the conversation channel)', async () => {
    const channel = await sandboxChannel(t, tenant, { displayName: 'WA', branchId: north });
    const conv = await inbound(t, tenant, channel.id, '+201008880004', { text: 'hello', name: 'Chatty' });
    const customerId = conv.conversation.customer.id as string;
    expect(await firstTouch(customerId)).toMatchObject({ basis: 'first_conversation_channel', inferred: true, channel: 'whatsapp', branchId: north, orderId: null });
    // A cashier (no conversation access) does not see the conversation-based touch: the 360 derives one without it.
    const cashier = await addMember(t, tenant, 'cashier');
    const c = await t.http.get(`/v1/o/${tenant.orgId}/customers/${customerId}/360`).set(auth(cashier));
    expect(c.status).toBe(200);
    expect(c.body.acquisition.firstTouch).toBeNull();
  });

  it('falls back to the derived touch for branch-scoped staff when the stored one rests on another branch', async () => {
    const main = await placeOrder(t, tenant, { channel: 'web', fulfillment: 'pickup', lines: friesLine(), customer: { name: 'Two branches', phone: '+201008880005' },
      attribution: { utm_source: 'tiktok' } });
    await placeOrder(t, tenant, { branchId: north, channel: 'qr', fulfillment: 'pickup', lines: friesLine(), customer: { phone: '+201008880005' } });
    expect(await firstTouch(main.customerId!)).toMatchObject({ basis: 'attribution_event', branchId: tenant.branchId });
    const northCashier = await addMember(t, tenant, 'cashier', [north]);
    const r = (await t.http.get(`/v1/o/${tenant.orgId}/customers/${main.customerId}/360`).set(auth(northCashier))).body;
    expect(r.acquisition.firstTouch).toMatchObject({ basis: 'first_order_channel', inferred: true, stored: false, channel: 'qr' });
    expect(JSON.stringify(r.acquisition)).not.toContain('tiktok');
  });

  it('backfills customers without one, idempotently', async () => {
    // Rows loaded without triggers (as a bulk import would): no first touch.
    const [cu] = await sql(`insert into customers(org_id, display_name, phone_e164) values ($1, 'Imported', '+201008880006') returning id`, [tenant.orgId]);
    const c = await testDbClient();
    try {
      await c.query(`set session_replication_role = replica`);
      await c.query(`insert into orders(org_id, branch_id, number, channel, fulfillment, currency, subtotal_minor, total_minor, customer_id, attribution, placed_at)
                     values ($1, $2, 'imp-1', 'web', 'pickup', 'EGP', 100, 100, $3, '{"utm_source":"google","utm_medium":"cpc"}', '2026-05-01T10:00:00Z')`,
      [tenant.orgId, tenant.branchId, cu.id]);
    } finally {
      await c.query(`set session_replication_role = origin`);
      c.release();
    }
    expect(await firstTouch(cu.id)).toBeNull();
    const [{ n }] = await sql(`select app.backfill_first_touch($1) as n`, [tenant.orgId]);
    expect(n).toBeGreaterThanOrEqual(1);
    const ft = await firstTouch(cu.id);
    expect(ft).toMatchObject({ basis: 'order_attribution', inferred: false, channel: 'web', setBy: 'backfill', occurredAt: '2026-05-01T10:00:00.000Z',
      utm: { source: 'google', medium: 'cpc' } });
    // Running it again changes nothing.
    const [{ n: again }] = await sql(`select app.backfill_first_touch($1) as n`, [tenant.orgId]);
    expect(again).toBe(0);
    expect(await firstTouch(cu.id)).toEqual(ft);
    // A customer with no interaction at all stays without one.
    const [bare] = await sql(`insert into customers(org_id, display_name) values ($1, 'Nobody') returning id`, [tenant.orgId]);
    await sql(`select app.backfill_first_touch($1)`, [tenant.orgId]);
    expect(await firstTouch(bare.id)).toBeNull();
  });

  it('feeds the overview acquisition (same shape; stored touches counted in dataCoverage)', async () => {
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const res = await t.http.get(`/v1/o/${tenant.orgId}/analytics/overview?from=${day}&to=${day}`).set(auth(tenant.owner));
    expect(res.status).toBe(200);
    const a = res.body.period.acquisition;
    expect(Object.keys(a).sort()).toEqual(['attributed', 'channels', 'inferred', 'newCustomers']);
    const by = Object.fromEntries(a.channels.map((c: any) => [c.channel, c]));
    // New today: Linked (its campaign), Ad click (utm_campaign → campaign link), Two branches (tiktok), Walk-in (qr,
    // inferred; their later facebook order is not the first touch). Chatty has no order; Imported's first order is older.
    expect(a).toMatchObject({ newCustomers: 4, attributed: 3, inferred: 1 });
    expect(by.campaign_link).toEqual({ channel: 'campaign_link', customers: 2, attributed: 2, inferred: 0 });
    expect(by.tiktok).toEqual({ channel: 'tiktok', customers: 1, attributed: 1, inferred: 0 });
    expect(by.qr).toEqual({ channel: 'qr', customers: 1, attributed: 0, inferred: 1 });
    expect(by.facebook).toBeUndefined();
    expect(res.body.period.meta.dataCoverage.acquisitionStoredFirstTouch).toBe(a.newCustomers);
  });
});

const testDbClient = () => testDb().connect();
