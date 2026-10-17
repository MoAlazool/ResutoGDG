// S08 — ResutoMCP: the owner connects an external AI client with an rmcp_ key (shown
// once). The client lists tools, reads orders and sales, and asks for a payment link
// (sensitive): nothing happens until a manager approves, then the real ResutoPay
// checkout is created exactly once. Every call is audited; a revoked key is rejected.
// The client is driven through the API's @AllowMcp routes (the same routes
// apps/mcp-server forwards to); the stdio/HTTP MCP server itself is not started here.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256 } from '../../src/common/crypto/hash';
import { addMember, auth, bootTestApp, createTenant, sql, type TestApp, type TestTenant, type TestUser } from '../helpers';
import { buildMenuViaApi, cairoToday, key, PRICES, tokenFromUrl, type ApiMenu } from './support';

let t: TestApp;
let tenant: TestTenant;
let menu: ApiMenu;
let manager: TestUser;
let cashier: TestUser;
let today: string;
let client: { id: string; key: string; keyPrefix: string };
const orders: { paid: string; unpaid: string } = { paid: '', unpaid: '' };
let approvalId: string;

const K = (k: string) => ({ Authorization: `Bearer ${k}` });
const call = (tool: string, input: unknown = {}, k = client.key) => t.http.post(`/v1/o/${tenant.orgId}/mcp/tools/${tool}`).set(K(k)).send({ input });

beforeAll(async () => {
  t = await bootTestApp();
  tenant = await createTenant(t, { country: 'EG', name: 'Nile Grill' });
  menu = await buildMenuViaApi(t, tenant);
  manager = await addMember(t, tenant, 'manager');
  cashier = await addMember(t, tenant, 'cashier');
  today = await cairoToday();
  const place = async (lines: unknown[], customer: { name: string; phone: string }) => {
    const r = await t.http.post(`/v1/o/${tenant.orgId}/orders`).set(auth(cashier)).set('Idempotency-Key', key('mcp'))
      .send({ branchId: tenant.branchId, fulfillment: 'pickup', lines, customer });
    expect(r.status).toBe(201);
    return r.body.id as string;
  };
  orders.paid = await place([{ productId: menu.fries, quantity: 2 }], { name: 'Mona Adel', phone: '+201001234567' });
  await t.http.post(`/v1/o/${tenant.orgId}/orders/${orders.paid}/collect`).set(auth(cashier)).set('Idempotency-Key', key('cash')).send({ method: 'cash' }).expect(201);
  orders.unpaid = await place([{ productId: menu.soda, quantity: 3 }], { name: 'Omar Said', phone: '+201112223334' });
});
afterAll(async () => { await t.close(); });

