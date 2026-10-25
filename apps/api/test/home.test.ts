import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ATTENTION_KINDS, OVERVIEW_SECTIONS } from '@resuto/contracts/home';
import { DbService } from '../src/common/db/db.service';
import { RateLimiter } from '../src/common/http/rate-limiter';
import { PREFERENCES_PER_MINUTE } from '../src/modules/home/home.controller';
import { OrdersKernelService } from '../src/modules/kernel/orders-kernel.service';
import { addMember, auth, bootTestApp, createTenant, seedMenu, sql, unique, type SeededMenu, type TestApp, type TestTenant, type TestUser } from './helpers';
import { addBranch, ownerCtx, placeOrder } from './insights-fixtures';

// 21-HOME (plan §6.1): the overview's period (from/to/compare, customers, acquisition, campaigns), its new live
// fields, GET /o/:orgId/attention (permission-gated per kind, branch-scoped, tenant-isolated) and the per-user overview
// preferences (GET/PUT, only the user themself).

let t: TestApp;
beforeAll(async () => { t = await bootTestApp(); });
afterAll(async () => { await t.close(); });

const transition = (tenant: TestTenant, orderId: string, to: any) => {
  const ctx = ownerCtx(tenant);
  return t.app.get(DbService).scoped(ctx, (tx) => t.app.get(OrdersKernelService).transition(tx, ctx, orderId, to));
};

