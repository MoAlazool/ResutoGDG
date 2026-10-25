// 21-CRM (plan §6.7, §8): the public funnel beacon and the funnel / retention reports.
// - POST /v1/public/funnel/beacon: text/plain (sendBeacon) or JSON; strict body; fail closed (400, nothing stored) on bad
//   input; unknown restaurants and unsampled page views are dropped silently (204); rate-limited per tab session and per
//   client address; stores no personal data (no IP, no user agent, no customer, only a hash of the tab id).
// - GET /v1/o/:orgId/analytics/funnel: every step labelled with its source and completeness; the numbers reconcile with
//   the raw rows of the fixtures (computed here independently from the tables).
// - GET /v1/o/:orgId/analytics/retention: cohorts and the repeat-purchase curve.
// - Negative authorization: another restaurant, a role without analytics:read, a branch outside the caller's scope.
import { FUNNEL_PAGE_VIEW_WEIGHT, funnelPageViewSampled } from '@resuto/contracts';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FunnelBeaconService } from '../src/modules/analytics/funnel-beacon';
import { addMember, auth, bootTestApp, createTenant, seedMenu, sql, type SeededMenu, type TestApp, type TestTenant, type TestUser } from './helpers';
import { addBranch, placeOrder } from './insights-fixtures';

let t: TestApp;
let tenant: TestTenant;
let other: TestTenant;
let menu: SeededMenu;
let north: string;
const BEACON = '/v1/public/funnel/beacon';

/** A random tab id inside (or outside) the page-view sample. */
function sid(sampled?: boolean): string {
  for (;;) {
    const s = randomBytes(12).toString('base64url');
    if (sampled === undefined || funnelPageViewSampled(s) === sampled) return s;
  }
}
const send = (body: unknown, type: 'text' | 'json' = 'text') => type === 'text'
  ? t.http.post(BEACON).set('Content-Type', 'text/plain;charset=UTF-8').send(typeof body === 'string' ? body : JSON.stringify(body))
  : t.http.post(BEACON).send(body as object);
const beaconRows = (orgId: string) => sql(`select * from attribution_events where org_id = $1 and kind in ('page_view', 'qr_scan', 'add_to_cart', 'checkout_started') order by id`, [orgId]);

beforeAll(async () => {
  t = await bootTestApp();
  tenant = await createTenant(t);
  other = await createTenant(t);
  menu = await seedMenu(tenant);
  north = await addBranch(t, tenant, 'North');
});
afterAll(async () => { await t.close(); });

