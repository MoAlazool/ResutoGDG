// PCL-26: analytics daily rollups are an exact cache. Reports read rollups only for fresh days outside the live
// window and orders for the rest, so they must equal the raw computation in every state: before any rollup exists,
// after the refresh job, after an old order changes (the day turns stale and is read live), after the job catches
// up, and after a timezone change. A tampered rollup row is detected by the reconcile job.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbService } from '../src/common/db/db.service';
import { AnalyticsRollupJobs } from '../src/modules/analytics/analytics-rollups.jobs';
import { AnalyticsService } from '../src/modules/analytics/analytics.service';
import { OrdersKernelService } from '../src/modules/kernel/orders-kernel.service';
import { bootTestApp, createTenant, seedMenu, sql, type SeededMenu, type TestApp, type TestTenant } from './helpers';
import { addBranch, ownerCtx, placeOrder } from './insights-fixtures';

let t: TestApp;
let tenant: TestTenant;
let menu: SeededMenu;
let north: string;
const orderIds: string[] = [];

const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const period = { from: day(60), to: day(0) };

/** summary and products through the service, with and without rollups, minus generatedAt. */
async function reports(branchId?: string) {
  const ctx = ownerCtx(tenant);
  const svc = t.app.get(AnalyticsService);
  const db = t.app.get(DbService);
  const q = { ...period, branchId, compare: 'previous' as const };
  const strip = (r: any) => JSON.parse(JSON.stringify(r, (k, v) => (k === 'generatedAt' ? undefined : v)));
  const sortAll = (r: any) => ({ ...r, all: [...r.all].sort((a: any, b: any) => String(a.productId).localeCompare(String(b.productId))) });
  return db.scoped(ctx, async (tx) => ({
    rolled: { summary: strip(await svc.summary(tx, ctx, q)), products: sortAll(strip(await svc.products(tx, ctx, q))) },
    raw: { summary: strip(await svc.summary(tx, ctx, q, { rollups: false })), products: sortAll(strip(await svc.products(tx, ctx, q, { rollups: false }))) },
  }));
}
async function expectEqualPaths() {
  for (const branch of [undefined, tenant.branchId]) {
    const r = await reports(branch);
    expect(r.rolled).toEqual(r.raw);
  }
}
const freshDays = async () => (await sql(`select count(*)::int as n from analytics_days where org_id = $1 and not stale`, [tenant.orgId]))[0].n;

beforeAll(async () => {
  t = await bootTestApp();
  tenant = await createTenant(t, { country: 'EG' });
  menu = await seedMenu(tenant);
  north = await addBranch(t, tenant, 'North');
  // 40 orders spread over the last 50 days (two branches, mixed fulfilment, some with customers), then moved into the
  // past: placement goes through the kernel, only placed_at is rewritten.
  for (let i = 0; i < 40; i++) {
    const o = await placeOrder(t, tenant, {
      branchId: i % 3 === 0 ? north : tenant.branchId, channel: i % 2 ? 'web' : 'staff', fulfillment: 'pickup',
      lines: [{ productId: menu.products.fries, quantity: 1 + (i % 3) }, ...(i % 4 ? [{ productId: menu.products.soda, quantity: 1 }] : [])],
      customer: i % 5 ? { name: `Guest ${i}`, phone: `+2010066600${String(i).padStart(2, '0')}` } : null,
    });
    orderIds.push(o.id);
    await sql(`update orders set placed_at = now() - make_interval(days => $2, hours => $3) where id = $1`, [o.id, 1 + Math.floor(i * 1.25), i % 11]);
  }
  const ctx = ownerCtx(tenant);
  await t.app.get(DbService).scoped(ctx, (tx) => t.app.get(OrdersKernelService).transition(tx, ctx, orderIds[7], 'cancelled', { reason: 'test' }));
  await sql(`update orders set refunded_minor = 500 where id = $1`, [orderIds[12]]);
}, 120_000);
afterAll(async () => { await t.close(); });

describe('analytics rollups are exact', () => {
  it('before any refresh every day is read live', async () => {
    expect(await freshDays()).toBe(0);
    await expectEqualPaths();
  });

  it('after the refresh job, old days come from rollups and the reports are unchanged', async () => {
    const r = await t.app.get(AnalyticsRollupJobs).refresh();
    expect(r.refreshed).toBeGreaterThan(10);
    expect(await freshDays()).toBe(r.refreshed);
    // Only days older than the live window (local today − 3) are rolled up.
    const [{ newest }] = await sql(`select max(local_date)::text as newest from analytics_days where org_id = $1 and not stale`, [tenant.orgId]);
    expect(newest <= day(4)).toBe(true);
    await expectEqualPaths();
  });

  it('a change to an old order marks its day stale in the same transaction and the report stays exact', async () => {
    const old = orderIds[30];
    const [{ local_date: d }] = await sql(
      `select (o.placed_at at time zone coalesce(b.timezone, g.timezone))::date::text as local_date
         from orders o join branches b on b.id = o.branch_id join organizations g on g.id = o.org_id where o.id = $1`, [old]);
    await sql(`update orders set refunded_minor = 1500 where id = $1`, [old]);
    expect((await sql(`select stale from analytics_days where org_id = $1 and local_date = $2::date`, [tenant.orgId, d])).some((x: any) => x.stale)).toBe(true);
    await expectEqualPaths();
    await t.app.get(AnalyticsRollupJobs).refresh();
    expect((await sql(`select count(*)::int as n from analytics_days where org_id = $1 and stale and local_date < current_date - 4`, [tenant.orgId]))[0].n).toBe(0);
    await expectEqualPaths();
  });

  it('reports really read the rollups, and the reconcile job catches a tampered rollup', async () => {
    const [row] = await sql(
      `select r.branch_id, r.local_date::text as local_date from analytics_order_rollups r join analytics_days d using (branch_id, local_date)
        where r.org_id = $1 and not d.stale and r.orders > 0 order by r.local_date desc limit 1`, [tenant.orgId]);
    await sql(`update analytics_order_rollups set net = net + 1 where branch_id = $1 and local_date = $2::date`, [row.branch_id, row.local_date]);
    const tampered = await reports();
    expect(tampered.rolled.summary.totals.netMinor).not.toBe(tampered.raw.summary.totals.netMinor);
    const r = await t.app.get(AnalyticsRollupJobs).reconcile();
    expect(r.drift).toBeGreaterThanOrEqual(1);
    await t.app.get(AnalyticsRollupJobs).refresh();
    await expectEqualPaths();
  });

  it('a timezone change drops the branch rollups (local dates moved) and reports stay exact', async () => {
    await sql(`update branches set timezone = 'Asia/Riyadh' where id = $1`, [north]);
    expect((await sql(`select count(*)::int as n from analytics_days where branch_id = $1`, [north]))[0].n).toBe(0);
    await expectEqualPaths();
    await t.app.get(AnalyticsRollupJobs).reconcile();
    await t.app.get(AnalyticsRollupJobs).refresh();
    expect((await sql(`select count(*)::int as n from analytics_days where branch_id = $1 and not stale`, [north]))[0].n).toBeGreaterThan(0);
    await expectEqualPaths();
  });
});