describe('S08 MCP client: key → tools → reads → approved payment link → audit → revoke', () => {
  it('1. the owner creates a client key; it is shown once and only its hash is stored', async () => {
    const res = await t.http.post(`/v1/o/${tenant.orgId}/mcp/clients`).set(auth(tenant.owner)).send({
      name: 'Claude Desktop', actingRole: 'manager', rateLimitPerMin: 120,
      allowedTools: ['list_orders', 'get_order', 'get_sales_summary', 'list_top_items', 'create_payment_link', 'get_approval_status'],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    client = res.body;
    expect(client.key).toMatch(/^rmcp_[A-Za-z0-9_-]{43}$/);
    const [row] = await sql(`select key_hash from mcp_clients where id = $1`, [client.id]);
    expect(row.key_hash).toBe(sha256(client.key));
    const list = await t.http.get(`/v1/o/${tenant.orgId}/mcp/clients`).set(auth(tenant.owner));
    expect(JSON.stringify(list.body)).not.toContain(client.key);
    expect(list.body.items.find((c: any) => c.id === client.id)).toMatchObject({ keyPrefix: client.keyPrefix, status: 'active' });
    const who = await t.http.get('/v1/mcp/whoami').set(K(client.key));
    expect(who.body).toMatchObject({ clientId: client.id, orgId: tenant.orgId, orgName: 'Nile Grill', actingRole: 'manager' });
  });

  it('2. the client lists only its allowed tools, with schemas and the sensitive flag', async () => {
    const res = await t.http.get(`/v1/o/${tenant.orgId}/mcp/tools`).set(K(client.key));
    expect(res.status).toBe(200);
    expect(res.body.items.map((x: any) => x.name).sort()).toEqual(['create_payment_link', 'get_approval_status', 'get_order', 'get_sales_summary', 'list_orders', 'list_top_items']);
    expect(res.body.items.find((x: any) => x.name === 'create_payment_link')).toMatchObject({ sensitive: true, annotations: { readOnlyHint: false } });
    expect(res.body.items.find((x: any) => x.name === 'list_orders').inputSchema).toMatchObject({ type: 'object' });
    // Not allowed → not callable.
    expect((await call('search_customers', { query: 'mona' })).status).toBe(403);
  });

  it('3. reads orders and a sales summary that match the restaurant’s books', async () => {
    const list = await call('list_orders', { limit: 10 });
    expect(list.status).toBe(200);
    expect(list.body.output.items.map((x: any) => x.id).sort()).toEqual([orders.paid, orders.unpaid].sort());
    const one = await call('get_order', { orderId: orders.paid });
    expect(one.body.output).toMatchObject({ totalMinor: PRICES.fries * 2, customerName: 'Mona Adel', paymentStatus: 'paid' });
    const sum = await call('get_sales_summary', { from: today, to: today });
    expect(sum.status).toBe(200);
    const [db] = await sql(`select count(*)::int as n, sum(total_minor)::int as revenue from orders where org_id = $1 and status <> 'cancelled'`, [tenant.orgId]);
    expect(sum.body.output).toMatchObject({ currency: 'EGP', orders: db.n, revenueMinor: db.revenue, method: 'deterministic_sql' });
    expect(db.revenue).toBe(PRICES.fries * 2 + PRICES.soda * 3);
  });

  it('4. a payment link request needs approval; nothing is created yet', async () => {
    const req = await call('create_payment_link', { orderId: orders.unpaid, description: 'Phone order — Omar' });
    expect(req.status, JSON.stringify(req.body)).toBe(202);
    expect(req.body).toMatchObject({ status: 'approval_required', output: { status: 'approval_required' } });
    approvalId = req.body.output.approvalId;
    expect(req.body.output.summary).toContain('75.00 EGP');
    const retry = await call('create_payment_link', { orderId: orders.unpaid, description: 'Phone order — Omar' });
    expect(retry.body).toMatchObject({ replayed: true, output: { approvalId } });
    expect((await sql(`select count(*)::int as n from checkout_sessions where order_id = $1`, [orders.unpaid]))[0].n).toBe(0);
    expect((await call('get_approval_status', { approvalId })).body.output).toMatchObject({ status: 'pending', result: null });
  });

  it('5. a manager reviews and approves; the real checkout is created exactly once', async () => {
    expect((await t.http.post(`/v1/o/${tenant.orgId}/mcp/approvals/${approvalId}/approve`).set(auth(cashier)).send({})).status).toBe(403);
    const queue = await t.http.get(`/v1/o/${tenant.orgId}/mcp/approvals`).set(auth(manager));
    expect(queue.body.items.find((a: any) => a.id === approvalId)).toMatchObject({ status: 'pending', client: { id: client.id, name: 'Claude Desktop' } });
    const approved = await t.http.post(`/v1/o/${tenant.orgId}/mcp/approvals/${approvalId}/approve`).set(auth(manager)).send({ note: 'Customer asked by phone' });
    expect(approved.status, JSON.stringify(approved.body)).toBe(201);
    expect(approved.body).toMatchObject({ status: 'executed', decidedBy: manager.userId });
    expect(approved.body.result.url).toMatch(/^http:\/\/app\.test\/pay\/[A-Za-z0-9_-]+$/);
    expect(approved.body.result).toMatchObject({ amountMinor: PRICES.soda * 3, currency: 'EGP' });
    const again = await t.http.post(`/v1/o/${tenant.orgId}/mcp/approvals/${approvalId}/approve`).set(auth(manager)).send({});
    expect(again.status).toBe(409);
    const sessions = await sql(`select channel, amount_minor, status from checkout_sessions where order_id = $1`, [orders.unpaid]);
    expect(sessions).toEqual([{ channel: 'mcp', amount_minor: PRICES.soda * 3, status: 'open' }]);
    // The link is a real ResutoPay checkout.
    const view = await t.http.get(`/v1/public/pay/${tokenFromUrl(approved.body.result.url, '/pay/')}`);
    expect(view.body).toMatchObject({ status: 'open', amountMinor: PRICES.soda * 3, sandbox: true });
    // The URL is handed to the client once.
    const first = await call('get_approval_status', { approvalId });
    expect(first.body.output).toMatchObject({ status: 'executed' });
    const second = await call('get_approval_status', { approvalId });
    expect(second.body.output.result.url).toBeUndefined();
  });

  it('6. every call left an audit trail and usage', async () => {
    const calls = await sql(`select tool, via, outcome from mcp_tool_calls where client_id = $1 order by id`, [client.id]);
    expect(calls.length).toBeGreaterThanOrEqual(8);
    expect(calls.filter((c) => c.tool === 'create_payment_link').map((c) => `${c.via}:${c.outcome}`))
      .toEqual(['mcp:approval_required', 'mcp:approval_required', 'approval:ok']);
    expect(calls.find((c) => c.tool === 'search_customers')).toMatchObject({ outcome: 'denied' });
    const audit = await sql(`select count(*)::int as n from audit_logs where org_id = $1 and action = 'mcp.tool_call' and metadata->>'clientId' = $2`, [tenant.orgId, client.id]);
    expect(audit[0].n).toBe(calls.length);
    const approvalAudit = (await sql(`select action from audit_logs where entity_id = $1 order by id`, [approvalId])).map((r) => r.action);
    expect(approvalAudit).toEqual(['mcp.approval.requested', 'mcp.approval.approved']);
    const log = await t.http.get(`/v1/o/${tenant.orgId}/mcp/calls?clientId=${client.id}`).set(auth(tenant.owner));
    expect(log.status).toBe(200);
    expect(log.body.items.length).toBe(calls.length);
  });

  it('7. a revoked key is rejected everywhere', async () => {
    const rev = await t.http.post(`/v1/o/${tenant.orgId}/mcp/clients/${client.id}/revoke`).set(auth(tenant.owner));
    expect(rev.status).toBe(201);
    expect((await call('list_orders')).status).toBe(401);
    expect((await t.http.get(`/v1/o/${tenant.orgId}/mcp/tools`).set(K(client.key))).status).toBe(401);
    expect((await t.http.get('/v1/mcp/whoami').set(K(client.key))).status).toBe(401);
  });
});