describe('POST /v1/public/funnel/beacon', () => {
  it('stores a text/plain beacon (sendBeacon) with no personal data', async () => {
    const s = sid();
    const res = await send({ e: 'qr_scan', s: 't', o: tenant.slug, b: tenant.branchId, sid: s });
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    const rows = await beaconRows(tenant.orgId);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r).toMatchObject({ kind: 'qr_scan', surface: 't', branch_id: tenant.branchId, weight: 1, customer_id: null, order_id: null,
      campaign_id: null, link_id: null, utm: {}, value_minor: null });
    // Only a per-restaurant hash of the tab id; never the id itself.
    expect(r.session_key).toBe(FunnelBeaconService.sessionKey(tenant.orgId, s));
    expect(r.session_key).not.toContain(s);
    // The table has no column that could hold an address or a browser fingerprint.
    const cols = (await sql(`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'attribution_events'`)).map((c) => c.column_name);
    expect(cols.filter((c: string) => /ip|agent|ua$|referr|url|phone|email|name/.test(c))).toEqual([]);
    expect(JSON.stringify(r)).not.toMatch(/127\.0\.0\.1|::1|supertest|node-superagent/);
  });

  it('accepts a JSON body too (fetch keepalive fallback)', async () => {
    const s = sid();
    expect((await send({ e: 'add_to_cart', s: 'order', o: tenant.slug, sid: s }, 'json')).status).toBe(204);
    expect((await send({ e: 'checkout_started', s: 'order', o: tenant.slug, sid: s }, 'json')).status).toBe(204);
    const rows = (await beaconRows(tenant.orgId)).filter((r) => r.session_key === FunnelBeaconService.sessionKey(tenant.orgId, s));
    expect(rows.map((r) => [r.kind, r.surface, r.branch_id])).toEqual([['add_to_cart', 'order', null], ['checkout_started', 'order', null]]);
  });

  it('samples page views per tab session: 1 in 4 sessions, weighted by 4', async () => {
    const before = (await beaconRows(tenant.orgId)).length;
    const inSample = sid(true);
    const outOfSample = sid(false);
    expect((await send({ e: 'page_view', s: 'r', o: tenant.slug, sid: inSample })).status).toBe(204);
    expect((await send({ e: 'page_view', s: 'r', o: tenant.slug, sid: outOfSample })).status).toBe(204);
    const rows = (await beaconRows(tenant.orgId)).slice(before);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'page_view', surface: 'r', weight: FUNNEL_PAGE_VIEW_WEIGHT,
      session_key: FunnelBeaconService.sessionKey(tenant.orgId, inSample) });
    // The sample is deterministic per id and close to one in four.
    const ids = Array.from({ length: 4000 }, () => randomBytes(12).toString('base64url'));
    const share = ids.filter(funnelPageViewSampled).length / ids.length;
    expect(share).toBeGreaterThan(0.22);
    expect(share).toBeLessThan(0.28);
    expect(ids.slice(0, 50).map(funnelPageViewSampled)).toEqual(ids.slice(0, 50).map(funnelPageViewSampled));
    // Other events are never sampled.
    expect((await send({ e: 'qr_scan', s: 'v', o: tenant.slug, sid: outOfSample })).status).toBe(204);
    expect((await beaconRows(tenant.orgId)).slice(before)).toHaveLength(2);
  });

  it('fails closed on bad input: nothing is stored', async () => {
    const before = (await beaconRows(tenant.orgId)).length;
    const ok = { e: 'qr_scan', s: 't', o: tenant.slug, sid: sid() };
    const bad: unknown[] = [
      { ...ok, customerId: '00000000-0000-4000-8000-000000000000' }, // no customer ids from the client
      { ...ok, phone: '+201000000000' },
      { ...ok, url: 'https://example.test/?email=a@b.c' },
      { ...ok, e: 'order_placed' },
      { ...ok, e: 'link_click' },
      { ...ok, s: 'r' }, // a QR scan only comes from a QR page
      { ...ok, e: 'add_to_cart', s: 'r' }, // no cart on the restaurant site
      { ...ok, s: 'admin' },
      { ...ok, o: 'Not A Slug!' },
      { ...ok, o: "x'; drop table attribution_events; --" },
      { ...ok, b: 'not-a-uuid' },
      { ...ok, sid: 'short' },
      { ...ok, sid: 'x'.repeat(33) },
      { ...ok, sid: '<script>alert(1)</script>' },
      { e: 'qr_scan', s: 't', o: tenant.slug },
      [],
      'not json',
      '',
      `{"e":"qr_scan","s":"t","o":"${tenant.slug}","sid":"${'a'.repeat(20)}","pad":"${'x'.repeat(600)}"}`, // over 512 bytes
    ];
    for (const body of bad) {
      const res = await send(body);
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(res.body.error.code).toBe('validation_failed');
    }
    expect((await t.http.post(BEACON).set('Content-Type', 'application/json').send('{"e":')).status).toBe(400);
    expect(await beaconRows(tenant.orgId)).toHaveLength(before);
  });

  it('drops beacons for unknown or closed restaurants and branches of another restaurant, without telling the client', async () => {
    const res = await send({ e: 'qr_scan', s: 't', o: 'no-such-restaurant-anywhere', sid: sid() });
    expect(res.status).toBe(204);
    expect((await sql(`select count(*)::int as n from attribution_events e left join organizations o on o.id = e.org_id where o.id is null`))[0].n).toBe(0);
    // Another restaurant's branch id is not attached to this restaurant's row.
    const s = sid();
    expect((await send({ e: 'qr_scan', s: 'v', o: tenant.slug, b: other.branchId, sid: s })).status).toBe(204);
    const [row] = (await beaconRows(tenant.orgId)).filter((r) => r.session_key === FunnelBeaconService.sessionKey(tenant.orgId, s));
    expect(row.branch_id).toBeNull();
    expect(await beaconRows(other.orgId)).toHaveLength(0);
  });

  it('rate-limits each tab session (30 a minute)', async () => {
    const s = sid();
    const statuses: number[] = [];
    for (let i = 0; i < 34; i++) statuses.push((await send({ e: 'add_to_cart', s: 't', o: tenant.slug, sid: s })).status);
    expect(statuses.slice(0, 30).every((x) => x === 204)).toBe(true);
    expect(statuses.slice(30)).toEqual([429, 429, 429, 429]);
    const stored = (await beaconRows(tenant.orgId)).filter((r) => r.session_key === FunnelBeaconService.sessionKey(tenant.orgId, s));
    expect(stored).toHaveLength(30);
    const refused = await send({ e: 'add_to_cart', s: 't', o: tenant.slug, sid: s });
    expect(refused.body.error.code).toBe('rate_limited');
    expect(refused.headers['retry-after']).toBeDefined();
    // Another tab session is not affected.
    expect((await send({ e: 'add_to_cart', s: 't', o: tenant.slug, sid: sid() })).status).toBe(204);
  });
});