describe('overview period (from/to/compare)', () => {
  let tenant: TestTenant;
  let menu: SeededMenu;
  let north: string;
  let manager: TestUser;
  let base: string;
  const ids: Record<string, string> = {};
  const week = { from: '2026-09-01', to: '2026-09-07' };
  const get = (u: TestUser, params: Record<string, string>) => t.http.get(`${base}?${new URLSearchParams(params)}`).set(auth(u));

  beforeAll(async () => {
    tenant = await createTenant(t, { country: 'EG' });
    menu = await seedMenu(tenant);
    north = await addBranch(t, tenant, 'North');
    manager = await addMember(t, tenant, 'manager', [tenant.branchId]);
    base = `/v1/o/${tenant.orgId}/analytics/overview`;
    const [real] = await sql(`insert into campaigns(org_id, name, channel, utm_campaign, is_sandbox, status) values ($1, 'Eid link', 'whatsapp', $2, false, 'sent') returning id`, [tenant.orgId, unique('utm')]);
    const [sandbox] = await sql(`insert into campaigns(org_id, name, channel, utm_campaign, is_sandbox, status) values ($1, 'Sandbox blast', 'whatsapp', $2, true, 'sent') returning id`, [tenant.orgId, unique('utm')]);
    ids.real = real.id;
    const fries = [{ productId: menu.products.fries, quantity: 1 }];
    const place = async (key: string, at: string, extra: Record<string, unknown>) => {
      const o = await placeOrder(t, tenant, { channel: 'web', fulfillment: 'pickup', lines: fries, ...extra } as any);
      await sql(`update orders set placed_at = $2 where id = $1`, [o.id, at]);
      ids[key] = o.id;
      return o;
    };
    const insta = { name: 'Insta', phone: '+201006660001' };
    const old = { name: 'Old', phone: '+201006660004' };
    // Previous period (Aug 25-31): Old's first order.
    await place('D1', '2026-08-28T10:00:00Z', { channel: 'staff', customer: old });
    // The period (Sep 1-7).
    await place('A1', '2026-09-02T10:00:00Z', { customer: insta, attribution: { utm_source: 'Instagram', utm_medium: 'bio' } });
    await place('A2', '2026-09-04T10:00:00Z', { customer: insta });
    await place('B1', '2026-09-03T10:00:00Z', { customer: { name: 'Camp', phone: '+201006660002' }, campaignId: real.id });
    await place('C1', '2026-09-05T10:00:00Z', { channel: 'qr', fulfillment: 'dine_in', tableId: menu.tableId, customer: { name: 'Table', phone: '+201006660003' } });
    await place('D2', '2026-09-06T10:00:00Z', { channel: 'staff', customer: old });
    await place('E1', '2026-09-06T11:00:00Z', { channel: 'whatsapp', customer: { name: 'Sandboxed', phone: '+201006660005' }, campaignId: sandbox.id });
    await place('F1', '2026-09-06T12:00:00Z', { branchId: north, customer: { name: 'North', phone: '+201006660006' } });
    // A cancelled order in the period is not counted.
    await place('X1', '2026-09-05T12:00:00Z', { customer: { name: 'Cancel', phone: '+201006660007' } });
    await transition(tenant, ids.X1!, 'cancelled');
    // Last year (Sep 1-7 2025): one anonymous order.
    await place('L1', '2025-09-03T10:00:00Z', { channel: 'staff' });
    // Three clicks on the real campaign's tracked link and one on the sandbox one, in the period.
    for (const c of [real.id, real.id, real.id, sandbox.id]) {
      await sql(`insert into attribution_events(org_id, kind, campaign_id, session_key, utm, occurred_at) values ($1, 'link_click', $2, $3, '{}', '2026-09-02T09:00:00Z')`,
        [tenant.orgId, c, unique('s')]);
    }
  });

  const totalOf = async (keys: string[]) => Number((await sql(`select coalesce(sum(total_minor - refunded_minor), 0) as n from orders where id = any($1)`, [keys.map((k) => ids[k])]))[0].n);

  it('keeps the default response unchanged without from/to (no period)', async () => {
    const res = await t.http.get(base).set(auth(tenant.owner));
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('period');
    expect(res.body).toHaveProperty('today');
    expect(res.body).toHaveProperty('lastWeekSameTime');
    expect(res.body.meta.method).toMatch(/same weekday/);
  });

  it('measures the period against the previous period by default', async () => {
    const res = await get(tenant.owner, week);
    expect(res.status).toBe(200);
    const p = res.body.period;
    expect(p).toMatchObject({ from: week.from, to: week.to, days: 7, compare: 'previous_period' });
    const net = await totalOf(['A1', 'A2', 'B1', 'C1', 'D2', 'E1', 'F1']);
    expect(p.current).toMatchObject({ orders: 7, netMinor: net, customers: 6, repeatCustomers: 1, repeatRatePct: 16.67 });
    expect(p.comparison).toMatchObject({ from: '2026-08-25', to: '2026-08-31', kpis: { orders: 1, customers: 1, repeatCustomers: 0, repeatRatePct: 0 } });
    expect(p.changePct).toMatchObject({ orders: 600, repeatRatePts: 16.67 });
    expect(p.daily).toHaveLength(7);
    expect(p.daily.reduce((a: number, d: any) => a + d.orders, 0)).toBe(7);
    expect(p.comparisonDaily).toHaveLength(7);
    expect(p.customers).toMatchObject({ newCustomers: 5, returningCustomers: 1, ordersWithoutCustomer: 0 });
  });

  it('labels acquisition by first touch: attributed from recorded attribution, otherwise inferred from the first order channel', async () => {
    const p = (await get(tenant.owner, week)).body.period;
    const by = Object.fromEntries(p.acquisition.channels.map((c: any) => [c.channel, c]));
    expect(by.instagram).toEqual({ channel: 'instagram', customers: 1, attributed: 1, inferred: 0 });
    expect(by.campaign_link).toEqual({ channel: 'campaign_link', customers: 1, attributed: 1, inferred: 0 });
    expect(by.qr).toEqual({ channel: 'qr', customers: 1, attributed: 0, inferred: 1 });
    // The sandbox campaign is test data: that customer counts by their first order's channel, as inferred.
    expect(by.whatsapp).toEqual({ channel: 'whatsapp', customers: 1, attributed: 0, inferred: 1 });
    expect(by.website).toEqual({ channel: 'website', customers: 1, attributed: 0, inferred: 1 });
    // Old was acquired before the period: not a new customer.
    expect(by.in_venue).toBeUndefined();
    expect(p.acquisition).toMatchObject({ newCustomers: 5, attributed: 2, inferred: 3 });
    expect(p.meta.kind).toBe('mixed');
    expect(p.meta.dataCoverage).toMatchObject({ acquisitionInferred: 3, sandboxCampaignTouches: 1, campaignClicksIncluded: true });
  });

  it('reports campaign conversion from tracked clicks, excluding sandbox campaigns', async () => {
    const c = (await get(tenant.owner, week)).body.period.campaigns;
    expect(c).toMatchObject({ attributedOrders: 1, clicksIncluded: true, excludedSandboxOrders: 1 });
    expect(c.items).toEqual([{ campaignId: ids.real, name: 'Eid link', channel: 'whatsapp', orders: 1, netMinor: await totalOf(['B1']), clicks: 3, conversionPct: 33.33 }]);
  });

  it('compares with the same dates last year, or with nothing', async () => {
    const ly = (await get(tenant.owner, { ...week, compare: 'last_year' })).body.period;
    expect(ly.comparison).toMatchObject({ from: '2025-09-01', to: '2025-09-07', kpis: { orders: 1, customers: 0, repeatRatePct: null } });
    expect(ly.changePct).toMatchObject({ orders: 600, repeatRatePts: null });
    const none = (await get(tenant.owner, { ...week, compare: 'none' })).body.period;
    expect(none).toMatchObject({ compare: 'none', comparison: null, changePct: null, comparisonDaily: null });
    expect(none.current.orders).toBe(7);
  });

  it('follows the branch: the shell branch narrows, a branch-scoped member sees only their branch and no organization-wide clicks', async () => {
    const n = (await get(tenant.owner, { ...week, branchId: north })).body.period;
    expect(n.current).toMatchObject({ orders: 1, customers: 1 });
    expect(n.campaigns).toMatchObject({ clicksIncluded: false });
    const m = await get(manager, week);
    expect(m.status).toBe(200);
    expect(m.body.period.current).toMatchObject({ orders: 6, customers: 5 });
    expect(m.body.period.acquisition.channels.map((c: any) => c.channel)).not.toContain('website');
    expect(m.body.period.campaigns.items[0]).toMatchObject({ orders: 1, clicks: null, conversionPct: null });
    expect((await get(manager, { ...week, branchId: north })).status).toBe(403);
  });

  it('validates the period', async () => {
    expect((await get(tenant.owner, { from: week.from })).status).toBe(400);
    expect((await get(tenant.owner, { to: week.to })).status).toBe(400);
    expect((await get(tenant.owner, { from: week.to, to: week.from })).status).toBe(400);
    expect((await get(tenant.owner, { compare: 'last_year' })).status).toBe(400);
    expect((await get(tenant.owner, { ...week, compare: 'yesterday' })).status).toBe(400);
    expect((await get(tenant.owner, { from: '2025-01-01', to: '2026-09-07' })).status).toBe(400);
    expect((await get(tenant.owner, { from: '2026-09-31', to: '2026-10-01' })).status).toBe(400);
  });

  it('refuses a role without analytics:read and another restaurant', async () => {
    const kitchen = await addMember(t, tenant, 'kitchen');
    expect((await get(kitchen, week)).status).toBe(403);
    const other = await createTenant(t, { country: 'EG' });
    const res = await get(other.owner, week);
    expect([403, 404]).toContain(res.status);
    expect(JSON.stringify(res.body)).not.toContain('Eid link');
    expect((await t.http.get(`${base}?${new URLSearchParams({ ...week, branchId: other.branchId })}`).set(auth(tenant.owner))).status).toBe(404);
  });
});

