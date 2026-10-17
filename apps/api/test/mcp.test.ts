import 'reflect-metadata';
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { TenantContext } from '../src/common/auth/context';
import { sha256 } from '../src/common/crypto/hash';
import { DbService } from '../src/common/db/db.service';
import { EntitlementsService } from '../src/common/entitlements/entitlements.service';
import { OrdersKernelService } from '../src/modules/kernel/orders-kernel.service';
import { CHECKOUT_PORT, SEGMENTS_PORT, type CheckoutPort, type SegmentsPort } from '../src/modules/kernel/ports';
import { McpJobs } from '../src/modules/mcp/mcp.jobs';
import { MENU_AVAILABILITY_PORT, type MenuAvailabilityPort } from '../src/modules/mcp/mcp.ports';
import { addMember, auth, bootTestApp, createTenant, seedMenu, sql, type SeededMenu, type TestApp, type TestTenant } from './helpers';

// ---------------------------------------------------------------------------
// Two apps on the same database:
//  * `t`  — the real AppModule: ports owned by other agents are NOT bound in this
//           worktree, so port-backed tools must answer 503 module_unavailable.
//  * `tp` — AppModule plus test doubles for the Checkout/Segments/MenuAvailability
//           ports (stand-ins for D1/C/B1 services) to exercise the approval flow.
// ---------------------------------------------------------------------------
const portCalls = { checkout: [] as any[], segments: [] as any[], availability: [] as any[] };
const fakeCheckout: CheckoutPort = {
  async createSession(_tx, ctx, input) {
    portCalls.checkout.push({ ctx: { actorType: ctx.actorType, actorId: ctx.actorId, role: ctx.role }, input });
    return { id: '6f1c2a40-0000-4000-8000-000000000001', token: 'tok_test', url: 'http://app.test/pay/tok_test',
      amountMinor: input.amountMinor ?? 0, currency: 'EGP', expiresAt: new Date(Date.now() + 3600_000).toISOString() };
  },
};
const fakeSegments: SegmentsPort = {
  async create(_tx, _ctx, input) {
    portCalls.segments.push(input);
    return { id: '6f1c2a40-0000-4000-8000-000000000002', memberCount: 3 };
  },
};
const fakeAvailability: MenuAvailabilityPort = {
  async setAvailability(_tx, ctx, input) {
    portCalls.availability.push({ actorType: ctx.actorType, role: ctx.role, input });
    return { productId: input.productId, branchId: input.branchId, available: input.available };
  },
};

@Global()
@Module({
  providers: [
    { provide: CHECKOUT_PORT, useValue: fakeCheckout },
    { provide: SEGMENTS_PORT, useValue: fakeSegments },
    { provide: MENU_AVAILABILITY_PORT, useValue: fakeAvailability },
  ],
  exports: [CHECKOUT_PORT, SEGMENTS_PORT, MENU_AVAILABILITY_PORT],
})
class TestPortsModule {}

let t: TestApp;
let tp: TestApp;
let a: TestTenant;      // tenant A (pro)
let b: TestTenant;      // tenant B (pro)
let menu: SeededMenu;
let branch2: string;
let today: string;
const orderIds: { main: string[]; second: string[]; cancelled: string } = { main: [], second: [], cancelled: '' };

async function bootWithPorts(): Promise<TestApp> {
  const ref = await Test.createTestingModule({ imports: [AppModule, TestPortsModule] }).compile();
  const app = ref.createNestApplication({ rawBody: true, logger: ['error'] });
  app.setGlobalPrefix('v1');
  await app.init();
  return { app, http: request(app.getHttpServer()), close: () => app.close() };
}

const ALL_TOOLS = [
  'get_restaurant_profile', 'list_branches', 'list_orders', 'get_order', 'list_reservations', 'search_customers', 'get_sales_summary',
  'list_top_items', 'get_inventory_status', 'list_low_stock', 'list_insights', 'create_customer_segment', 'prepare_campaign_draft',
  'request_campaign_send', 'create_payment_link', 'update_product_availability', 'get_approval_status',
];

