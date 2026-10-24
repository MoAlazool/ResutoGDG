// 21-INBOX increment 1 (plan §6.5): GET /v1/o/:orgId/customers/:id/360.
// - One bounded read: stats, cadence, favourite items, identities, consent, first touch (recorded attribution first,
//   inferred only when labelled so, null when nothing is known), orders, reservations, loyalty, conversations, tags, notes.
// - customers:read; conversation parts only with connect:read and the Connect module; loyalty only with Marketing.
// - Another restaurant is a 404; branch-scoped staff see only their branches (RLS), including the first touch.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CUSTOMER_360_LIMITS } from '@resuto/contracts';
import { inbound, sandboxChannel } from './growth-helpers';
import { addMember, auth, bootTestApp, createTenant, seedMenu, sql, type SeededMenu, type TestApp, type TestTenant, type TestUser } from './helpers';
import { addBranch, placeOrder } from './insights-fixtures';

let t: TestApp;
let tenant: TestTenant;
let other: TestTenant;
let menu: SeededMenu;
let north: string;
let mainChannelId: string;
let cashier: TestUser;
let mainManager: TestUser;
const conn = (o: TestTenant) => `/v1/o/${o.orgId}/connect`;

beforeAll(async () => {
  t = await bootTestApp();
  tenant = await createTenant(t);
  other = await createTenant(t);
  menu = await seedMenu(tenant);
  north = await addBranch(t, tenant, 'North');
  mainChannelId = (await sandboxChannel(t, tenant, { displayName: 'Main WhatsApp', branchId: tenant.branchId })).id;
  cashier = await addMember(t, tenant, 'cashier');
  mainManager = await addMember(t, tenant, 'manager', [tenant.branchId]);
});
afterAll(async () => { await t.close(); });

const note = (u: TestUser, conversationId: string, body: string, key = `note-${Math.random().toString(36).slice(2)}`) =>
  t.http.post(`${conn(tenant)}/conversations/${conversationId}/notes`).set(auth(u)).send({ body, key });