describe('funnel and retention reports', () => {
  let tz: string;
  let manager: TestUser;
  const period = { from: '2026-08-01', to: '2026-08-31' };
  const localDay = (at: Date | string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
  const inPeriod = (at: Date | string) => localDay(at) >= period.from && localDay(at) <= period.to;
  const get = (u: TestUser, path: 'funnel' | 'retention', q: Record<string, string> = {}) =>
    t.http.get(`/v1/o/${tenant.orgId}/analytics/${path}?${new URLSearchParams({ ...period, ...q })}`).set(auth(u));

  beforeAll(async () => {
    tz = (await sql(`select timezone from organizations where id = $1`, [tenant.orgId]))[0].timezone;
    manager = await addMember(t, tenant, 'manager', [tenant.branchId]);
    // Raw beacon rows across the period edges (local midnight in the restaurant's timezone), branches and kinds.
    const ev = (kind: string, key: string, at: string, branch: string | null, weight = 1, org = tenant.orgId) =>
      sql(`insert into attribution_events(org_id, kind, session_key, occurred_at, branch_id, surface, weight, utm) values ($1, $2, $3, $4, $5, 't', $6, '{}')`,
        [org, kind, key, at, branch, weight]);
    await ev('page_view', 'pv-a', '2026-08-02T10:00:00Z', null, 4);
    await ev('page_view', 'pv-a', '2026-08-03T10:00:00Z', null, 4); // same session twice: one visit
    await ev('page_view', 'pv-b', '2026-08-10T10:00:00Z', tenant.branchId, 4);
    await ev('page_view', 'pv-c', '2026-08-31T20:30:00Z', north, 4); // 23:30 local on the 31st: inside
    await ev('page_view', 'pv-d', '2026-07-31T21:30:00Z', null, 4); // 00:30 local on 1 August: inside
    await ev('page_view', 'pv-e', '2026-07-31T20:30:00Z', null, 4); // 23:30 local on 31 July: outside
    await ev('page_view', 'pv-f', '2026-09-01T10:00:00Z', null, 4); // outside
    await ev('qr_scan', 'qr-a', '2026-08-05T10:00:00Z', tenant.branchId);
    await ev('qr_scan', 'qr-a', '2026-08-05T10:05:00Z', tenant.branchId);
    await ev('qr_scan', 'qr-b', '2026-08-06T10:00:00Z', north);
    await ev('qr_scan', 'qr-c', '2026-08-07T10:00:00Z', tenant.branchId);
    await ev('add_to_cart', 'qr-a', '2026-08-05T10:06:00Z', tenant.branchId);
    await ev('checkout_started', 'qr-a', '2026-08-05T10:09:00Z', tenant.branchId);
    await ev('qr_scan', 'qr-x', '2026-08-05T10:00:00Z', other.branchId, 1, other.orgId); // another restaurant
    // Conversations with inbound messages: a live channel per branch and a sandbox one (excluded).
    const channel = async (transport: string, branch: string | null) => (await sql(
      `insert into messaging_channels(org_id, branch_id, kind, transport, display_name) values ($1, $2, 'whatsapp', $3, 'WA') returning id`,
      [tenant.orgId, branch, transport]))[0].id;
    const live = await channel('meta_cloud', tenant.branchId);
    const liveNorth = await channel('meta_cloud', north);
    const sandbox = await channel('sandbox', tenant.branchId);
    const conv = async (ch: string, contact: string, msgs: Array<[string, 'inbound' | 'outbound']>) => {
      const [c] = await sql(`insert into conversations(org_id, branch_id, channel_id, external_contact, status) select org_id, branch_id, id, $2, 'open' from messaging_channels where id = $1 returning id`, [ch, contact]);
      for (const [at, dir] of msgs) {
        await sql(`insert into messages(org_id, conversation_id, direction, kind, body, created_at) values ($1, $2, $3, 'text', 'hi', $4)`, [tenant.orgId, c.id, dir, at]);
      }
    };
    await conv(live, '201000000001', [['2026-08-03T10:00:00Z', 'inbound'], ['2026-08-03T10:01:00Z', 'outbound'], ['2026-08-04T10:00:00Z', 'inbound']]);
    await conv(live, '201000000002', [['2026-08-03T10:00:00Z', 'outbound']]); // no inbound message
    await conv(liveNorth, '201000000003', [['2026-08-20T10:00:00Z', 'inbound']]);
    await conv(live, '201000000004', [['2026-07-20T10:00:00Z', 'inbound']]); // before the period
    await conv(sandbox, '201000000005', [['2026-08-03T10:00:00Z', 'inbound']]);
    // Orders: a repeat customer, a customer whose first order was before the period, a one-time customer, an anonymous
    // order, a cancelled one, one at the north branch.
    const fries = [{ productId: menu.products.fries, quantity: 1 }];
    const order = async (at: string, extra: Record<string, unknown> = {}) => {
      const o = await placeOrder(t, tenant, { channel: 'web', fulfillment: 'pickup', lines: fries, ...extra } as never);
      await sql(`update orders set placed_at = $2 where id = $1`, [o.id, at]);
      return o;
    };
    const repeatA = { name: 'Repeat', phone: '+201007770001' };
    const before = { name: 'Before', phone: '+201007770002' };
    await order('2026-08-04T10:00:00Z', { customer: repeatA });
    await order('2026-08-20T10:00:00Z', { customer: repeatA });
    await order('2026-07-10T10:00:00Z', { customer: before });
    await order('2026-08-15T10:00:00Z', { customer: before });
    await order('2026-08-16T10:00:00Z', { customer: { name: 'Once', phone: '+201007770003' } });
    await order('2026-08-17T10:00:00Z', { channel: 'qr', fulfillment: 'dine_in', tableId: menu.tableId });
    const cancelled = await order('2026-08-18T10:00:00Z', { customer: { name: 'Cancelled', phone: '+201007770004' } });
    await sql(`update orders set status = 'cancelled' where id = $1`, [cancelled.id]);
    await order('2026-08-19T10:00:00Z', { branchId: north, customer: { name: 'North', phone: '+201007770005' } });
    // Customers created in the period (and the leads count reads created_at): back-date the ones above to their first order.
    await sql(`update customers c set created_at = (select min(o.placed_at) from orders o where o.customer_id = c.id) where org_id = $1`, [tenant.orgId]);
    await sql(`insert into customers(org_id, display_name, created_at) values ($1, 'Lead only', '2026-08-25T10:00:00Z'), ($1, 'Old lead', '2026-06-25T10:00:00Z')`, [tenant.orgId]);
  });

  /** The expected funnel, computed from the raw tables (independently of the service's SQL). */
  async function expected(scope: string[] | null) {
    const inScope = (branch: string | null) => scope === null || (branch !== null && scope.includes(branch));
    const events = (await sql(`select kind, session_key, occurred_at, branch_id, weight from attribution_events where org_id = $1
      and kind in ('page_view', 'qr_scan', 'add_to_cart', 'checkout_started')`, [tenant.orgId])).filter((e) => inPeriod(e.occurred_at) && inScope(e.branch_id));
    const sessions = (kind: string) => new Map(events.filter((e) => e.kind === kind).map((e) => [e.session_key, e.weight]));
    const pv = sessions('page_view');
    const msgs = (await sql(`select m.conversation_id, m.created_at, c.branch_id, ch.transport from messages m join conversations c on c.id = m.conversation_id
      join messaging_channels ch on ch.id = c.channel_id where m.org_id = $1 and m.direction = 'inbound'`, [tenant.orgId]))
      .filter((m) => inPeriod(m.created_at) && inScope(m.branch_id) && m.transport !== 'sandbox');
    const orders = (await sql(`select o.id, o.customer_id, o.placed_at, o.status, o.branch_id from orders o where o.org_id = $1 order by o.placed_at, o.id`, [tenant.orgId]))
      .filter((o) => inScope(o.branch_id));
    const counted = orders.filter((o) => !['cancelled', 'awaiting_payment'].includes(o.status));
    const inPeriodCounted = counted.filter((o) => inPeriod(o.placed_at));
    const rank = new Map<string, number>();
    const seen = new Map<string, number>();
    for (const o of counted) if (o.customer_id) { seen.set(o.customer_id, (seen.get(o.customer_id) ?? 0) + 1); rank.set(o.id, seen.get(o.customer_id)!); }
    const customers = (await sql(`select id, created_at from customers where org_id = $1 and merged_into_id is null`, [tenant.orgId]))
      .filter((c) => inPeriod(c.created_at) && (scope === null || orders.some((o) => o.customer_id === c.id)));
    return {
      visits: [...pv.values()].reduce((a, w) => a + w, 0), sampledSessions: pv.size,
      qr_scans: sessions('qr_scan').size, messages: new Set(msgs.map((m) => m.conversation_id)).size, leads: customers.length,
      orders: inPeriodCounted.length, repeat: new Set(inPeriodCounted.filter((o) => (rank.get(o.id) ?? 0) >= 2).map((o) => o.customer_id)).size,
      add_to_cart: sessions('add_to_cart').size, checkout_started: sessions('checkout_started').size,
    };
  }

  it('reconciles every step with the raw rows, labelled with source and completeness', async () => {
    const res = await get(tenant.owner, 'funnel');
    expect(res.status).toBe(200);
    const by = Object.fromEntries([...res.body.steps, ...res.body.cart].map((s: any) => [s.key, s]));
    expect(res.body.steps.map((s: any) => s.key)).toEqual(['visits', 'qr_scans', 'messages', 'leads', 'orders', 'repeat']);
    const exp = await expected(null);
    for (const k of ['visits', 'qr_scans', 'messages', 'leads', 'orders', 'repeat', 'add_to_cart', 'checkout_started'] as const) {
      expect(by[k].value, k).toBe(exp[k]);
    }
    // The fixture values, so a regression in both computations cannot pass silently.
    expect(exp).toMatchObject({ visits: 16, sampledSessions: 4, qr_scans: 3, messages: 2, leads: 5, orders: 6, repeat: 2, add_to_cart: 1, checkout_started: 1 });
    expect(by.visits).toMatchObject({ unit: 'sessions', completeness: 'estimate', measured: 4 });
    expect(by.visits.notes).toEqual(expect.arrayContaining(['sampled', 'needs_script', 'not_same_people']));
    expect(by.visits.source).toMatch(/page_view/);
    expect(by.qr_scans).toMatchObject({ completeness: 'partial', unit: 'sessions' });
    expect(by.messages).toMatchObject({ completeness: 'complete', unit: 'conversations' });
    expect(by.messages.notes).toContain('sandbox_excluded');
    expect(by.leads).toMatchObject({ completeness: 'complete', unit: 'customers' });
    expect(by.orders).toMatchObject({ completeness: 'complete', unit: 'orders' });
    expect(by.repeat).toMatchObject({ completeness: 'complete', unit: 'customers' });
    for (const s of [...res.body.steps, ...res.body.cart]) {
      expect(s.source.length, s.key).toBeGreaterThan(10);
      expect(['complete', 'partial', 'estimate', 'unavailable']).toContain(s.completeness);
    }
    expect(res.body.meta).toMatchObject({ kind: 'mixed', timezone: tz });
    expect(res.body.meta.dataCoverage).toMatchObject({ sampledPageViewSessions: 4, pageViewWeight: 4, ordersWithoutCustomer: 1 });
    expect(res.body.beaconsSince).not.toBeNull();
  });

  it('reconciles a branch filter and a branch-scoped manager with the raw rows of those branches', async () => {
    const n = await get(tenant.owner, 'funnel', { branchId: north });
    expect(n.status).toBe(200);
    const nb = Object.fromEntries(n.body.steps.map((s: any) => [s.key, s.value]));
    const en = await expected([north]);
    expect(nb).toEqual({ visits: en.visits, qr_scans: en.qr_scans, messages: en.messages, leads: en.leads, orders: en.orders, repeat: en.repeat });
    expect(en).toMatchObject({ visits: 4, qr_scans: 1, messages: 1, leads: 1, orders: 1 });
    expect(n.body.steps.find((s: any) => s.key === 'qr_scans').notes).toContain('branch_unknown_excluded');
    const m = await get(manager, 'funnel');
    expect(m.status).toBe(200);
    const mb = Object.fromEntries(m.body.steps.map((s: any) => [s.key, s.value]));
    const em = await expected([tenant.branchId]);
    expect(mb).toEqual({ visits: em.visits, qr_scans: em.qr_scans, messages: em.messages, leads: em.leads, orders: em.orders, repeat: em.repeat });
  });

  it('reconciles beacons sent through the endpoint today', async () => {
    const today = localDay(new Date());
    const res = await t.http.get(`/v1/o/${tenant.orgId}/analytics/funnel?from=${today}&to=${today}`).set(auth(tenant.owner));
    const rows = (await beaconRows(tenant.orgId)).filter((r) => localDay(r.occurred_at) === today);
    const sessions = (kind: string) => new Set(rows.filter((r) => r.kind === kind).map((r) => r.session_key)).size;
    const by = Object.fromEntries([...res.body.steps, ...res.body.cart].map((s: any) => [s.key, s.value]));
    expect(by.qr_scans).toBe(sessions('qr_scan'));
    expect(by.visits).toBe(sessions('page_view') * FUNNEL_PAGE_VIEW_WEIGHT);
    expect(by.add_to_cart).toBe(sessions('add_to_cart'));
    expect(by.checkout_started).toBe(sessions('checkout_started'));
    expect(by.qr_scans).toBeGreaterThan(0);
  });

  it('labels messages unavailable without the Connect module', async () => {
    const free = await createTenant(t, { planId: 'free' });
    const res = await t.http.get(`/v1/o/${free.orgId}/analytics/funnel?${new URLSearchParams(period)}`).set(auth(free.owner));
    expect(res.status).toBe(200);
    expect(res.body.steps.find((s: any) => s.key === 'messages')).toMatchObject({ value: null, completeness: 'unavailable', notes: expect.arrayContaining(['connect_not_entitled']) });
  });

  it('builds cohorts and a repeat-purchase curve from counted orders', async () => {
    const res = await get(tenant.owner, 'retention');
    expect(res.status).toBe(200);
    // New customers of August: Repeat (2nd order 16 days later), Once, North (first counted orders in August).
    expect(res.body.cohorts).toEqual([{ cohort: '2026-08', size: 3, active: [3], retentionPct: [100] }]);
    const curve = res.body.repeatCurve;
    expect(curve.newCustomers).toBe(3);
    expect(curve.points).toHaveLength(91);
    // Expected from the fixture's first days and gaps; a day counts only once it has passed for that customer.
    const today = localDay(new Date());
    expect(curve.asOf).toBe(today);
    const members = [{ first: '2026-08-04', gap: 16 }, { first: '2026-08-16', gap: null }, { first: '2026-08-19', gap: null }];
    const plus = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
    for (const p of curve.points) {
      const eligible = members.filter((m) => plus(m.first, p.day) <= today);
      const repeated = eligible.filter((m) => m.gap !== null && m.gap <= p.day);
      expect(p, `day ${p.day}`).toEqual({ day: p.day, eligible: eligible.length, repeated: repeated.length,
        pct: eligible.length ? Math.round((repeated.length / eligible.length) * 10000) / 100 : null });
    }
    expect(curve.points[16]).toMatchObject({ eligible: 3, repeated: 1, pct: 33.33 });
    expect(curve.points[15]).toMatchObject({ repeated: 0 });
    expect(res.body.meta.method).toMatch(/repeat-purchase curve/);
  });

  it('refuses another restaurant, roles without analytics:read and branches outside the caller\'s scope', async () => {
    for (const path of ['funnel', 'retention'] as const) {
      // Another restaurant's owner: not found (never confirms the restaurant exists), and their own restaurant's report has none of these rows.
      expect((await t.http.get(`/v1/o/${tenant.orgId}/analytics/${path}?${new URLSearchParams(period)}`).set(auth(other.owner))).status).toBe(404);
      const kitchen = await addMember(t, tenant, 'kitchen');
      expect((await get(kitchen, path)).status).toBe(403);
      const cashier = await addMember(t, tenant, 'cashier');
      expect((await get(cashier, path)).status).toBe(403);
      expect((await get(manager, path, { branchId: north })).status).toBe(403);
      expect((await t.http.get(`/v1/o/${tenant.orgId}/analytics/${path}?${new URLSearchParams(period)}`)).status).toBe(401);
      expect((await get(tenant.owner, path, { from: '2026-09-01', to: '2026-08-01' })).status).toBe(400);
    }
  });
});

describe('beacon address limit', () => {
  it('refuses a flood from one address, before the body is read, and stores nothing more', async () => {
    const before = (await beaconRows(tenant.orgId)).length;
    let first429 = -1;
    for (let i = 0; i < 700 && first429 < 0; i++) {
      const res = await send(i % 2 ? 'garbage' : { e: 'qr_scan', s: 't', o: tenant.slug, sid: sid() });
      if (res.status === 429) first429 = i;
    }
    expect(first429).toBeGreaterThan(0);
    expect(first429).toBeLessThanOrEqual(600);
    const stored = (await beaconRows(tenant.orgId)).length - before;
    const refused = await send({ e: 'qr_scan', s: 't', o: tenant.slug, sid: sid() });
    expect(refused.status).toBe(429);
    expect(refused.body.error.code).toBe('rate_limited');
    expect((await beaconRows(tenant.orgId)).length - before).toBe(stored);
  });
});
