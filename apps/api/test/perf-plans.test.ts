// Plan regression checks for the hot read queries (PCL-09, PCL-16): with thousands of closed orders and a handful
// of open ones, the polled open-order reads must be able to touch only the open orders, and an order's payments must
// be found through indexes. The check is behavioural (rows the plan actually scanned) and runs in the API's member RLS
// context with sequential and bitmap scans disabled: on a test-sized table a seq scan is legitimately cheaper, so this proves the
// indexes are *usable* by the exact SQL (it fails if a query stops implying the partial-index predicate, e.g.
// `status::text = any(...)`, or an index goes missing). That the planner *chooses* them at production scale is checked
// on the seeded scale database by `node scripts/perf/explain.mjs --assert` (docs/PERFORMANCE.md).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OVERVIEW_LIVE_SQL } from '../src/modules/analytics/analytics.service';
import { KDS_MARKER_SQL, KDS_RECENT_SQL, KDS_TICKETS_SQL } from '../src/modules/kitchen/kitchen.service';
import { ORDER_LIST_SQL, ORDER_PAYMENTS_SQL } from '../src/modules/orders/orders.service';
import { bootTestApp, createTenant, seedMenu, sql, testDb, type TestApp, type TestTenant } from './helpers';

const CLOSED = 4000;
const OPEN = ['awaiting_payment', 'placed', 'accepted', 'preparing', 'ready'];

let t: TestApp;
let tenant: TestTenant;
let paidOrder: string;

interface Node { 'Node Type': string; 'Actual Rows': number; 'Actual Loops': number; 'Rows Removed by Filter'?: number; 'Index Name'?: string; Plans?: Node[] }
async function analyse(text: string, params: unknown[]) {
  const c = await testDb().connect();
  try {
    // Same context as the API: member RLS for the tenant owner (RLS adds org_id = current org to every read).
    await c.query('begin');
    await c.query(`select set_config('request.jwt.claims', $1, true), set_config('app.org_id', $2, true), set_config('jit', 'off', true)`,
      [JSON.stringify({ sub: tenant.owner.userId, role: 'authenticated' }), tenant.orgId]);
    await c.query('set local role resuto_member');
    // Plain index scans only: the question is whether an index can serve the exact SQL, independent of how the
    // planner costs a bitmap combination on a small, shared test table (that varies with the other test files' data).
    await c.query('set local enable_seqscan = off');
    await c.query('set local enable_bitmapscan = off');
    const { rows } = await c.query(`explain (analyze, format json) ${text}`, params as any[]);
    await c.query('rollback');
    let scanned = 0;
    const indexes = new Set<string>();
    const seqScans: string[] = [];
    const walk = (n: Node) => {
      // Rows read from the tables under test. Small lookup tables (dining_tables, through a materialised nested loop)
      // are read whole under RLS when the planner likes it; that is not what these checks are about.
      if (/Scan/.test(n['Node Type']) && ['orders', 'order_lines', 'payments', 'payment_allocations'].includes((n as any)['Relation Name'])) {
        scanned += (n['Actual Rows'] + (n['Rows Removed by Filter'] ?? 0)) * n['Actual Loops'];
      }
      if (n['Index Name']) indexes.add(n['Index Name']);
      if (n['Node Type'] === 'Seq Scan') seqScans.push((n as any)['Relation Name']);
      n.Plans?.forEach(walk);
    };
    walk(rows[0]['QUERY PLAN'][0].Plan);
    if (process.env.PERF_PLANS_DEBUG) console.log(JSON.stringify(rows[0]['QUERY PLAN'][0].Plan, (k, v) => (['Output', 'Shared Hit Blocks'].includes(k) ? undefined : v)));
    return { scanned, indexes, seqScans };
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  t = await bootTestApp();
  tenant = await createTenant(t, { country: 'EG' });
  await seedMenu(tenant);
  // A long closed history (one order every 10 minutes over about four weeks, each last touched when it closed) and
  // three open orders, inserted directly (fixtures only; the API is the order writer).
  await sql(
    `insert into orders (org_id, branch_id, number, channel, fulfillment, status, payment_status, currency, subtotal_minor, total_minor, paid_minor,
                         placed_at, updated_at)
     select $1, $2, 'H' || g, 'staff', 'pickup', case when g % 30 = 0 then 'cancelled' else 'picked_up' end::order_status,
            case when g % 30 = 0 then 'unpaid' else 'paid' end::payment_status, 'EGP', 5000, 5000, case when g % 30 = 0 then 0 else 5000 end,
            now() - g * interval '10 minutes', now() - g * interval '10 minutes' + interval '30 minutes'
       from generate_series(1, ${CLOSED}) g`, [tenant.orgId, tenant.branchId]);
  await sql(
    `insert into orders (org_id, branch_id, number, channel, fulfillment, status, currency, subtotal_minor, total_minor, placed_at)
     select $1, $2, 'OPEN' || g, 'web', 'pickup', s::order_status, 'EGP', 5000, 5000, now() - g * interval '1 minute'
       from unnest(array['placed', 'preparing', 'ready']) with ordinality as x(s, g)`, [tenant.orgId, tenant.branchId]);
  // Payments: one per paid order, allocated, like the ledger writes them.
  await sql(
    `with p as (
       insert into payments (org_id, branch_id, order_id, method, provider, status, amount_minor, currency)
       select org_id, branch_id, id, 'cash', 'manual', 'succeeded', total_minor, currency from orders
        where org_id = $1 and payment_status = 'paid' returning id, org_id, order_id, amount_minor)
     insert into payment_allocations (org_id, payment_id, order_id, amount_minor) select org_id, id, order_id, amount_minor from p`, [tenant.orgId]);
  paidOrder = (await sql(`select id from orders where org_id = $1 and payment_status = 'paid' order by placed_at desc limit 1`, [tenant.orgId]))[0].id;
  await sql('analyze orders; analyze payments; analyze payment_allocations; analyze order_lines');
}, 120_000);
afterAll(async () => { await t.close(); });

