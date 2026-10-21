// PCL-17: customer totals come from trigger-maintained read models (customer_stats, customer_branch_stats) and the
// list pages with keyset cursors. These tests pin the read models to the orders they summarise through the order
// lifecycle (placement, cancellation, refunds, branch moves, merges), and check that keyset pages cover every customer
// exactly once in the list order.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbService } from '../src/common/db/db.service';
import { CustomerStatsJobs } from '../src/modules/customers/customer-stats.jobs';
import { OrdersKernelService } from '../src/modules/kernel/orders-kernel.service';
import { auth, bootTestApp, createTenant, seedMenu, sql, type SeededMenu, type TestApp, type TestTenant } from './helpers';
import { addBranch, ownerCtx, placeOrder } from './insights-fixtures';

let t: TestApp;
let tenant: TestTenant;
let menu: SeededMenu;
let north: string;
const fries = (quantity = 1) => [{ productId: menu.products.fries, quantity }];

/** Read models must equal a direct aggregation over orders, for every customer of the tenant. */
async function expectExact(orgId: string) {
  const [overall] = await sql(
    `with expected as (
       select c.id, count(o.id) filter (where o.status not in ('cancelled','awaiting_payment'))::int as order_count,
              coalesce(sum(o.total_minor - o.refunded_minor) filter (where o.status not in ('cancelled','awaiting_payment')), 0)::bigint as spend_minor,
              max(o.placed_at) filter (where o.status not in ('cancelled','awaiting_payment')) as last_order_at,
              min(o.placed_at) filter (where o.status not in ('cancelled','awaiting_payment')) as first_order_at, count(o.id)::int as any_orders
         from customers c left join orders o on o.customer_id = c.id where c.org_id = $1 group by c.id)
     select count(*)::int as customers, count(*) filter (where s.customer_id is null)::int as missing,
            count(*) filter (where (s.order_count, s.spend_minor, s.last_order_at, s.first_order_at, s.any_orders)
                                   is distinct from (e.order_count, e.spend_minor, e.last_order_at, e.first_order_at, e.any_orders))::int as wrong
       from expected e left join customer_stats s on s.customer_id = e.id`, [orgId]);
  expect(overall).toMatchObject({ missing: 0, wrong: 0 });
  const [branch] = await sql(
    `with expected as (
       select o.customer_id, o.branch_id, count(*) filter (where o.status not in ('cancelled','awaiting_payment'))::int as order_count,
              coalesce(sum(o.total_minor - o.refunded_minor) filter (where o.status not in ('cancelled','awaiting_payment')), 0)::bigint as spend_minor,
              count(*)::int as any_orders
         from orders o where o.org_id = $1 and o.customer_id is not null group by 1, 2)
     select (select count(*) from customer_branch_stats where org_id = $1)::int as stored, count(*)::int as expected,
            count(*) filter (where s.customer_id is null or (s.order_count, s.spend_minor, s.any_orders) is distinct from (e.order_count, e.spend_minor, e.any_orders))::int as wrong
       from expected e left join customer_branch_stats s using (customer_id, branch_id)`, [orgId]);
  expect(branch.wrong).toBe(0);
  expect(branch.stored).toBe(branch.expected);
}

beforeAll(async () => {
  t = await bootTestApp();
  tenant = await createTenant(t, { country: 'EG' });
  menu = await seedMenu(tenant);
  north = await addBranch(t, tenant, 'North');
});
afterAll(async () => { await t.close(); });

