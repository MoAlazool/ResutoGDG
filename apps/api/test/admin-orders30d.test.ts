// PCL-28 remainder (REM-A05): the platform tenant list computed orders30d with a correlated count over every order of
// the last 30 days per tenant row. It now reads whole fresh days from the analytics order rollups and counts only the
// remaining (branch, local day) slices live. The number must stay exactly the raw count in every rollup state, and the
// plan must read far fewer order rows than the raw count once rollups exist.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbService } from '../src/common/db/db.service';
import { ORDERS_30D } from '../src/modules/admin/admin.service';
import { AnalyticsRollupJobs } from '../src/modules/analytics/analytics-rollups.jobs';
import { OrdersKernelService } from '../src/modules/kernel/orders-kernel.service';
import { auth, bootTestApp, createTenant, seedMenu, signup, sql, testDb, type SeededMenu, type TestApp, type TestTenant, type TestUser } from './helpers';
import { addBranch, ownerCtx, placeOrder } from './insights-fixtures';

let t: TestApp;
let tenant: TestTenant;
let menu: SeededMenu;
let riyadh: string;
let support: TestUser;
const ids: string[] = [];

const raw = async () => (await sql(`select count(*)::int as n from orders where org_id = $1 and placed_at > now() - interval '30 days'`, [tenant.orgId]))[0].n;
const listed = async () => {
  const res = await t.http.get(`/v1/admin/tenants?q=${encodeURIComponent(tenant.slug)}`).set(auth(support));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const row = res.body.items.find((r: any) => r.id === tenant.orgId);
  const detail = await t.http.get(`/v1/admin/tenants/${tenant.orgId}`).set(auth(support));
  expect(detail.body.counts?.orders30d ?? detail.body.tenant?.counts?.orders30d).toBe(row.counts.orders30d);
  return row.counts.orders30d as number;
};
const staleOldDays = async () => (await sql(
  `select count(*)::int as n from analytics_days d join branches b on b.id = d.branch_id join organizations o on o.id = d.org_id
    where d.org_id = $1 and d.stale and d.local_date < (now() at time zone coalesce(b.timezone, o.timezone))::date - 3`, [tenant.orgId]))[0].n;

/**
 * How the orders30d expression touches `orders` (EXPLAIN ANALYZE): the number of (branch, day) slices it scans and the
 * order rows those slices return. Sequential scans are priced out because the test database is tiny (the planner would
 * otherwise read the whole table whatever the query shape).
 */
async function ordersAccess(): Promise<{ slices: number; rows: number }> {
  const client = await testDb().connect();
  let plan: any;
  try {
    await client.query('begin');
    await client.query('set local enable_seqscan = off');
    [plan] = (await client.query(`explain (analyze, format json) select ${ORDERS_30D} as n from organizations o where o.id = $1`, [tenant.orgId])).rows;
    await client.query('rollback');
  } finally { client.release(); }
  let slices = 0, rows = 0;
  const walk = (node: any) => {
    if (node['Relation Name'] === 'orders') { slices += node['Actual Loops']; rows += node['Actual Rows'] * node['Actual Loops']; }
    for (const c of node.Plans ?? []) walk(c);
  };
  walk(plan['QUERY PLAN'][0].Plan);
  return { slices, rows };
}
/** (branch, local day) slices of the 30-day window, and those served by a fresh rollup. */
const windowDays = async () => (await sql(
  `select count(*)::int as days,
          count(*) filter (where a.stale = false and g.d::date < (now() at time zone tz)::date - 3
                             and (g.d::date::timestamp at time zone tz) > now() - interval '30 days')::int as covered
     from (select b.id, coalesce(b.timezone, o.timezone) as tz from branches b join organizations o on o.id = b.org_id where b.org_id = $1) b
     cross join lateral generate_series(((now() - interval '30 days') at time zone tz)::date, (now() at time zone tz)::date, interval '1 day') g(d)
     left join analytics_days a on a.branch_id = b.id and a.local_date = g.d::date`, [tenant.orgId]))[0];