describe('open-order reads stay proportional to open orders (PCL-09)', () => {
  const listParams = (branch: string | null) => [tenant.orgId, branch, null, OPEN, null, null, null, null, null, null, null, null, null, 51];

  it('Orders page, one branch and all branches', async () => {
    for (const branch of [tenant.branchId, null]) {
      const plan = await analyse(ORDER_LIST_SQL, listParams(branch));
      expect(plan.seqScans).not.toContain('orders');
      expect(plan.scanned).toBeLessThan(50);
      expect([...plan.indexes].some((i) => i === 'orders_open_branch_idx' || i === 'orders_open_org_idx')).toBe(true);
    }
  });

  it('KDS marker and tickets', async () => {
    // The marker reads the branch's orders touched in the last 2 days (recent activity, about 290 here) and the open
    // orders' lines; never the history. Bounded by recent activity whatever plan the planner picks.
    const [recent] = await sql(`select count(*)::int as n from orders where branch_id = $1 and updated_at > now() - interval '2 days'`, [tenant.branchId]);
    const marker = await analyse(KDS_MARKER_SQL, [tenant.branchId]);
    expect(marker.scanned).toBeLessThanOrEqual(2 * recent.n + 50);
    expect(marker.indexes.has('orders_org_branch_updated_idx')).toBe(true);
    expect(recent.n).toBeLessThan(CLOSED / 10);
    const tickets = await analyse(KDS_TICKETS_SQL, [tenant.branchId, null]);
    expect(tickets.scanned).toBeLessThan(50);
    expect(tickets.indexes.has('orders_open_branch_idx')).toBe(true);
    // The Completed lane (VS-10) reads recent activity only, never the closed history.
    const done = await analyse(KDS_RECENT_SQL, [tenant.branchId, null]);
    expect(done.seqScans).not.toContain('orders');
    expect(done.scanned).toBeLessThanOrEqual(2 * recent.n + 50);
  });

  it('overview live tiles', async () => {
    const live = await analyse(OVERVIEW_LIVE_SQL, [tenant.orgId, null]);
    expect(live.seqScans).not.toContain('orders');
    expect(live.scanned).toBeLessThan(50);
  });

  it('a text cast on the status would read the whole history (guards the guard)', async () => {
    const cast = await analyse(ORDER_LIST_SQL.replace('o.status = any($4::order_status[])', 'o.status::text = any($4::text[])').replace('$4::order_status[] is null', '$4::text[] is null'),
      listParams(tenant.branchId));
    expect(cast.scanned).toBeGreaterThan(CLOSED);
  });

  it('unknown status names return an empty list instead of an enum error', async () => {
    const res = await t.http.get(`/v1/o/${tenant.orgId}/orders?status=nonsense,placed`).set({ Authorization: `Bearer ${tenant.owner.token}` });
    expect(res.status).toBe(200);
    expect(res.body.items.map((o: any) => o.number)).toEqual(['OPEN1']);
    const none = await t.http.get(`/v1/o/${tenant.orgId}/orders?status=nonsense`).set({ Authorization: `Bearer ${tenant.owner.token}` });
    expect(none.body).toEqual({ items: [], nextCursor: null });
  });
});

describe('order detail payments use indexes (PCL-16)', () => {
  it('finds direct and allocated payments without scanning other payments', async () => {
    const plan = await analyse(ORDER_PAYMENTS_SQL, [paidOrder]);
    expect(plan.seqScans).not.toContain('payments');
    expect(plan.scanned).toBeLessThan(20);
    const rows = await sql(ORDER_PAYMENTS_SQL, [paidOrder]);
    expect(rows).toHaveLength(1);
    const detail = await t.http.get(`/v1/o/${tenant.orgId}/orders/${paidOrder}`).set({ Authorization: `Bearer ${tenant.owner.token}` });
    expect(detail.status).toBe(200);
    expect(detail.body.payments).toHaveLength(1);
    expect(detail.body.allocations).toHaveLength(1);
    expect(detail.body.payments[0]).toMatchObject({ method: 'cash', status: 'succeeded', amountMinor: 5000, isTest: false });
  });
});
