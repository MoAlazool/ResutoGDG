import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantContext } from '../src/common/auth/context';
import { DbService } from '../src/common/db/db.service';
import { OrdersKernelService } from '../src/modules/kernel/orders-kernel.service';
import { addMember, auth, bootTestApp, createTenant, seedMenu, sql, type SeededMenu, type TestApp, type TestTenant } from './helpers';

// FT-17: menu / finance / payments / delivery read tools, the bounded query tool, and approvals bound to the exact
// scope and data they were requested on. Real AppModule: the menu module binds MENU_AVAILABILITY_PORT.

let t: TestApp;
let a: TestTenant;
let menu: SeededMenu;
let branch2: string;
let today: string;
const orders: string[] = [];
const TOOLS = ['list_menu', 'get_finance_summary', 'list_payments', 'list_delivery_jobs', 'query_data', 'update_product_availability', 'get_approval_status'];

async function client(body: Record<string, unknown> = {}) {
  const res = await t.http.post(`/v1/o/${a.orgId}/mcp/clients`).set(auth(a.owner))
    .send({ name: 'Assistant', actingRole: 'manager', allowedTools: TOOLS, rateLimitPerMin: 600, ...body });
  if (res.status !== 201) throw new Error(`create client failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; key: string };
}
const call = (k: string, tool: string, input: unknown = {}) =>
  t.http.post(`/v1/o/${a.orgId}/mcp/tools/${tool}`).set({ Authorization: `Bearer ${k}` }).send({ input });

beforeAll(async () => {
  t = await bootTestApp();
  a = await createTenant(t, { name: 'Data Grill' });
  menu = await seedMenu(a);
  branch2 = (await t.http.post(`/v1/o/${a.orgId}/branches`).set(auth(a.owner)).send({ name: 'Maadi' })).body.id;
  [{ today }] = await sql(`select (now() at time zone 'Africa/Cairo')::date::text as today`);
  const kernel = t.app.get(OrdersKernelService);
  const db = t.app.get(DbService);
  const ctx = new TenantContext(a.orgId, 'owner', null, a.owner.userId, 'user', a.owner.userId);
  const place = (branchId: string, productId: string, quantity: number, fulfillment: 'pickup' | 'delivery' = 'pickup') =>
    db.scoped(ctx, (tx) => kernel.place(tx, ctx, { branchId, channel: 'staff', fulfillment, lines: [{ productId, quantity }],
      ...(fulfillment === 'delivery' ? { customer: { name: 'Mona Adel', phone: '+201001234567' }, deliveryAddress: { line1: '12 Nile Street, flat 4', area: 'Zamalek', city: 'Cairo' } } : {}) }));
  orders.push((await place(a.branchId, menu.products.fries, 2)).id);   // 9000
  orders.push((await place(a.branchId, menu.products.soda, 3)).id);    // 7500
  orders.push((await place(branch2, menu.products.fries, 1)).id);      // 4500
  // Arranged data owned by other modules (payments, delivery), written directly as fixtures.
  await sql(`insert into payments(org_id, branch_id, order_id, method, provider, provider_payment_id, amount_minor, currency, status, captured_at, fee_minor, raw)
             values ($1, $2, $3, 'card', 'paymob', 'txn_99887766554321', 9000, 'EGP', 'succeeded', now(), 250, '{"card":{"last4":"4242","token":"tok_secret"}}'),
                    ($1, $2, $4, 'cash', 'manual', null, 7500, 'EGP', 'succeeded', now(), null, '{}'),
                    ($1, $2, $4, 'card', 'simulated', 'sim_1', 7500, 'EGP', 'succeeded', now(), null, '{}')`,
    [a.orgId, a.branchId, orders[0], orders[1]]);
  await sql(`update payments set is_test = true where provider = 'simulated' and org_id = $1`, [a.orgId]);
  await sql(`insert into delivery_jobs(org_id, branch_id, order_id, status, dropoff, distance_m, cod_amount_minor)
             values ($1, $2, $3, 'unassigned', '{"line1":"12 Nile Street, flat 4","area":"Zamalek","city":"Cairo","phone":"+201001234567"}', 2300, 4500)`,
    [a.orgId, branch2, orders[2]]);
});
afterAll(async () => { await t?.close(); });

describe('menu, finance, payments and delivery tools', () => {
  it('lists menu items with ids and per-branch availability for update_product_availability', async () => {
    const c = await client();
    await sql(`insert into product_branch_settings(org_id, product_id, branch_id, is_available, price_override_minor) values ($1, $2, $3, false, 5000)`,
      [a.orgId, menu.products.fries, branch2]);
    const all = await call(c.key, 'list_menu');
    expect(all.status).toBe(200);
    const fries = all.body.output.items.find((i: any) => i.name === 'Fries');
    expect(fries).toMatchObject({ productId: menu.products.fries, category: 'Mains', priceMinor: 4500, available: null, unavailableAtBranchIds: [branch2], modifierGroups: 0 });
    expect(all.body.output.items.find((i: any) => i.name === 'Smash burger').modifierGroups).toBe(2);
    const atMaadi = await call(c.key, 'list_menu', { branchId: branch2, query: 'fri' });
    expect(atMaadi.body.output.items).toEqual([expect.objectContaining({ name: 'Fries', available: false, priceMinor: 5000, basePriceMinor: 4500 })]);
    const onlyAvailable = await call(c.key, 'list_menu', { branchId: branch2, availableOnly: true });
    expect(onlyAvailable.body.output.items.map((i: any) => i.name)).not.toContain('Fries');
    // A sold-out (86) dish stays offered (is_available) but is not available to order (FT-02 / DF-01).
    await sql(`insert into product_branch_settings(org_id, product_id, branch_id, is_available, sold_out) values ($1, $2, $3, true, true)`,
      [a.orgId, menu.products.soda, branch2]);
    const soda = (await call(c.key, 'list_menu', { branchId: branch2, query: 'soda' })).body.output.items[0];
    expect(soda).toMatchObject({ productId: menu.products.soda, available: false });
    expect((await call(c.key, 'list_menu', { query: 'soda' })).body.output.items[0].unavailableAtBranchIds).toEqual([branch2]);
    await sql(`delete from product_branch_settings where product_id = $1 and branch_id = $2`, [menu.products.soda, branch2]);
    const page = await call(c.key, 'list_menu', { limit: 2 });
    const next = await call(c.key, 'list_menu', { limit: 2, cursor: page.body.output.nextCursor });
    expect([...page.body.output.items, ...next.body.output.items].map((i: any) => i.productId)).toHaveLength(4);
  });

  it('returns the finance module P&L, scoped and permission-checked', async () => {
    const accountant = await client({ name: 'Books', actingRole: 'accountant' });
    const res = await call(accountant.key, 'get_finance_summary', { from: today, to: today });
    expect(res.status).toBe(200);
    expect(res.body.output).toMatchObject({ currency: 'EGP', grossSalesMinor: 21000, method: 'deterministic_sql' });
    expect(res.body.output.netRevenueMinor).toBeLessThanOrEqual(21000);
    expect(res.body.output.methodology.length).toBeGreaterThan(3);
    const waiter = await client({ name: 'Floor', actingRole: 'waiter' });
    expect((await call(waiter.key, 'get_finance_summary', { from: today, to: today })).status).toBe(403);
    const scoped = await client({ name: 'Branch books', actingRole: 'accountant', branchIds: [branch2] });
    const own = await call(scoped.key, 'get_finance_summary', { from: today, to: today });
    expect(own.body.output).toMatchObject({ branchId: branch2, grossSalesMinor: 4500 });
    expect((await call(scoped.key, 'get_finance_summary', { from: today, to: today, branchId: a.branchId })).status).toBe(403);
  });

  it('lists payments read-only with masked references and no card data, excluding test payments by default', async () => {
    const c = await client({ name: 'Cashier view', actingRole: 'cashier' });
    const res = await call(c.key, 'list_payments');
    expect(res.status).toBe(200);
    expect(res.body.output.masked).toBe(true);
    expect(res.body.output.items).toHaveLength(2);
    const card = res.body.output.items.find((p: any) => p.provider === 'paymob');
    expect(card).toMatchObject({ amountMinor: 9000, feeMinor: 250, providerReference: '…4321', isTest: false, method: 'card' });
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('txn_99887766554321');
    expect(body).not.toContain('tok_secret');
    expect(body).not.toContain('4242');
    expect((await call(c.key, 'list_payments', { includeTest: true })).body.output.items).toHaveLength(3);
    const kitchen = await client({ name: 'KDS', actingRole: 'kitchen' });
    expect((await call(kitchen.key, 'list_payments')).status).toBe(403);
  });

  it('reports delivery status without addresses or phone numbers', async () => {
    const c = await client();
    const res = await call(c.key, 'list_delivery_jobs');
    expect(res.status).toBe(200);
    expect(res.body.output.items).toEqual([expect.objectContaining({ orderId: orders[2], status: 'unassigned', area: 'Zamalek', city: 'Cairo', distanceM: 2300, codAmountMinor: 4500 })]);
    expect(JSON.stringify(res.body)).not.toMatch(/Nile Street|\+2010/);
    expect((await call(c.key, 'list_delivery_jobs', { status: ['delivered'] })).body.output.items).toEqual([]);
  });
});

describe('query_data (bounded, no SQL)', () => {
  it('aggregates with whitelisted measures and groupings', async () => {
    const c = await client();
    const byBranch = await call(c.key, 'query_data', { dataset: 'orders', measures: ['count', 'revenue_minor'], groupBy: ['branch'], from: today, to: today });
    expect(byBranch.status).toBe(200);
    expect(byBranch.body.output).toMatchObject({ columns: ['branch', 'count', 'revenue_minor'], method: 'deterministic_sql', truncated: false });
    expect(byBranch.body.output.rows).toEqual([{ branch: 'Main branch', count: 2, revenue_minor: 16500 }, { branch: 'Maadi', count: 1, revenue_minor: 4500 }]);
    const items = await call(c.key, 'query_data', { dataset: 'order_items', measures: ['quantity'], groupBy: ['product'], from: today, to: today, sort: 'group_asc' });
    expect(items.body.output.rows).toEqual([{ product: 'Fries', quantity: 3 }, { product: 'Soda', quantity: 3 }]);
    const daily = await call(c.key, 'query_data', { dataset: 'orders', measures: ['avg_order_value_minor'], groupBy: ['day'], from: today, to: today });
    expect(daily.body.output.rows).toEqual([{ day: today, avg_order_value_minor: 7000 }]);
    const pays = await call(c.key, 'query_data', { dataset: 'payments', measures: ['amount_minor'], groupBy: ['method'], from: today, to: today });
    expect(pays.body.output.rows).toEqual([{ method: 'card', amount_minor: 9000 }, { method: 'cash', amount_minor: 7500 }]);
  });

  it('refuses anything outside the schema and datasets the role may not read', async () => {
    const c = await client();
    const bad = [
      { dataset: 'orders', measures: ['covers'], from: today, to: today },
      { dataset: 'orders', measures: ['count'], groupBy: ['product'], from: today, to: today },
      { dataset: 'orders', measures: ['count'], groupBy: ['day; drop table orders'], from: today, to: today },
      { dataset: 'customers', measures: ['count'], from: today, to: today },
      { dataset: 'orders', measures: ['count'], status: ['placed\' or 1=1 --'], from: today, to: today },
      { dataset: 'orders', measures: ['count'], from: '2024-01-01', to: '2026-01-01' },
    ];
    for (const input of bad) {
      const res = await call(c.key, 'query_data', input);
      expect(res.status, JSON.stringify(input)).toBe(400);
      expect(res.body.error.code).toBe('invalid_input');
    }
    const marketing = await client({ name: 'Growth', actingRole: 'marketing' });
    expect((await call(marketing.key, 'query_data', { dataset: 'orders', measures: ['count'], from: today, to: today })).status).toBe(403);
    expect(await sql(`select count(*)::int as n from orders where org_id = $1`, [a.orgId])).toEqual([{ n: 3 }]);
  });
});

describe('approvals bound to the reviewed scope and data', () => {
  const request = async (k: string, available = false) => {
    const res = await call(k, 'update_product_availability', { productId: menu.products.soda, branchId: a.branchId, available, reason: 'Out of cans' });
    expect(res.status).toBe(202);
    return res.body.output.approvalId as string;
  };

  it('is invalidated when staff change the same record before approval; nothing executes', async () => {
    const c = await client({ name: 'Ops bot' });
    const approvalId = await request(c.key);
    const detail = await t.http.get(`/v1/o/${a.orgId}/mcp/approvals/${approvalId}`).set(auth(a.owner));
    expect(detail.body).toMatchObject({ status: 'pending', changedSinceRequest: false });
    expect(detail.body.digest).toMatch(/^[a-f0-9]{64}$/);
    // A cashier marks soda unavailable themselves (the record the request was about).
    const off = await t.http.post(`/v1/o/${a.orgId}/menu/products/${menu.products.soda}/availability`).set(auth(a.owner)).send({ branchId: a.branchId, available: false });
    expect(off.status).toBe(200);
    const changed = await t.http.get(`/v1/o/${a.orgId}/mcp/approvals/${approvalId}`).set(auth(a.owner));
    expect(changed.body.changedSinceRequest).toBe(true);
    const res = await t.http.post(`/v1/o/${a.orgId}/mcp/approvals/${approvalId}/approve`).set(auth(a.owner)).send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('approval_invalidated');
    expect(res.body.error.details.approval).toMatchObject({ status: 'invalidated' });
    expect((await call(c.key, 'get_approval_status', { approvalId })).body.output).toMatchObject({ status: 'invalidated', result: null });
    expect(await sql(`select action from audit_logs where entity_id = $1 order by id`, [approvalId])).toEqual([{ action: 'mcp.approval.requested' }, { action: 'mcp.approval.invalidated' }]);
    await t.http.post(`/v1/o/${a.orgId}/menu/products/${menu.products.soda}/availability`).set(auth(a.owner)).send({ branchId: a.branchId, available: true });
  });

  it('is invalidated when the connection scope changes, and refuses an approval made on a stale screen', async () => {
    const c = await client({ name: 'Scope bot' });
    const first = await request(c.key);
    const patched = await t.http.patch(`/v1/o/${a.orgId}/mcp/clients/${c.id}`).set(auth(a.owner)).send({ actingRole: 'cashier' });
    expect(patched.status).toBe(200);
    const res = await t.http.post(`/v1/o/${a.orgId}/mcp/approvals/${first}/approve`).set(auth(a.owner)).send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('approval_invalidated');
    expect(res.body.error.message).toMatch(/role, branches or tools changed/);

    const second = await request(c.key);
    const shown = (await t.http.get(`/v1/o/${a.orgId}/mcp/approvals/${second}`).set(auth(a.owner))).body.digest;
    const stale = await t.http.post(`/v1/o/${a.orgId}/mcp/approvals/${second}/approve`).set(auth(a.owner)).send({ previewDigest: 'f'.repeat(64) });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('approval_changed');
    const ok = await t.http.post(`/v1/o/${a.orgId}/mcp/approvals/${second}/approve`).set(auth(a.owner)).send({ previewDigest: shown });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'executed', result: { available: false } });
    // ws5 (FT-02 / DF-01): "unavailable" is the temporary 86 (sold_out); the dish stays offered at the branch.
    expect(await sql(`select is_available, sold_out from product_branch_settings where product_id = $1 and branch_id = $2`, [menu.products.soda, a.branchId]))
      .toEqual([{ is_available: true, sold_out: true }]);
    const manager = await addMember(t, a, 'manager');
    expect(manager.userId).toBeTruthy();
  });
});