describe('customer read models follow the orders', () => {
  it('stay exact through placement, cancellation, refunds, branch moves and merges', async () => {
    const a = await placeOrder(t, tenant, { channel: 'web', fulfillment: 'pickup', lines: fries(2), customer: { name: 'Amal', phone: '+201007770001' } });
    await placeOrder(t, tenant, { branchId: north, channel: 'web', fulfillment: 'pickup', lines: fries(1), customer: { phone: '+201007770001' } });
    const b = await placeOrder(t, tenant, { channel: 'web', fulfillment: 'pickup', lines: fries(3), customer: { name: 'Bassem', phone: '+201007770002' } });
    await expectExact(tenant.orgId);
    const [stats] = await sql(`select order_count, spend_minor from customer_stats where customer_id = $1`, [a.customerId]);
    expect(stats).toEqual({ order_count: 2, spend_minor: 3 * 4500 });

    // Cancelling removes the order from the totals; kitchen progress does not touch the read model.
    const ctx = ownerCtx(tenant);
    const kernel = t.app.get(OrdersKernelService);
    await t.app.get(DbService).scoped(ctx, (tx) => kernel.transition(tx, ctx, b.id, 'cancelled', { reason: 'test' }));
    await expectExact(tenant.orgId);
    const [before] = await sql(`select updated_at from customer_stats where customer_id = $1`, [a.customerId]);
    await t.app.get(DbService).scoped(ctx, (tx) => kernel.transition(tx, ctx, a.id, 'accepted'));
    const [after] = await sql(`select updated_at from customer_stats where customer_id = $1`, [a.customerId]);
    expect(after.updated_at).toEqual(before.updated_at);

    // Refunds, a branch move and a merge (orders re-pointed to the survivor).
    await sql(`update orders set refunded_minor = 1000 where id = $1`, [a.id]);
    await sql(`update orders set branch_id = $2, number = number || '-m' where id = $1`, [a.id, north]);
    await expectExact(tenant.orgId);
    const merge = await t.http.post(`/v1/o/${tenant.orgId}/customers/${a.customerId}/merge`).set(auth(tenant.owner)).send({ duplicateId: b.customerId });
    expect(merge.status).toBe(200);
    await expectExact(tenant.orgId);
    const [merged] = await sql(`select order_count, any_orders from customer_stats where customer_id = $1`, [b.customerId]);
    expect(merged).toEqual({ order_count: 0, any_orders: 0 });
  });

  it('every new customer gets a stats row, so organization-wide lists include customers without orders', async () => {
    const [c] = await sql(`insert into customers (org_id, display_name) values ($1, 'No orders yet') returning id`, [tenant.orgId]);
    expect(await sql(`select order_count, last_order_at from customer_stats where customer_id = $1`, [c.id])).toEqual([{ order_count: 0, last_order_at: null }]);
    const res = await t.http.get(`/v1/o/${tenant.orgId}/customers?limit=200`).set(auth(tenant.owner));
    expect(res.body.items.map((x: any) => x.id)).toContain(c.id);
    expect(res.body.items.at(-1).lastOrderAt).toBeNull(); // customers without counted orders sort last
  });

  it('the reconcile job repairs and reports drift', async () => {
    const [victim] = await sql(`select customer_id from customer_branch_stats where org_id = $1 limit 1`, [tenant.orgId]);
    await sql(`update customer_branch_stats set order_count = order_count + 7 where customer_id = $1`, [victim.customer_id]);
    await sql(`update orders set updated_at = now() where customer_id = $1`, [victim.customer_id]);
    const r = await t.app.get(CustomerStatsJobs).reconcile();
    expect(r.drift).toBeGreaterThanOrEqual(1);
    await expectExact(tenant.orgId);
  });
});

describe('keyset pagination', () => {
  beforeAll(async () => {
    for (let i = 0; i < 9; i++) {
      await placeOrder(t, tenant, { channel: 'web', fulfillment: 'pickup', lines: fries(1 + (i % 3)), customer: { name: `Page ${i}`, phone: `+20100888000${i}` } });
    }
  });

  for (const sort of ['last_order', 'spend', 'orders', 'name', 'created']) {
    it(`walks every customer exactly once in list order (${sort})`, async () => {
      const all = await t.http.get(`/v1/o/${tenant.orgId}/customers?limit=200&sort=${sort}`).set(auth(tenant.owner));
      expect(all.body.nextCursor).toBeNull();
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 20; page++) {
        const res: any = await t.http.get(`/v1/o/${tenant.orgId}/customers?limit=4&sort=${sort}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`).set(auth(tenant.owner));
        expect(res.status).toBe(200);
        expect(res.body.total).toBe(all.body.total);
        seen.push(...res.body.items.map((x: any) => x.id));
        cursor = res.body.nextCursor;
        if (!cursor) break;
        expect(cursor).toMatch(/^k[A-Za-z0-9_-]+$/);
      }
      expect(seen).toEqual(all.body.items.map((x: any) => x.id));
    });
  }

  it('rejects a cursor from another sort and still accepts a legacy offset cursor', async () => {
    const p1 = await t.http.get(`/v1/o/${tenant.orgId}/customers?limit=2&sort=spend`).set(auth(tenant.owner));
    const wrong = await t.http.get(`/v1/o/${tenant.orgId}/customers?limit=2&sort=name&cursor=${p1.body.nextCursor}`).set(auth(tenant.owner));
    // A malformed request (PS-20, docs/API_STYLE.md): 400, not the 422 used for business-rule refusals.
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('invalid_cursor');
    const all = await t.http.get(`/v1/o/${tenant.orgId}/customers?limit=200&sort=name`).set(auth(tenant.owner));
    const legacy = await t.http.get(`/v1/o/${tenant.orgId}/customers?limit=2&sort=name&cursor=2`).set(auth(tenant.owner));
    expect(legacy.body.items.map((x: any) => x.id)).toEqual(all.body.items.slice(2, 4).map((x: any) => x.id));
  });
});