describe('Customer 360', () => {
  let customerId: string;
  let conversationId: string;
  const phone = '+201005551234';

  beforeAll(async () => {
    const fries = (q = 1) => [{ productId: menu.products.fries, quantity: q }];
    const burger = [{ productId: menu.products.burger, quantity: 1, modifiers: [{ groupId: menu.groups.size, optionId: menu.options.regular }] }];
    // A tracked link click (clicks carry no customer) 40 days ago, then the first order from the same tracking session.
    await sql(`insert into attribution_events(org_id, kind, session_key, utm, occurred_at)
               values ($1, 'link_click', 'sess-hana-0001', '{"utm_source": "instagram", "utm_medium": "social", "utm_campaign": "eid-launch"}', now() - interval '40 days')`,
    [tenant.orgId]);
    const first = await placeOrder(t, tenant, { channel: 'web', fulfillment: 'pickup', lines: fries(2), customer: { name: 'Hana', phone, marketingConsent: true },
      attribution: { utm_source: 'newsletter', session_key: 'sess-hana-0001' } });
    customerId = first.customerId!;
    await placeOrder(t, tenant, { channel: 'qr', fulfillment: 'dine_in', tableId: menu.tableId, lines: [...fries(1), ...burger], customer: { phone } });
    await placeOrder(t, tenant, { channel: 'web', fulfillment: 'pickup', lines: fries(3), customer: { phone } });
    await placeOrder(t, tenant, { branchId: north, channel: 'web', fulfillment: 'pickup', lines: fries(1), customer: { phone } });
    // Spread the orders over time so the cadence has gaps: 30, 20, 10 days ago and today (north).
    const orders = await sql(`select id from orders where customer_id = $1 order by placed_at, id`, [customerId]);
    for (const [i, days] of [[0, 30], [1, 20], [2, 10]] as const) {
      await sql(`update orders set placed_at = now() - make_interval(days => $2) where id = $1`, [orders[i].id, days]);
    }
    // On the main branch's channel, so branch-scoped staff of another branch do not see it.
    const conv = await inbound(t, tenant, mainChannelId, phone, { text: 'Is my table ready?', name: 'Hana W' });
    conversationId = conv.conversationId;
    expect(conv.conversation.customer?.id).toBe(customerId);
    await note(tenant.owner, conversationId, 'Prefers the window table');
    const tag = (await t.http.post(`${conn(tenant)}/tags`).set(auth(tenant.owner)).send({ name: 'Regular', color: 'green' })).body;
    await t.http.put(`${conn(tenant)}/conversations/${conversationId}/tags/${tag.id}`).set(auth(tenant.owner)).expect(200);
    await t.http.patch(`/v1/o/${tenant.orgId}/customers/${customerId}`).set(auth(tenant.owner)).send({ tags: ['vip'], notes: 'Birthday in May' }).expect(200);
    await t.http.post(`/v1/o/${tenant.orgId}/loyalty/adjustments`).set(auth(tenant.owner)).send({ customerId, points: 40, reason: 'Welcome bonus' }).expect(201);
  });

  it('aggregates stats, cadence, items, identities, consent, first touch, orders, loyalty, conversations, tags and notes', async () => {
    const res = await t.http.get(`/v1/o/${tenant.orgId}/customers/${customerId}/360`).set(auth(tenant.owner));
    expect(res.status).toBe(200);
    const b = res.body;
    expect(b.customer).toMatchObject({ id: customerId, displayName: 'Hana', phone, tags: ['vip'] });
    expect(b.stats).toMatchObject({ source: 'customer_stats', orderCount: 4, currency: 'EGP' });
    expect(b.stats.averageOrderMinor).toBe(Math.round(b.stats.spendMinor / 4));
    expect(b.stats.cadence).toMatchObject({ basis: 'counted_orders', sampleSize: 4, ordersLast30Days: 3, ordersLast90Days: 4, daysSinceLastOrder: 0,
      medianDaysBetweenOrders: 10 });
    expect(b.topItems[0]).toMatchObject({ productId: menu.products.fries, quantity: 7, orderCount: 4 });
    expect(b.topItems.length).toBeLessThanOrEqual(CUSTOMER_360_LIMITS.topItems);
    expect(b.identities.map((i: any) => i.kind)).toContain('phone');
    expect(b.consent).toMatchObject({ perChannel: false, marketing: { granted: true, source: 'web' } });
    const wa = b.consent.channels.find((c: any) => c.channel === 'whatsapp');
    expect(wa).toMatchObject({ scope: 'customer', granted: true, serviceWindow: { open: true } });
    expect(b.consent.history[0]).toMatchObject({ purpose: 'marketing', granted: true, source: 'web' });
    expect(b.acquisition.firstTouch).toMatchObject({ basis: 'tracked_link_click', inferred: false, orderId: null,
      utm: { source: 'instagram', medium: 'social', campaign: 'eid-launch', content: null, term: null } });
    expect(b.recentOrders).toHaveLength(4);
    expect(b.loyalty).toMatchObject({ programActive: false, balance: 40 });
    expect(b.conversations).toEqual([expect.objectContaining({ id: conversationId, channelKind: 'whatsapp', contactName: 'Hana W',
      lastMessage: expect.objectContaining({ kind: expect.not.stringMatching(/^note$/) }), tags: [expect.objectContaining({ name: 'Regular' })] })]);
    expect(b.tags).toEqual({ customer: ['vip'], conversation: [expect.objectContaining({ name: 'Regular', color: 'green' })] });
    expect(b.notes.profile).toBe('Birthday in May');
    expect(b.notes.conversation).toEqual([expect.objectContaining({ conversationId, body: 'Prefers the window table' })]);
    expect(b.sections).toEqual({ conversations: 'included', loyalty: 'included' });
    expect(b.untrustedFields).toEqual(expect.arrayContaining(['customer.displayName', 'conversations[].lastMessage.body']));
  });

  it('labels an inferred first touch honestly and returns null when nothing is known', async () => {
    const walkIn = await placeOrder(t, tenant, { channel: 'qr', fulfillment: 'dine_in', tableId: menu.tableId, lines: [{ productId: menu.products.fries, quantity: 1 }],
      customer: { name: 'Walk-in', phone: '+201005559999' } });
    const r = await t.http.get(`/v1/o/${tenant.orgId}/customers/${walkIn.customerId}/360`).set(auth(tenant.owner));
    expect(r.body.acquisition.firstTouch).toMatchObject({ basis: 'first_order_channel', inferred: true, channel: 'qr', campaignId: null,
      utm: { source: null, medium: null, campaign: null } });
    // Recorded attribution on the order itself (no tracked click): the event written with the order is the first touch.
    const tagged = await placeOrder(t, tenant, { channel: 'web', fulfillment: 'pickup', lines: [{ productId: menu.products.fries, quantity: 1 }],
      customer: { name: 'Ad click', phone: '+201005556666' }, attribution: { utm_source: 'meta', utm_campaign: 'ramadan' } });
    const ad = await t.http.get(`/v1/o/${tenant.orgId}/customers/${tagged.customerId}/360`).set(auth(tenant.owner));
    expect(ad.body.acquisition.firstTouch).toMatchObject({ basis: 'attribution_event', inferred: false, channel: 'web', orderId: tagged.id,
      utm: { source: 'meta', campaign: 'ramadan', medium: null } });
    const [bare] = await sql(`insert into customers(org_id, display_name) values ($1, 'Imported') returning id`, [tenant.orgId]);
    const none = await t.http.get(`/v1/o/${tenant.orgId}/customers/${bare.id}/360`).set(auth(tenant.owner));
    expect(none.status).toBe(200);
    expect(none.body.acquisition.firstTouch).toBeNull();
    expect(none.body.stats).toMatchObject({ orderCount: 0, averageOrderMinor: 0, cadence: { medianDaysBetweenOrders: null, daysSinceLastOrder: null, sampleSize: 0 } });
  });

  it('needs customers:read, leaves conversations out without connect:read, and refuses other restaurants', async () => {
    const url = `/v1/o/${tenant.orgId}/customers/${customerId}/360`;
    // Cashiers read customers but not the inbox: no conversations, notes or service windows.
    const c = await t.http.get(url).set(auth(cashier));
    expect(c.status).toBe(200);
    expect(c.body.sections.conversations).toBe('no_permission');
    expect(c.body.conversations).toBeNull();
    expect(c.body.notes.conversation).toBeNull();
    expect(c.body.tags.conversation).toEqual([]);
    expect(c.body.consent.channels.every((ch: any) => ch.serviceWindow === null)).toBe(true);
    expect(JSON.stringify(c.body)).not.toContain('Prefers the window table');
    // Kitchen and drivers have no customers:read.
    const kitchen = await addMember(t, tenant, 'kitchen');
    expect((await t.http.get(url).set(auth(kitchen))).status).toBe(403);
    // Another restaurant: as a non-member, and through their own organization.
    expect((await t.http.get(url).set(auth(other.owner))).status).toBe(404);
    expect((await t.http.get(`/v1/o/${other.orgId}/customers/${customerId}/360`).set(auth(other.owner))).status).toBe(404);
    expect((await t.http.get(`/v1/o/${tenant.orgId}/customers/not-a-uuid/360`).set(auth(tenant.owner))).status).toBe(400);
  });

  it('shows branch-scoped staff only their branches\' orders, stats and conversations', async () => {
    const northCashier = await addMember(t, tenant, 'cashier', [north]);
    const r = await t.http.get(`/v1/o/${tenant.orgId}/customers/${customerId}/360`).set(auth(northCashier));
    expect(r.status).toBe(200);
    expect(r.body.stats).toMatchObject({ source: 'customer_branch_stats', orderCount: 1 });
    expect(r.body.recentOrders.map((o: any) => o.branchId)).toEqual([north]);
    // The first touch came from a main-branch order: not visible to north staff, so it is inferred from their order.
    expect(r.body.acquisition.firstTouch).toMatchObject({ basis: 'first_order_channel', inferred: true });
    const northManager = await addMember(t, tenant, 'manager', [north]);
    const m = await t.http.get(`/v1/o/${tenant.orgId}/customers/${customerId}/360`).set(auth(northManager));
    expect(m.body.sections.conversations).toBe('included');
    expect(m.body.conversations).toEqual([]); // the conversation is on the main-branch channel
    expect(m.body.notes.conversation).toEqual([]);
    expect(m.body.tags.conversation).toEqual([]);
    expect(JSON.stringify(m.body)).not.toContain('Prefers the window table');
    // The main branch's manager sees it.
    const mm = await t.http.get(`/v1/o/${tenant.orgId}/customers/${customerId}/360`).set(auth(mainManager));
    expect(mm.body.conversations.map((c: any) => c.id)).toEqual([conversationId]);
    expect(mm.body.notes.conversation).toEqual([expect.objectContaining({ body: 'Prefers the window table' })]);
    // A customer with nothing in their branches is not visible at all.
    const mainOnly = await placeOrder(t, tenant, { channel: 'web', fulfillment: 'pickup', lines: [{ productId: menu.products.fries, quantity: 1 }],
      customer: { name: 'Main only', phone: '+201005558888' } });
    expect((await t.http.get(`/v1/o/${tenant.orgId}/customers/${mainOnly.customerId}/360`).set(auth(northCashier))).status).toBe(404);
  });

  it('marks sections the plan does not include', async () => {
    const free = await createTenant(t, { planId: 'free' });
    const freeMenu = await seedMenu(free);
    const o = await placeOrder(t, free, { channel: 'qr', fulfillment: 'dine_in', tableId: freeMenu.tableId, lines: [{ productId: freeMenu.products.fries, quantity: 1 }],
      customer: { name: 'Free', phone: '+201005557777' } });
    const r = await t.http.get(`/v1/o/${free.orgId}/customers/${o.customerId}/360`).set(auth(free.owner));
    expect(r.status).toBe(200);
    expect(r.body.sections).toEqual({ conversations: 'not_entitled', loyalty: 'not_entitled' });
    expect(r.body.conversations).toBeNull();
    expect(r.body.loyalty).toBeNull();
  });
});