describe('overview "right now" fields', () => {
  let tenant: TestTenant;
  let menu: SeededMenu;
  let base: string;

  beforeAll(async () => {
    tenant = await createTenant(t, { country: 'EG' });
    menu = await seedMenu(tenant);
    base = `/v1/o/${tenant.orgId}/analytics/overview`;
    await sql(`insert into dining_tables(org_id, branch_id, label, capacity, qr_token, status) values ($1, $2, 'T2', 2, $3, 'out_of_service'), ($1, $2, 'T3', 2, $4, 'available')`,
      [tenant.orgId, tenant.branchId, `qr-${unique('a')}`.padEnd(20, 'x'), `qr-${unique('b')}`.padEnd(20, 'x')]);
    await sql(`insert into visits(org_id, branch_id, table_id, guest_token_hash) values ($1, $2, $3, md5(random()::text))`, [tenant.orgId, tenant.branchId, menu.tableId]);
    const o = await placeOrder(t, tenant, { channel: 'staff', fulfillment: 'pickup', lines: [{ productId: menu.products.fries, quantity: 3 }] });
    await transition(tenant, o.id, 'accepted');
    await sql(
      `insert into reservations(org_id, branch_id, table_id, guest_name, party_size, starts_at, ends_at, blocked_until, status)
       values ($1, $2, $3, 'Nadia', 3, now() + interval '2 minutes', now() + interval '92 minutes', now() + interval '107 minutes', 'confirmed')`,
      [tenant.orgId, tenant.branchId, menu.tableId]);
  });

  it('counts tables occupied and free, kitchen load per station and the next reservations', async () => {
    const res = await t.http.get(base).set(auth(tenant.owner));
    expect(res.status).toBe(200);
    expect(res.body.live.tables).toEqual({ total: 3, occupied: 1, outOfService: 1, free: 1 });
    expect(res.body.live.stations).toEqual([{ station: 'Grill', queued: 3, preparing: 0 }]);
    const sameDay = (await sql(`select ((now() + interval '2 minutes') at time zone 'Africa/Cairo')::date = (now() at time zone 'Africa/Cairo')::date as same`))[0].same;
    if (sameDay) expect(res.body.reservationsToday.next).toEqual([expect.objectContaining({ guestName: 'Nadia', partySize: 3, tableLabel: 'T1', status: 'confirmed' })]);
    else expect(res.body.reservationsToday.next).toEqual([]);
  });

  it('leaves out guest names for a role that cannot read reservations', async () => {
    const marketing = await addMember(t, tenant, 'marketing');
    const res = await t.http.get(base).set(auth(marketing));
    expect(res.status).toBe(200);
    expect(res.body.reservationsToday.next).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain('Nadia');
  });
});