async function createClient(app: TestApp, tenant: TestTenant, body: Record<string, unknown> = {}, as = tenant.owner) {
  const res = await app.http.post(`/v1/o/${tenant.orgId}/mcp/clients`).set(auth(as))
    .send({ name: 'Claude Desktop', actingRole: 'manager', allowedTools: ALL_TOOLS, rateLimitPerMin: 600, ...body });
  if (res.status !== 201) throw new Error(`create client failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; key: string; keyPrefix: string };
}

const key = (k: string) => ({ Authorization: `Bearer ${k}` });
const call = (app: TestApp, k: string, orgId: string, tool: string, input: unknown = {}) =>
  app.http.post(`/v1/o/${orgId}/mcp/tools/${tool}`).set(key(k)).send({ input });

beforeAll(async () => {
  t = await bootTestApp();
  tp = await bootWithPorts();
  a = await createTenant(t, { name: 'Nile Grill' });
  b = await createTenant(t, { name: 'Other Place' });
  menu = await seedMenu(a);
  const br = await t.http.post(`/v1/o/${a.orgId}/branches`).set(auth(a.owner)).send({ name: 'Zamalek' });
  expect(br.status).toBe(201);
  branch2 = br.body.id;
  [{ today }] = await sql(`select (now() at time zone 'Africa/Cairo')::date::text as today`);

  // Orders created through the shared kernel (the only order writer).
  const orders = t.app.get(OrdersKernelService);
  const db = t.app.get(DbService);
  const ctx = new TenantContext(a.orgId, 'owner', null, a.owner.userId, 'user', a.owner.userId);
  const place = (branchId: string, productId: string, quantity: number, customer?: { name: string; phone: string }) =>
    db.scoped(ctx, (tx) => orders.place(tx, ctx, { branchId, channel: 'staff', fulfillment: 'pickup', lines: [{ productId, quantity }], customer }));
  orderIds.main.push((await place(a.branchId, menu.products.fries, 2, { name: 'Mona Adel', phone: '+201001234567' })).id); // 9000
  orderIds.main.push((await place(a.branchId, menu.products.soda, 3)).id); // 7500
  orderIds.second.push((await place(branch2, menu.products.fries, 1, { name: 'Omar Said', phone: '+201112223334' })).id); // 4500
  const cancelled = await place(a.branchId, menu.products.soda, 1);
  await db.scoped(ctx, (tx) => orders.transition(tx, ctx, cancelled.id, 'cancelled', { reason: 'test' }));
  orderIds.cancelled = cancelled.id;
});
afterAll(async () => { await tp?.close(); await t?.close(); });

describe('MCP client keys', () => {
  it('shows the key once, stores only its sha256 and audits creation', async () => {
    const c = await createClient(t, a, { name: 'Key lifecycle' });
    expect(c.key).toMatch(/^rmcp_[A-Za-z0-9_-]{43}$/);
    expect(c.key.startsWith(c.keyPrefix)).toBe(true);
    const [row] = await sql(`select key_hash, key_prefix from mcp_clients where id = $1`, [c.id]);
    expect(row.key_hash).toBe(sha256(c.key));
    expect(row.key_hash).not.toContain(c.key);
    const list = await t.http.get(`/v1/o/${a.orgId}/mcp/clients`).set(auth(a.owner));
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(c.key);
    expect(list.body.items.find((x: any) => x.id === c.id)).toMatchObject({ keyPrefix: c.keyPrefix, status: 'active' });
    expect(JSON.stringify(list.body)).not.toMatch(/key_?hash/i);
    const [audit] = await sql(`select metadata from audit_logs where org_id = $1 and action = 'mcp.client.created' and entity_id = $2`, [a.orgId, c.id]);
    expect(JSON.stringify(audit.metadata)).not.toContain(c.key);

    const who = await t.http.get('/v1/mcp/whoami').set(key(c.key));
    expect(who.status).toBe(200);
    expect(who.body).toMatchObject({ clientId: c.id, orgId: a.orgId, orgName: 'Nile Grill', actingRole: 'manager', branchIds: null });
  });

  it('rejects revoked, expired, unknown and missing keys (401)', async () => {
    const c = await createClient(t, a, { name: 'To revoke' });
    expect((await call(t, c.key, a.orgId, 'list_branches')).status).toBe(200);
    const rev = await t.http.post(`/v1/o/${a.orgId}/mcp/clients/${c.id}/revoke`).set(auth(a.owner));
    expect(rev.status).toBe(201);
    expect(rev.body.status).toBe('revoked');
    expect((await call(t, c.key, a.orgId, 'list_branches')).status).toBe(401);
    expect((await t.http.get('/v1/mcp/whoami').set(key(c.key))).status).toBe(401);

    const e = await createClient(t, a, { name: 'To expire' });
    await sql(`update mcp_clients set expires_at = now() - interval '1 minute' where id = $1`, [e.id]);
    expect((await call(t, e.key, a.orgId, 'list_branches')).status).toBe(401);
    expect((await call(t, 'rmcp_not-a-real-key-000000000000000000000000000', a.orgId, 'list_branches')).status).toBe(401);
    expect((await t.http.post(`/v1/o/${a.orgId}/mcp/tools/list_branches`).send({})).status).toBe(401);
  });

  it('never assigns the owner role and never exceeds the creator', async () => {
    const owner = await t.http.post(`/v1/o/${a.orgId}/mcp/clients`).set(auth(a.owner))
      .send({ name: 'Bad', actingRole: 'owner', allowedTools: ['list_orders'] });
    expect(owner.status).toBe(400);
    expect(owner.body.error.code).toBe('validation_failed');
    const admin = await addMember(t, a, 'admin');
    const asAdmin = await t.http.post(`/v1/o/${a.orgId}/mcp/clients`).set(auth(admin))
      .send({ name: 'Peer', actingRole: 'admin', allowedTools: ['list_orders'] });
    expect(asAdmin.status).toBe(403);
    const ok = await t.http.post(`/v1/o/${a.orgId}/mcp/clients`).set(auth(admin))
      .send({ name: 'Lower', actingRole: 'manager', allowedTools: ['list_orders'] });
    expect(ok.status).toBe(201);
    // managers have mcp:approve but not mcp:manage
    const manager = await addMember(t, a, 'manager');
    expect((await t.http.post(`/v1/o/${a.orgId}/mcp/clients`).set(auth(manager))
      .send({ name: 'Nope', actingRole: 'cashier', allowedTools: ['list_orders'] })).status).toBe(403);
    expect((await t.http.post(`/v1/o/${a.orgId}/mcp/clients`).set(auth(a.owner))
      .send({ name: 'Bad tool', actingRole: 'cashier', allowedTools: ['run_sql'] })).status).toBe(400);
    expect((await t.http.post(`/v1/o/${a.orgId}/mcp/clients`).set(auth(a.owner))
      .send({ name: 'Bad branch', actingRole: 'cashier', allowedTools: ['list_orders'], branchIds: [b.branchId] })).status).toBe(422);
  });

  it('updates scope and tools with immediate effect', async () => {
    const c = await createClient(t, a, { name: 'Scoped later', allowedTools: ['list_orders', 'list_branches'] });
    expect((await call(t, c.key, a.orgId, 'list_orders')).status).toBe(200);
    const upd = await t.http.patch(`/v1/o/${a.orgId}/mcp/clients/${c.id}`).set(auth(a.owner)).send({ allowedTools: ['list_branches'] });
    expect(upd.status).toBe(200);
    expect(upd.body.allowedTools).toEqual(['list_branches']);
    const denied = await call(t, c.key, a.orgId, 'list_orders');
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('tool_not_allowed');
    expect((await t.http.patch(`/v1/o/${a.orgId}/mcp/clients/${c.id}`).set(auth(a.owner)).send({ actingRole: 'owner' })).status).toBe(400);
  });

  it('requires the mcp module (402 on the free plan)', async () => {
    const free = await createTenant(t, { planId: 'free' });
    const res = await t.http.post(`/v1/o/${free.orgId}/mcp/clients`).set(auth(free.owner))
      .send({ name: 'x', actingRole: 'manager', allowedTools: ['list_orders'] });
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('module_not_entitled');
  });
});

describe('tool listing', () => {
  it('lists only tools that are allowed, permitted for the acting role and entitled', async () => {
    const c = await createClient(t, a, { name: 'Cashier bot', actingRole: 'cashier',
      allowedTools: ['list_orders', 'get_sales_summary', 'create_payment_link', 'search_customers', 'list_insights'] });
    const res = await t.http.get(`/v1/o/${a.orgId}/mcp/tools`).set(key(c.key));
    expect(res.status).toBe(200);
    const names = res.body.items.map((x: any) => x.name).sort();
    // cashier: no analytics:read → no sales summary / insights
    expect(names).toEqual(['create_payment_link', 'list_orders', 'search_customers']);
    const lo = res.body.items.find((x: any) => x.name === 'list_orders');
    expect(lo.inputSchema).toMatchObject({ type: 'object' });
    expect(lo.inputSchema.properties.limit).toMatchObject({ type: 'integer', maximum: 100 });
    expect(lo.outputSchema).toMatchObject({ type: 'object' });
    expect(lo.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    const pay = res.body.items.find((x: any) => x.name === 'create_payment_link');
    expect(pay).toMatchObject({ sensitive: true, annotations: { readOnlyHint: false, destructiveHint: true } });
    // not in the list → not callable either
    const denied = await call(t, c.key, a.orgId, 'get_sales_summary', { from: today, to: today });
    expect(denied.status).toBe(403);
  });

  it('hides and blocks tools whose module the tenant is not entitled to', async () => {
    const c = await createClient(t, b, { name: 'Insights bot' });
    await sql(`insert into entitlement_overrides(org_id, module, enabled, reason) values ($1, 'intelligence', false, 'test')`, [b.orgId]);
    t.app.get(EntitlementsService).invalidate(b.orgId);
    const res = await t.http.get(`/v1/o/${b.orgId}/mcp/tools`).set(key(c.key));
    expect(res.body.items.map((x: any) => x.name)).not.toContain('list_insights');
    expect(res.body.items.map((x: any) => x.name)).toContain('list_orders');
    const blocked = await call(t, c.key, b.orgId, 'list_insights');
    expect(blocked.status).toBe(402);
    const [row] = await sql(`select outcome, error_code from mcp_tool_calls where client_id = $1 and tool = 'list_insights'`, [c.id]);
    expect(row).toMatchObject({ outcome: 'denied', error_code: 'module_not_entitled' });

    // Without the mcp module itself, the guard rejects the key (and the denial is still recorded).
    await sql(`insert into entitlement_overrides(org_id, module, enabled, reason) values ($1, 'mcp', false, 'test')`, [b.orgId]);
    t.app.get(EntitlementsService).invalidate(b.orgId);
    expect((await call(t, c.key, b.orgId, 'list_orders')).status).toBe(402);
    expect((await t.http.get('/v1/mcp/whoami').set(key(c.key))).status).toBe(402);
    const [denied] = await sql(`select outcome from mcp_tool_calls where client_id = $1 and tool = 'list_orders' order by id desc limit 1`, [c.id]);
    expect(denied.outcome).toBe('denied');
    await sql(`delete from entitlement_overrides where org_id = $1`, [b.orgId]);
    t.app.get(EntitlementsService).invalidate(b.orgId);
  });
});

describe('tool execution', () => {
  it('lists orders and computes a deterministic sales summary from kernel data', async () => {
    const c = await createClient(t, a, { name: 'Reader' });
    const res = await call(t, c.key, a.orgId, 'list_orders', { limit: 2 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', tool: 'list_orders', replayed: false });
    expect(res.body.output.items).toHaveLength(2);
    expect(res.body.output.nextCursor).toBeTruthy();
    const page2 = await call(t, c.key, a.orgId, 'list_orders', { limit: 2, cursor: res.body.output.nextCursor });
    const ids = [...res.body.output.items, ...page2.body.output.items].map((o: any) => o.id);
    expect(new Set(ids).size).toBe(4);
    expect(ids.sort()).toEqual([...orderIds.main, ...orderIds.second, orderIds.cancelled].sort());

    const one = await call(t, c.key, a.orgId, 'get_order', { orderId: orderIds.main[0] });
    expect(one.status).toBe(200);
    expect(one.body.output).toMatchObject({ totalMinor: 9000, itemCount: 2, customerName: 'Mona Adel', customerPhone: '+201001234567', piiMasked: false });
    expect(one.body.output.lines[0]).toMatchObject({ name: 'Fries', quantity: 2, lineTotalMinor: 9000 });

    const sum = await call(t, c.key, a.orgId, 'get_sales_summary', { from: today, to: today });
    expect(sum.status).toBe(200);
    expect(sum.body.output).toMatchObject({
      currency: 'EGP', orders: 3, revenueMinor: 9000 + 7500 + 4500, averageOrderValueMinor: 7000, cancelledOrders: 1, method: 'deterministic_sql',
    });
    const byBranch = await call(t, c.key, a.orgId, 'get_sales_summary', { from: today, to: today, branchId: branch2 });
    expect(byBranch.body.output).toMatchObject({ orders: 1, revenueMinor: 4500 });
    const top = await call(t, c.key, a.orgId, 'list_top_items', { from: today, to: today, by: 'revenue' });
    expect(top.body.output.items[0]).toMatchObject({ name: 'Fries', quantity: 3, revenueMinor: 13500, orders: 2 });
    const profile = await call(t, c.key, a.orgId, 'get_restaurant_profile');
    expect(profile.body.output).toMatchObject({ name: 'Nile Grill', currency: 'EGP', branchCount: 2, actingRole: 'manager' });
    expect((await call(t, c.key, a.orgId, 'list_reservations')).body.output).toMatchObject({ items: [], date: today });
    expect((await call(t, c.key, a.orgId, 'get_inventory_status')).status).toBe(200);
    expect((await call(t, c.key, a.orgId, 'list_low_stock')).status).toBe(200);
    expect((await call(t, c.key, a.orgId, 'list_insights')).body.output).toEqual({ items: [] });
  });

  it('validates input and records invalid calls', async () => {
    const c = await createClient(t, a, { name: 'Sloppy' });
    const bad = await call(t, c.key, a.orgId, 'list_orders', { limit: 1000 });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_input');
    expect(bad.body.error.details[0].path).toBe('limit');
    const period = await call(t, c.key, a.orgId, 'get_sales_summary', { from: '2026-02-01', to: '2025-01-01' });
    expect(period.status).toBe(400);
    expect((await call(t, c.key, a.orgId, 'list_orders', { cursor: 'garbage' })).status).toBe(400);
    expect((await call(t, c.key, a.orgId, 'run_sql', { q: 'select 1' })).status).toBe(404);
    const rows = await sql(`select tool, outcome from mcp_tool_calls where client_id = $1 order by id`, [c.id]);
    expect(rows.map((r) => r.outcome)).toEqual(['invalid_input', 'invalid_input', 'invalid_input', 'denied']);
  });

  it('masks customer PII unless the acting role may read customers', async () => {
    const manager = await createClient(t, a, { name: 'Manager bot', actingRole: 'manager' });
    const full = await call(t, manager.key, a.orgId, 'search_customers', { query: 'mona' });
    expect(full.body.output).toMatchObject({ piiMasked: false, items: [{ displayName: 'Mona Adel', phone: '+201001234567', ordersCount: 1, totalSpentMinor: 9000 }] });
    const accountant = await createClient(t, a, { name: 'Accountant bot', actingRole: 'accountant' });
    const masked = await call(t, accountant.key, a.orgId, 'search_customers', { query: '1234567' });
    expect(masked.body.output.piiMasked).toBe(true);
    expect(masked.body.output.items[0]).toMatchObject({ displayName: 'Mona A.', phone: '+20••••••••67' });
    expect(JSON.stringify(masked.body)).not.toContain('1001234567');
    const order = await call(t, accountant.key, a.orgId, 'get_order', { orderId: orderIds.main[0] });
    expect(order.body.output).toMatchObject({ customerName: 'Mona A.', piiMasked: true });
    expect(order.body.output.customerPhone).not.toContain('1234567');
  });

  it('confines a branch-scoped client to its branch', async () => {
    const c = await createClient(t, a, { name: 'Zamalek bot', branchIds: [branch2] });
    const res = await call(t, c.key, a.orgId, 'list_orders');
    expect(res.body.output.items.map((o: any) => o.id)).toEqual(orderIds.second);
    expect((await call(t, c.key, a.orgId, 'get_order', { orderId: orderIds.main[0] })).status).toBe(404);
    expect((await call(t, c.key, a.orgId, 'list_orders', { branchId: a.branchId })).status).toBe(403);
    const sum = await call(t, c.key, a.orgId, 'get_sales_summary', { from: today, to: today });
    expect(sum.body.output).toMatchObject({ orders: 1, revenueMinor: 4500 });
    expect((await call(t, c.key, a.orgId, 'list_branches')).body.output.items.map((x: any) => x.id)).toEqual([branch2]);
    const customers = await call(t, c.key, a.orgId, 'search_customers', { query: 'mona' });
    expect(customers.body.output.items).toEqual([]);
  });

  it('returns 404 for another tenant and audits the attempt in the key owner\'s tenant', async () => {
    const c = await createClient(t, a, { name: 'Curious' });
    const res = await call(t, c.key, b.orgId, 'list_orders');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
    expect((await t.http.get(`/v1/o/${b.orgId}/mcp/tools`).set(key(c.key))).status).toBe(404);
    const audits = await sql(`select org_id, actor_type, actor_id, source, metadata from audit_logs where action = 'mcp.cross_tenant_denied' and actor_id = $1`, [c.id]);
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({ org_id: a.orgId, actor_type: 'mcp_client', source: 'mcp' });
    expect(audits[0].metadata.attemptedOrgId).toBe(b.orgId);
    const [callRow] = await sql(`select org_id, outcome from mcp_tool_calls where client_id = $1`, [c.id]);
    expect(callRow).toMatchObject({ org_id: a.orgId, outcome: 'denied' });
    expect(await sql(`select 1 from mcp_tool_calls where org_id = $1 and client_id = $2`, [b.orgId, c.id])).toHaveLength(0);
    // a record id from the other tenant is just "not found"
    const bOrders = await sql(`select id from orders where org_id = $1 limit 1`, [a.orgId]);
    const other = await createClient(t, b, { name: 'B bot' });
    expect((await call(t, other.key, b.orgId, 'get_order', { orderId: bOrders[0].id })).status).toBe(404);
  });

  it('enforces the per-client rate limit (429) and records it', async () => {
    const c = await createClient(t, a, { name: 'Chatty', rateLimitPerMin: 3 });
    for (let i = 0; i < 3; i++) expect((await call(t, c.key, a.orgId, 'list_branches')).status).toBe(200);
    const limited = await call(t, c.key, a.orgId, 'list_branches');
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('rate_limited');
    const [row] = await sql(`select outcome from mcp_tool_calls where client_id = $1 order by id desc limit 1`, [c.id]);
    expect(row.outcome).toBe('rate_limited');
  });

  it('enforces per-tool limits on top of the client limit', async () => {
    const c = await createClient(t, a, { name: 'Searcher', rateLimitPerMin: 600 });
    for (let i = 0; i < 20; i++) expect((await call(t, c.key, a.orgId, 'search_customers', { query: `zz${i}` })).status).toBe(200);
    expect((await call(t, c.key, a.orgId, 'search_customers', { query: 'zz-last' })).status).toBe(429);
    expect((await call(t, c.key, a.orgId, 'list_branches')).status).toBe(200);
  });

  it('answers 503 module_unavailable when the owning module\'s port is not bound', async () => {
    const c = await createClient(t, a, { name: 'Actions' });
    const pay = await call(t, c.key, a.orgId, 'create_payment_link', { amountMinor: 5000, description: 'Deposit' });
    expect(pay.status).toBe(503);
    expect(pay.body.error.code).toBe('module_unavailable');
    const seg = await call(t, c.key, a.orgId, 'create_customer_segment', { name: 'VIP', definition: { minOrders: 3 } });
    expect(seg.status).toBe(503);
    expect((await call(t, c.key, a.orgId, 'prepare_campaign_draft', { name: 'Hi', channel: 'whatsapp', message: 'Hello' })).status).toBe(503);
    expect((await call(t, c.key, a.orgId, 'request_campaign_send', { campaignId: orderIds.main[0] })).status).toBe(503);
    expect((await call(t, c.key, a.orgId, 'update_product_availability',
      { productId: menu.products.fries, branchId: a.branchId, available: false })).status).toBe(503);
    expect(await sql(`select 1 from mcp_approvals where client_id = $1`, [c.id])).toHaveLength(0);
    const rows = await sql(`select outcome, error_code from mcp_tool_calls where client_id = $1`, [c.id]);
    expect(rows.every((r) => r.outcome === 'error' && r.error_code === 'module_unavailable')).toBe(true);
  });

  it('keeps staff tokens off the MCP execution routes but lets managers test read-only tools', async () => {
    const c = await createClient(t, a, { name: 'Tested', actingRole: 'accountant' });
    const staff = await t.http.post(`/v1/o/${a.orgId}/mcp/tools/list_orders`).set(auth(a.owner)).send({ input: {} });
    expect(staff.status).toBe(403);
    expect(staff.body.error.code).toBe('mcp_clients_only');
    expect((await t.http.get(`/v1/o/${a.orgId}/mcp/tools`).set(auth(a.owner))).status).toBe(403);
    expect((await t.http.get('/v1/mcp/whoami').set(auth(a.owner))).status).toBe(403);
    // MCP keys cannot reach staff routes (guard: @AllowMcp only)
    expect((await t.http.get(`/v1/o/${a.orgId}/mcp/clients`).set(key(c.key))).status).toBe(403);
    expect((await t.http.get(`/v1/o/${a.orgId}/members`).set(key(c.key))).status).toBe(403);

    const test = await t.http.post(`/v1/o/${a.orgId}/mcp/clients/${c.id}/test/get_order`).set(auth(a.owner)).send({ input: { orderId: orderIds.main[0] } });
    expect(test.status).toBe(201);
    expect(test.body.output.piiMasked).toBe(true); // runs with the client's role, not the owner's
    const write = await t.http.post(`/v1/o/${a.orgId}/mcp/clients/${c.id}/test/create_payment_link`).set(auth(a.owner))
      .send({ input: { amountMinor: 100, description: 'x' } });
    expect(write.status).toBe(422);
    const waiter = await addMember(t, a, 'waiter');
    expect((await t.http.post(`/v1/o/${a.orgId}/mcp/clients/${c.id}/test/list_orders`).set(auth(waiter)).send({})).status).toBe(403);
    const [row] = await sql(`select via, outcome from mcp_tool_calls where client_id = $1 order by id limit 1`, [c.id]);
    expect(row).toMatchObject({ via: 'dashboard_test', outcome: 'ok' });
    const [audit] = await sql(`select actor_type, actor_id from audit_logs where action = 'mcp.tool_call' and metadata->>'clientId' = $1 order by id limit 1`, [c.id]);
    expect(audit).toMatchObject({ actor_type: 'user', actor_id: a.owner.userId });
  });

  it('writes an audit row and usage metric for every call', async () => {
    const c = await createClient(t, a, { name: 'Audited' });
    await call(t, c.key, a.orgId, 'list_branches');
    await call(t, c.key, a.orgId, 'list_orders', { limit: 0 });
    await call(t, c.key, a.orgId, 'get_order', { orderId: '6f1c2a40-0000-4000-8000-00000000ffff' });
    const calls = await sql(`select outcome from mcp_tool_calls where client_id = $1 order by id`, [c.id]);
    expect(calls.map((r) => r.outcome)).toEqual(['ok', 'invalid_input', 'denied']);
    const audits = await sql(`select source, actor_type, metadata->>'outcome' as outcome from audit_logs
                               where action = 'mcp.tool_call' and metadata->>'clientId' = $1 order by id`, [c.id]);
    expect(audits).toHaveLength(3);
    expect(audits.every((x) => x.source === 'mcp' && x.actor_type === 'mcp_client')).toBe(true);
    const usage = await sql(`select count(*)::int as n from usage_events where org_id = $1 and metric = 'mcp_calls' and metadata->>'clientId' = $2`, [a.orgId, c.id]);
    expect(usage[0].n).toBe(1);
    const log = await t.http.get(`/v1/o/${a.orgId}/mcp/calls?clientId=${c.id}`).set(auth(a.owner));
    expect(log.body.items.map((x: any) => x.outcome)).toEqual(['denied', 'invalid_input', 'ok']);
    const stats = await t.http.get(`/v1/o/${a.orgId}/mcp/clients/${c.id}/usage`).set(auth(a.owner));
    expect(stats.body.windows['24h']).toMatchObject({ ok: 1, invalid_input: 1, denied: 1 });
  });
});

describe('sensitive tools and approvals', () => {
  it('requires approval, executes the stored input exactly once with the client context and exposes the status', async () => {
    const c = await createClient(tp, a, { name: 'Menu bot' });
    const input = { productId: menu.products.fries, branchId: a.branchId, available: false, reason: 'Fryer broken' };
    const req1 = await call(tp, c.key, a.orgId, 'update_product_availability', input);
    expect(req1.status).toBe(202);
    expect(req1.body).toMatchObject({ status: 'approval_required', replayed: false, output: { status: 'approval_required' } });
    const approvalId = req1.body.output.approvalId;
    expect(req1.body.output.summary).toBe('Mark "Fries" as unavailable at Main branch');
    expect(portCalls.availability).toHaveLength(0);
    // identical retry → same pending request
    const req2 = await call(tp, c.key, a.orgId, 'update_product_availability', input);
    expect(req2.body).toMatchObject({ replayed: true, output: { approvalId } });
    const [evt] = await sql(`select event_type, payload from outbox_events where aggregate_id = $1`, [approvalId]);
    expect(evt).toMatchObject({ event_type: 'mcp.approval_requested', payload: { tool: 'update_product_availability', clientId: c.id } });
    expect((await call(tp, c.key, a.orgId, 'get_approval_status', { approvalId })).body.output).toMatchObject({ status: 'pending', result: null });

    const manager = await addMember(tp, a, 'manager');
    const waiter = await addMember(tp, a, 'waiter');
    expect((await tp.http.get(`/v1/o/${a.orgId}/mcp/approvals`).set(auth(waiter))).status).toBe(403);
    const queue = await tp.http.get(`/v1/o/${a.orgId}/mcp/approvals`).set(auth(manager));
    expect(queue.status).toBe(200);
    expect(queue.body.items.find((x: any) => x.id === approvalId)).toMatchObject({ status: 'pending', client: { id: c.id, name: 'Menu bot' } });
    const detail = await tp.http.get(`/v1/o/${a.orgId}/mcp/approvals/${approvalId}`).set(auth(manager));
    expect(detail.body.preview.changes[0]).toEqual({ label: 'Availability at Main branch', before: 'available', after: 'unavailable' });
    expect((await tp.http.post(`/v1/o/${a.orgId}/mcp/approvals/${approvalId}/approve`).set(auth(waiter)).send({})).status).toBe(403);

    const approved = await tp.http.post(`/v1/o/${a.orgId}/mcp/approvals/${approvalId}/approve`).set(auth(manager)).send({ note: 'ok' });
    expect(approved.status).toBe(201);
    expect(approved.body).toMatchObject({ status: 'executed', decidedBy: manager.userId, result: { available: false } });
    expect(portCalls.availability).toHaveLength(1);
    expect(portCalls.availability[0]).toMatchObject({ actorType: 'mcp_client', role: 'manager', input: { ...input, source: 'mcp' } });
    const again = await tp.http.post(`/v1/o/${a.orgId}/mcp/approvals/${approvalId}/approve`).set(auth(manager)).send({});
    expect(again.status).toBe(409);
    expect(portCalls.availability).toHaveLength(1);
    expect((await call(tp, c.key, a.orgId, 'get_approval_status', { approvalId })).body.output)
      .toMatchObject({ status: 'executed', result: { productId: menu.products.fries, available: false } });
    const exec = await sql(`select via, outcome from mcp_tool_calls where approval_id = $1 order by id`, [approvalId]);
    expect(exec.map((r) => `${r.via}:${r.outcome}`)).toEqual(['mcp:approval_required', 'mcp:approval_required', 'approval:ok']);
    const actions = (await sql(`select action from audit_logs where entity_id = $1 order by id`, [approvalId])).map((r) => r.action);
    expect(actions).toEqual(['mcp.approval.requested', 'mcp.approval.approved']);
  });

  it('hands a payment link URL to the client once', async () => {
    const c = await createClient(tp, a, { name: 'Pay bot' });
    const req = await call(tp, c.key, a.orgId, 'create_payment_link', { orderId: orderIds.main[1], description: 'Table 4 bill' });
    expect(req.status).toBe(202);
    expect(req.body.output.summary).toContain('75.00 EGP');
    const approvalId = req.body.output.approvalId;
    const approved = await tp.http.post(`/v1/o/${a.orgId}/mcp/approvals/${approvalId}/approve`).set(auth(a.owner)).send({});
    expect(approved.body.result.url).toBe('http://app.test/pay/tok_test');
    expect(portCalls.checkout.at(-1)).toMatchObject({ ctx: { actorType: 'mcp_client', actorId: c.id }, input: { purpose: 'order', amountMinor: 7500, channel: 'mcp' } });
    const first = await call(tp, c.key, a.orgId, 'get_approval_status', { approvalId });
    expect(first.body.output.result.url).toBe('http://app.test/pay/tok_test');
    const second = await call(tp, c.key, a.orgId, 'get_approval_status', { approvalId });
    expect(second.body.output.result).toMatchObject({ urlDelivered: true });
    expect(second.body.output.result.url).toBeUndefined();
    // over-asking is refused before any approval is created
    const over = await call(tp, c.key, a.orgId, 'create_payment_link', { orderId: orderIds.main[1], amountMinor: 999999, description: 'x' });
    expect(over.status).toBe(422);
  });

  it('rejects and expires requests; revocation closes pending ones', async () => {
    const c = await createClient(tp, a, { name: 'Reject bot' });
    const mk = (available: boolean, productId = menu.products.soda) =>
      call(tp, c.key, a.orgId, 'update_product_availability', { productId, branchId: a.branchId, available });
    const r1 = (await mk(false)).body.output.approvalId;
    const rej = await tp.http.post(`/v1/o/${a.orgId}/mcp/approvals/${r1}/reject`).set(auth(a.owner)).send({ note: 'not today' });
    expect(rej.status).toBe(201);
    expect(rej.body).toMatchObject({ status: 'rejected', decisionNote: 'not today' });
    expect((await call(tp, c.key, a.orgId, 'get_approval_status', { approvalId: r1 })).body.output.status).toBe('rejected');
    expect((await tp.http.post(`/v1/o/${a.orgId}/mcp/approvals/${r1}/approve`).set(auth(a.owner)).send({})).status).toBe(409);

    const r2 = (await mk(true)).body.output.approvalId;
    await sql(`update mcp_approvals set expires_at = now() - interval '1 second' where id = $1`, [r2]);
    expect((await call(tp, c.key, a.orgId, 'get_approval_status', { approvalId: r2 })).body.output.status).toBe('expired');
    expect(await tp.app.get(McpJobs).expireApprovals()).toBeGreaterThanOrEqual(1);
    const [row] = await sql(`select status from mcp_approvals where id = $1`, [r2]);
    expect(row.status).toBe('expired');
    expect((await tp.http.post(`/v1/o/${a.orgId}/mcp/approvals/${r2}/approve`).set(auth(a.owner)).send({})).status).toBe(409);

    const r3 = (await mk(false, menu.products.burger)).body.output.approvalId;
    await tp.http.post(`/v1/o/${a.orgId}/mcp/clients/${c.id}/revoke`).set(auth(a.owner));
    const [closed] = await sql(`select status, decision_note from mcp_approvals where id = $1`, [r3]);
    expect(closed).toMatchObject({ status: 'rejected', decision_note: 'Connection revoked' });
    expect(portCalls.availability.filter((p) => p.input.productId !== menu.products.fries)).toHaveLength(0);
  });

  it('a branch-scoped client cannot request changes at another branch; approvers need the tool permission', async () => {
    const c = await createClient(tp, a, { name: 'Zamalek menu', branchIds: [branch2] });
    const other = await call(tp, c.key, a.orgId, 'update_product_availability', { productId: menu.products.fries, branchId: a.branchId, available: false });
    expect(other.status).toBe(403);
    const own = await call(tp, c.key, a.orgId, 'update_product_availability', { productId: menu.products.fries, branchId: branch2, available: false });
    expect(own.status).toBe(202);
    // a marketing-role user has neither mcp:approve nor menu:availability
    const marketer = await addMember(tp, a, 'marketing');
    expect((await tp.http.post(`/v1/o/${a.orgId}/mcp/approvals/${own.body.output.approvalId}/approve`).set(auth(marketer)).send({})).status).toBe(403);
    // an approver limited to another branch cannot approve it
    const mainManager = await addMember(tp, a, 'manager', [a.branchId]);
    expect((await tp.http.post(`/v1/o/${a.orgId}/mcp/approvals/${own.body.output.approvalId}/approve`).set(auth(mainManager)).send({})).status).toBe(403);
  });

  it('runs non-sensitive writes idempotently by input hash', async () => {
    const c = await createClient(tp, a, { name: 'Segment bot' });
    const input = { name: 'Lapsed regulars', definition: { lastOrderDaysAgo: { gte: 30 } } };
    const first = await call(tp, c.key, a.orgId, 'create_customer_segment', input);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ replayed: false, output: { status: 'draft', source: 'mcp', memberCount: 3 } });
    const second = await call(tp, c.key, a.orgId, 'create_customer_segment', input);
    expect(second.body).toMatchObject({ replayed: true, output: first.body.output });
    expect(portCalls.segments).toHaveLength(1);
    expect(portCalls.segments[0]).toMatchObject({ source: 'mcp', name: 'Lapsed regulars' });
  });
});