beforeAll(async () => {
  t = await bootTestApp();
  tenant = await createTenant(t, { country: 'EG' });
  menu = await seedMenu(tenant);
  riyadh = await addBranch(t, tenant, 'Riyadh');
  await sql(`update branches set timezone = 'Asia/Riyadh' where id = $1`, [riyadh]);
  support = await signup(t, 'orders30d-support');
  await sql(`insert into platform_admins(user_id, role) values ($1, 'support')`, [support.userId]);
  // 48 orders over the last 40 days in two branches/timezones, including the window boundary and a cancelled order.
  for (let i = 0; i < 48; i++) {
    const o = await placeOrder(t, tenant, { branchId: i % 3 === 0 ? riyadh : tenant.branchId, channel: 'staff', fulfillment: 'pickup',
      lines: [{ productId: menu.products.fries, quantity: 1 }] });
    ids.push(o.id);
    await sql(`update orders set placed_at = now() - make_interval(days => $2, hours => $3) where id = $1`, [o.id, Math.floor(i * 0.85), (i * 5) % 24]);
  }
  // Exactly around the 30-day boundary: one just inside, one just outside.
  await sql(`update orders set placed_at = now() - interval '30 days' + interval '2 minutes' where id = $1`, [ids[1]]);
  await sql(`update orders set placed_at = now() - interval '30 days' - interval '2 minutes' where id = $1`, [ids[2]]);
  const ctx = ownerCtx(tenant);
  await t.app.get(DbService).scoped(ctx, (tx) => t.app.get(OrdersKernelService).transition(tx, ctx, ids[20], 'cancelled', { reason: 'test' }));
}, 120_000);
afterAll(async () => { await t.close(); });

describe('admin tenant list orders30d', () => {
  it('equals the raw count before any rollup exists', async () => {
    expect(await raw()).toBeGreaterThan(30);
    expect(await listed()).toBe(await raw());
  });

  it('equals the raw count once the rollups caught up, and reads only the live slices of orders', async () => {
    await t.app.get(AnalyticsRollupJobs).refresh(0);
    for (let i = 0; i < 20 && (await staleOldDays()) > 0; i++) await t.app.get(AnalyticsRollupJobs).refresh();
    expect(await staleOldDays()).toBe(0);
    const total = await raw();
    expect(await listed()).toBe(total);
    // Only the (branch, day) slices without a fresh rollup are read from orders: the partial first day, the live
    // window and nothing else; every other day of the month comes from the rollups.
    const { days, covered } = await windowDays();
    expect(covered).toBeGreaterThan(10);   // days with orders older than the live window (empty days have no rollup row: an empty index range)
    const access = await ordersAccess();
    expect(access.slices).toBe(days - covered);
    expect(access.rows).toBeLessThan(total);
  });

  it('stays exact when an old day turns stale (read live) and after the job catches up again', async () => {
    const old = (await sql(`select id from orders where org_id = $1 and placed_at between now() - interval '20 days' and now() - interval '10 days' limit 1`, [tenant.orgId]))[0].id;
    const ctx = ownerCtx(tenant);
    await t.app.get(DbService).scoped(ctx, (tx) => t.app.get(OrdersKernelService).transition(tx, ctx, old, 'cancelled', { reason: 'late void' }).catch(() => undefined));
    const extra = await placeOrder(t, tenant, { channel: 'staff', fulfillment: 'pickup', lines: [{ productId: menu.products.soda, quantity: 1 }] });
    await sql(`update orders set placed_at = now() - interval '15 days' where id = $1`, [extra.id]);
    expect(await listed()).toBe(await raw());
    for (let i = 0; i < 20 && (await staleOldDays()) > 0; i++) await t.app.get(AnalyticsRollupJobs).refresh();
    expect(await listed()).toBe(await raw());
  });
});