describe('GET /o/:orgId/attention', () => {
  let tenant: TestTenant;
  let menu: SeededMenu;
  let north: string;
  let url: string;
  const ids: Record<string, string> = {};
  const get = (u: TestUser, extra = '') => t.http.get(`${url}${extra}`).set(auth(u));
  const kinds = (res: any) => res.body.items.map((i: any) => i.kind);
  const item = (res: any, kind: string) => res.body.items.find((i: any) => i.kind === kind);

  beforeAll(async () => {
    tenant = await createTenant(t, { country: 'EG' });
    menu = await seedMenu(tenant);
    north = await addBranch(t, tenant, 'North');
    url = `/v1/o/${tenant.orgId}/attention`;
    const fries = [{ productId: menu.products.fries, quantity: 1 }];
    // Slow orders: one at main 45 minutes old (warning), one at north 90 minutes old (critical); a fresh one is not slow.
    for (const [key, branchId, minutes] of [['slowMain', tenant.branchId, 45], ['slowNorth', north, 90], ['fresh', tenant.branchId, 0]] as const) {
      const o = await placeOrder(t, tenant, { branchId, channel: 'staff', fulfillment: 'pickup', lines: fries });
      await sql(`update orders set placed_at = now() - make_interval(mins => $2) where id = $1`, [o.id, minutes]);
      ids[key] = o.id;
    }
    // An unpaid bill: picked up, nothing paid.
    const u = await placeOrder(t, tenant, { channel: 'web', fulfillment: 'pickup', lines: fries, customer: { name: 'Late payer', phone: '+201008880001' } });
    for (const s of ['accepted', 'preparing', 'ready', 'picked_up']) await transition(tenant, u.id, s);
    ids.unpaid = u.id;
    // Low stock at main.
    const inv = `/v1/o/${tenant.orgId}/inventory`;
    const itemRes = await t.http.post(`${inv}/items`).set(auth(tenant.owner)).send({ name: 'Limes', unit: 'kg', costPerUnitMinor: 1000, reorderLevel: 5 });
    await t.http.post(`${inv}/movements`).set(auth(tenant.owner)).send({ kind: 'purchase', branchId: tenant.branchId, itemId: itemRes.body.id, quantity: 2 });
    await t.http.post(`${inv}/movements`).set(auth(tenant.owner)).send({ kind: 'waste', branchId: tenant.branchId, itemId: itemRes.body.id, quantity: 500, unit: 'g', reason: 'spoiled' });
    // Integrations: a failing sandbox connection; a Meta token (no server-side refresh) expiring in 3 days; a Snapchat
    // token (refreshed by the worker) expiring in an hour, which is not something to act on.
    await sql(`insert into integration_connections(org_id, provider, category, auth_type, environment, status, enabled) values ($1, 'foodics', 'pos', 'oauth', 'sandbox', 'error', true)`, [tenant.orgId]);
    await sql(`insert into integration_connections(org_id, provider, category, auth_type, environment, status, enabled, config) values
      ($1, 'meta_ads', 'ads', 'oauth', 'live', 'connected', true, jsonb_build_object('tokenExpiresAt', (now() + interval '3 days')::text)),
      ($1, 'snapchat_ads', 'ads', 'oauth', 'live', 'connected', true, jsonb_build_object('tokenExpiresAt', (now() + interval '1 hour')::text))`, [tenant.orgId]);
    // Change sets waiting for approval: one with an operation at north, one organization-wide; an expired one is not pending.
    const cs = async (title: string, expires: string, branch: string | null) => {
      const [row] = await sql(`insert into change_sets(org_id, origin, actor_type, actor_id, title, status, expires_at) values ($1, 'staff', 'user', $2, $3, 'pending_approval', now() + $4::interval) returning id`,
        [tenant.orgId, tenant.owner.userId, title, expires]);
      if (branch) {
        await sql(`insert into change_ops(org_id, change_set_id, seq, op_type, op_group, kind, input, branch_id) values ($1, $2, 0, 'menu.item.availability.set', 'menu', 'local', '{}', $3)`,
          [tenant.orgId, row.id, branch]);
      }
      return row.id;
    };
    ids.csNorth = await cs('North availability', '24 hours', north);
    ids.csOrg = await cs('Raise tea price', '2 hours', null);
    await sql(`insert into change_sets(org_id, origin, actor_type, actor_id, title, status, expires_at) values ($1, 'staff', 'user', $2, 'Old', 'pending_approval', now() - interval '1 minute')`, [tenant.orgId, tenant.owner.userId]);
    // A creative draft and a campaign waiting for approval.
    await sql(`insert into creative_assets(org_id, kind, prompt, output, provider) values ($1, 'caption', 'Eid', '{"text":"Eid"}', 'template_rules')`, [tenant.orgId]);
    await sql(`insert into campaigns(org_id, name, channel, utm_campaign, status) values ($1, 'Weekend promo', 'whatsapp', $2, 'pending_approval')`, [tenant.orgId, unique('utm')]);
    // A negative rating at main (the guest's own words) and a good one.
    await sql(`insert into guest_ratings(org_id, branch_id, source, order_id, overall, comment) values ($1, $2, 'web', $3, 1, 'Cold fries <b>again</b>')`, [tenant.orgId, tenant.branchId, ids.unpaid]);
    await sql(`insert into guest_ratings(org_id, branch_id, source, order_id, overall) values ($1, $2, 'web', $3, 5)`, [tenant.orgId, tenant.branchId, ids.fresh]);
  });

  it('lists every kind the owner can act on, most severe first, with counts, samples, links and sources', async () => {
    const res = await get(tenant.owner);
    expect(res.status).toBe(200);
    expect(res.body.checked).toEqual([...ATTENTION_KINDS]);
    expect(res.body.omitted).toEqual([]);
    expect(new Set(kinds(res))).toEqual(new Set(ATTENTION_KINDS));
    const severities = res.body.items.map((i: any) => i.severity);
    expect(severities).toEqual([...severities].sort((a: string, b: string) => ['critical', 'warning', 'info'].indexOf(a) - ['critical', 'warning', 'info'].indexOf(b)));
    expect(item(res, 'slow_orders')).toMatchObject({ severity: 'critical', count: 2, href: '/orders', source: 'orders', provenance: 'live' });
    expect(item(res, 'slow_orders').samples.map((s: any) => s.id)).toEqual([ids.slowNorth, ids.slowMain]);
    expect(item(res, 'unpaid_bills')).toMatchObject({ count: 1, samples: [expect.objectContaining({ id: ids.unpaid, value: 4500 })] });
    expect(item(res, 'low_stock')).toMatchObject({ severity: 'warning', count: 1, href: '/inventory?tab=alerts', samples: [expect.objectContaining({ label: 'Limes', value: 1.5 })] });
    expect(item(res, 'integrations_failing')).toMatchObject({ severity: 'warning', count: 1, provenance: 'sandbox', samples: [expect.objectContaining({ label: 'foodics' })] });
    expect(item(res, 'tokens_expiring')).toMatchObject({ severity: 'warning', count: 1, provenance: 'live', samples: [expect.objectContaining({ label: 'meta_ads' })] });
    expect(item(res, 'change_approvals')).toMatchObject({ severity: 'warning', count: 2, href: '/approvals', source: 'change_sets' });
    expect(item(res, 'change_approvals').samples[0].id).toBe(ids.csOrg);
    expect(item(res, 'creative_approvals')).toMatchObject({ severity: 'info', count: 1, samples: [expect.objectContaining({ label: 'caption' })] });
    expect(item(res, 'campaign_approvals')).toMatchObject({ count: 1, samples: [expect.objectContaining({ label: 'Weekend promo' })] });
    expect(item(res, 'negative_reviews')).toMatchObject({ count: 1, samples: [expect.objectContaining({ value: 1, label: 'Cold fries <b>again</b>' })] });
    expect(res.body.rules).toMatchObject({ slowOrderMinutes: 30 });
  });

  it('narrows to the shell branch', async () => {
    const res = await get(tenant.owner, `?branchId=${tenant.branchId}`);
    expect(res.status).toBe(200);
    expect(item(res, 'slow_orders')).toMatchObject({ severity: 'warning', count: 1, samples: [expect.objectContaining({ id: ids.slowMain })] });
    // The change set with an operation at north is outside the main branch.
    expect(item(res, 'change_approvals')).toMatchObject({ count: 1, samples: [expect.objectContaining({ id: ids.csOrg })] });
    // Organization-wide records stay visible.
    expect(item(res, 'integrations_failing').count).toBe(1);
    const n = await get(tenant.owner, `?branchId=${north}`);
    expect(item(n, 'slow_orders')).toMatchObject({ count: 1, samples: [expect.objectContaining({ id: ids.slowNorth })] });
    expect(kinds(n)).not.toContain('negative_reviews');
    expect(kinds(n)).not.toContain('low_stock');
  });

  it('omits what a role may not see, and reads nothing for it', async () => {
    const waiter = await addMember(t, tenant, 'waiter');
    const c = await get(waiter);
    expect(c.status).toBe(200);
    expect(c.body.checked).toEqual(['slow_orders']);
    expect(kinds(c)).toEqual(['slow_orders']);
    expect(c.body.omitted).toContainEqual({ kind: 'unpaid_bills', reason: 'permission', permission: 'payments:read' });
    expect(c.body.omitted).toContainEqual({ kind: 'integrations_failing', reason: 'permission', permission: 'integrations:manage' });
    expect(c.body.omitted).toHaveLength(ATTENTION_KINDS.length - 1);
    const kitchen = await addMember(t, tenant, 'kitchen');
    const k = await get(kitchen);
    expect(k.body.checked).toEqual(['slow_orders', 'low_stock']);
    expect(JSON.stringify(k.body)).not.toContain('Cold fries');
    const manager = await addMember(t, tenant, 'manager');
    const m = await get(manager);
    expect(m.body.omitted.map((o: any) => o.kind)).toEqual(['integrations_failing', 'tokens_expiring']);
    expect(kinds(m)).not.toContain('integrations_failing');
    // A role that may see none of them gets an empty answer, not someone else's data.
    const driver = await addMember(t, tenant, 'driver');
    const d = await get(driver);
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({ items: [], checked: [] });
    expect(d.body.omitted).toHaveLength(ATTENTION_KINDS.length);
  });

  it('a branch-scoped member sees only their branch and cannot ask for another one', async () => {
    const mainManager = await addMember(t, tenant, 'manager', [tenant.branchId]);
    const res = await get(mainManager);
    expect(res.status).toBe(200);
    expect(item(res, 'slow_orders')).toMatchObject({ count: 1, samples: [expect.objectContaining({ id: ids.slowMain })] });
    expect(item(res, 'change_approvals')).toMatchObject({ count: 1 });
    expect(JSON.stringify(res.body)).not.toContain(ids.slowNorth);
    expect((await get(mainManager, `?branchId=${north}`)).status).toBe(403);
  });

  it('omits module-gated kinds outside the plan', async () => {
    const free = await createTenant(t, { country: 'EG', planId: 'free' });
    const res = await t.http.get(`/v1/o/${free.orgId}/attention`).set(auth(free.owner));
    expect(res.status).toBe(200);
    expect(res.body.omitted).toEqual(expect.arrayContaining([
      { kind: 'creative_approvals', reason: 'module', module: 'studio' }, { kind: 'campaign_approvals', reason: 'module', module: 'marketing' }]));
    expect(res.body.checked).not.toContain('creative_approvals');
  });

  it('is tenant-isolated and validated', async () => {
    const other = await createTenant(t, { country: 'EG' });
    const res = await get(other.owner);
    expect([403, 404]).toContain(res.status);
    expect(JSON.stringify(res.body)).not.toContain('Limes');
    const own = await t.http.get(`/v1/o/${other.orgId}/attention`).set(auth(other.owner));
    expect(own.status).toBe(200);
    expect(own.body.items).toEqual([]);
    expect((await get(tenant.owner, `?branchId=${other.branchId}`)).status).toBe(404);
    expect((await get(tenant.owner, '?branchId=not-a-uuid')).status).toBe(400);
    expect((await t.http.get(url)).status).toBe(401);
  });
});

describe('overview preferences', () => {
  let tenant: TestTenant;
  let manager: TestUser;
  let url: string;
  const layout = [
    { id: 'attention', visible: true }, { id: 'now', visible: true }, { id: 'performance', visible: true },
    { id: 'customers', visible: false }, { id: 'actions', visible: true },
  ];

  beforeAll(async () => {
    tenant = await createTenant(t, { country: 'EG' });
    manager = await addMember(t, tenant, 'manager');
    url = `/v1/o/${tenant.orgId}/preferences/overview`;
  });

  it('returns the default layout until something is saved', async () => {
    const res = await t.http.get(url).set(auth(tenant.owner));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ scope: 'overview', isDefault: true, updatedAt: null, value: { sections: OVERVIEW_SECTIONS.map((id) => ({ id, visible: true })) } });
  });

  it('saves and returns the caller\'s own order and visibility', async () => {
    const put = await t.http.put(url).set(auth(tenant.owner)).send({ sections: layout });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ scope: 'overview', isDefault: false, value: { sections: layout } });
    const get = await t.http.get(url).set(auth(tenant.owner));
    expect(get.body).toMatchObject({ isDefault: false, value: { sections: layout } });
    expect(typeof get.body.updatedAt).toBe('string');
    // Saving again replaces the layout (one row per user, restaurant and scope).
    await t.http.put(url).set(auth(tenant.owner)).send({ sections: [{ id: 'now', visible: false }] });
    const again = await t.http.get(url).set(auth(tenant.owner));
    expect(again.body.value.sections[0]).toEqual({ id: 'now', visible: false });
    // Sections the client did not send are kept, visible, after the ones it sent.
    expect(again.body.value.sections.map((s: any) => s.id)).toEqual(['now', 'performance', 'attention', 'customers', 'actions']);
    expect((await sql(`select count(*)::int as n from user_preferences where org_id = $1 and user_id = $2`, [tenant.orgId, tenant.owner.userId]))[0].n).toBe(1);
  });

  it('is per user: a colleague neither sees nor changes it', async () => {
    await t.http.put(url).set(auth(tenant.owner)).send({ sections: layout });
    expect((await t.http.get(url).set(auth(manager))).body.isDefault).toBe(true);
    await t.http.put(url).set(auth(manager)).send({ sections: [{ id: 'actions', visible: true }] });
    expect((await t.http.get(url).set(auth(tenant.owner))).body.value.sections).toEqual(layout);
    expect((await t.http.get(url).set(auth(manager))).body.value.sections[0].id).toBe('actions');
  });

  it('is per restaurant and refuses other restaurants', async () => {
    const other = await createTenant(t, { country: 'EG' });
    const mine = await t.http.get(`/v1/o/${other.orgId}/preferences/overview`).set(auth(other.owner));
    expect(mine.body.isDefault).toBe(true);
    const foreignGet = await t.http.get(url).set(auth(other.owner));
    expect([403, 404]).toContain(foreignGet.status);
    const foreignPut = await t.http.put(url).set(auth(other.owner)).send({ sections: layout });
    expect([403, 404]).toContain(foreignPut.status);
    expect((await t.http.get(url)).status).toBe(401);
    expect((await sql(`select count(*)::int as n from user_preferences where org_id = $1 and user_id = $2`, [tenant.orgId, other.owner.userId]))[0].n).toBe(0);
  });

  it('validates the layout', async () => {
    const bad = [
      { sections: [] },
      { sections: [{ id: 'now', visible: true }, { id: 'now', visible: false }] },
      { sections: [{ id: 'floor', visible: true }] },
      { sections: [{ id: 'now', visible: 'yes' }] },
      { sections: [{ id: 'now', visible: true, extra: 1 }] },
      { sections: layout, theme: 'dark' },
      {},
    ];
    for (const body of bad) expect((await t.http.put(url).set(auth(tenant.owner)).send(body)).status, JSON.stringify(body)).toBe(400);
  });

  it('limits saves per member per minute', async () => {
    const member = await addMember(t, tenant, 'cashier');
    const limiter = t.app.get(RateLimiter);
    for (let i = 0; i < PREFERENCES_PER_MINUTE; i++) limiter.hit(`prefs:${tenant.orgId}:${member.userId}`, PREFERENCES_PER_MINUTE);
    const res = await t.http.put(url).set(auth(member)).send({ sections: layout });
    expect(res.status).toBe(429);
    expect((await t.http.get(url).set(auth(member))).status).toBe(200);
  });
});
