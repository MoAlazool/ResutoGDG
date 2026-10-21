// S09 — Multi-tenancy: restaurant A's staff, guest tokens, MCP key, checkout/share/
// ordering tokens, public slug, storage URLs and direct database sessions can never
// read or mutate restaurant B's data (and vice versa). Every artefact is created
// through HTTP; SQL only reads state (and opens the `authenticated` role session the
// way supabase/tests/rls.test.mjs does, standing in for a direct Supabase client).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sandboxChannel, walkToMenu } from '../growth-helpers';
import { auth, bootTestApp, createTenant, sql, testDb, type TestApp, type TestTenant } from '../helpers';
import { qrTokenFor, saveFloor, table } from '../ops-fixtures';
import { buildMenuViaApi, cairoToday, key, PRICES, tokenFromUrl, type ApiMenu } from './support';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

interface World {
  tenant: TestTenant; menu: ApiMenu; tableId: string; visitToken: string; visitId: string; guestOrderId: string;
  webOrder: { id: string; publicRef: string }; checkoutToken: string; shareToken: string; orderingToken: string;
  imageUrl: string; mcpKey: string; mcpClientId: string; paymentId: string;
}

let t: TestApp;
let A: World;
let B: World;
let today: string;

const V = (tok: string) => ({ 'X-Visit-Token': tok });
const path = (absolute: string) => absolute.replace(/^http:\/\/api\.test/, '');

async function world(name: string, phone: string): Promise<World> {
  const tenant = await createTenant(t, { country: 'EG', name });
  const menu = await buildMenuViaApi(t, tenant);
  const f = await saveFloor(t, tenant, [table('T1', 200, 200)]);
  const tableId = f.tables[0].id;
  const qr = await qrTokenFor(t, tenant, tableId);
  const scan = await t.http.post(`/v1/public/tables/${qr}/session`);
  const guest = await t.http.post('/v1/public/visits/current/orders').set(V(scan.body.token)).set('Idempotency-Key', key('g'))
    .send({ lines: [{ productId: menu.fries, quantity: 2 }] });
  expect(guest.status, JSON.stringify(guest.body)).toBe(201);
  const split = await t.http.post('/v1/public/payments/visit/split').set(V(scan.body.token)).send({ mode: 'equal', people: 2, key: key('s') });
  expect(split.status, JSON.stringify(split.body)).toBe(200);
  const web = await t.http.post(`/v1/public/order/${tenant.slug}/orders`).set('Idempotency-Key', key('w')).send({
    branchId: tenant.branchId, fulfillment: 'pickup', payment: 'online', lines: [{ productId: menu.soda, quantity: 1 }],
    customer: { name: `${name} guest`, phone }, expectedTotalMinor: PRICES.soda,
  });
  expect(web.status, JSON.stringify(web.body)).toBe(201);
  const channelId = (await sandboxChannel(t, tenant)).id;
  const walk = await walkToMenu(t, tenant, channelId, phone, 'pickup');
  const img = await t.http.post(`/v1/o/${tenant.orgId}/menu/products/${menu.burger}/image`).set(auth(tenant.owner)).attach('file', PNG, { filename: 'b.png', contentType: 'image/png' });
  expect(img.status).toBe(200);
  const mcp = await t.http.post(`/v1/o/${tenant.orgId}/mcp/clients`).set(auth(tenant.owner))
    .send({ name: `${name} bot`, actingRole: 'manager', allowedTools: ['list_orders', 'get_order', 'get_sales_summary'] });
  expect(mcp.status).toBe(201);
  const counter = await t.http.post(`/v1/o/${tenant.orgId}/orders`).set(auth(tenant.owner)).set('Idempotency-Key', key('o'))
    .send({ branchId: tenant.branchId, fulfillment: 'pickup', lines: [{ productId: menu.soda, quantity: 2 }] });
  expect(counter.status, JSON.stringify(counter.body)).toBe(201);
  const cash = await t.http.post(`/v1/o/${tenant.orgId}/payments/collect`).set(auth(tenant.owner))
    .send({ orderId: counter.body.id, method: 'cash', amountMinor: counter.body.totalMinor, key: key('c') });
  expect(cash.status, JSON.stringify(cash.body)).toBe(201);
  return {
    tenant, menu, tableId, visitToken: scan.body.token, visitId: scan.body.visitId, guestOrderId: guest.body.id,
    webOrder: { id: web.body.order.id, publicRef: web.body.order.publicRef }, checkoutToken: tokenFromUrl(web.body.checkout.url, '/pay/'),
    shareToken: tokenFromUrl(split.body.shares[1].url, '/s/'), orderingToken: walk.token, imageUrl: img.body.imageUrl,
    mcpKey: mcp.body.key, mcpClientId: mcp.body.id, paymentId: cash.body.id,
  };
}

beforeAll(async () => {
  t = await bootTestApp();
  A = await world('Alpha Bistro', '+201009990001');
  B = await world('Beta Grill', '+201009990002');
  // B trades more than A, so any leak of B's sales into A's numbers would show.
  const extra = await t.http.post(`/v1/o/${B.tenant.orgId}/orders`).set(auth(B.tenant.owner)).set('Idempotency-Key', key('bx'))
    .send({ branchId: B.tenant.branchId, fulfillment: 'pickup', lines: [{ productId: B.menu.burger, quantity: 3, modifiers: [{ groupId: B.menu.size, optionId: B.menu.regular }] }] });
  expect(extra.status, JSON.stringify(extra.body)).toBe(201);
  today = await cairoToday();
}, 120_000);
afterAll(async () => { await t.close(); });

describe('S09 tenant isolation', () => {
  it('1. A’s staff get 404 on every B dashboard API, by B’s path or by B’s ids on A’s path', async () => {
    const a = A.tenant.owner;
    const bo = B.tenant.orgId;
    const readsOnB = [
      `/v1/o/${bo}`, `/v1/o/${bo}/orders`, `/v1/o/${bo}/orders/${B.guestOrderId}`, `/v1/o/${bo}/menu`, `/v1/o/${bo}/floor/${B.tenant.branchId}`,
      `/v1/o/${bo}/floor/${B.tenant.branchId}/qr`, `/v1/o/${bo}/kitchen/${B.tenant.branchId}`, `/v1/o/${bo}/payments`, `/v1/o/${bo}/customers`,
      `/v1/o/${bo}/finance/overview?from=${today}&to=${today}`, `/v1/o/${bo}/delivery/board`, `/v1/o/${bo}/mcp/clients`, `/v1/o/${bo}/connect/conversations`,
      `/v1/o/${bo}/marketing/campaigns`, `/v1/o/${bo}/audit`, `/v1/o/${bo}/billing/entitlements`, `/v1/o/${bo}/compliance/tax-profile`,
    ];
    for (const p of readsOnB) expect((await t.http.get(p).set(auth(a))).status, p).toBe(404);
    const ao = A.tenant.orgId;
    const crossIds = [
      `/v1/o/${ao}/orders/${B.guestOrderId}`, `/v1/o/${ao}/visits/${B.visitId}`, `/v1/o/${ao}/payments/${B.paymentId}`,
      `/v1/o/${ao}/floor/${B.tenant.branchId}`, `/v1/o/${ao}/menu/products/${B.menu.burger}`,
    ];
    for (const p of crossIds) expect((await t.http.get(p).set(auth(a))).status, p).toBe(404);
    // Mutations by id are refused and change nothing.
    expect((await t.http.post(`/v1/o/${ao}/visits/${B.visitId}/close`).set(auth(a)).send({ force: true })).status).toBe(404);
    expect((await t.http.post(`/v1/o/${ao}/tables/${B.tableId}/clean`).set(auth(a))).status).toBe(404);
    expect((await t.http.post(`/v1/o/${ao}/orders/${B.guestOrderId}/transition`).set(auth(a)).send({ to: 'accepted' })).status).toBe(404);
    expect((await t.http.patch(`/v1/o/${ao}/menu/products/${B.menu.burger}`).set(auth(a)).send({ version: 0, priceMinor: 1 })).status).toBe(404);
    expect((await t.http.post(`/v1/o/${ao}/payments/${B.paymentId}/refunds`).set(auth(a)).send({ amountMinor: 100, reason: 'x', key: key() })).status).toBe(404);
    expect((await t.http.post(`/v1/o/${ao}/payments/collect`).set(auth(a)).send({ orderId: B.webOrder.id, method: 'cash', amountMinor: 100, key: key() })).status).toBe(404);
    const [v] = await sql(`select status from visits where id = $1`, [B.visitId]);
    const [o] = await sql(`select status, refunded_minor from orders where id = $1`, [B.guestOrderId]);
    const [p] = await sql(`select price_minor from products where id = $1`, [B.menu.burger]);
    expect([v.status, o.status, o.refunded_minor, p.price_minor]).toEqual(['open', 'placed', 0, PRICES.burger]);
  });

  it('2. B’s guest visit, share, checkout and ordering tokens only ever reach B — and are not staff credentials', async () => {
    const mine = await t.http.get('/v1/public/visits/current').set(V(B.visitToken));
    expect(mine.status).toBe(200);
    expect(mine.body.visitId).toBe(B.visitId);
    expect(JSON.stringify(mine.body)).not.toContain(A.guestOrderId);
    // Ordering A's product with B's visit token is refused; nothing is created anywhere.
    const before = (await sql(`select count(*)::int as n from orders where org_id = any($1)`, [[A.tenant.orgId, B.tenant.orgId]]))[0].n;
    const cross = await t.http.post('/v1/public/visits/current/orders').set(V(B.visitToken)).set('Idempotency-Key', key())
      .send({ lines: [{ productId: A.menu.fries, quantity: 1 }] });
    expect(cross.status).toBeGreaterThanOrEqual(400);
    expect(cross.status).toBeLessThan(500);
    expect((await sql(`select count(*)::int as n from orders where org_id = any($1)`, [[A.tenant.orgId, B.tenant.orgId]]))[0].n).toBe(before);
    expect((await t.http.post('/v1/public/visits/current/quote').set(V(B.visitToken)).send({ lines: [{ productId: A.menu.fries, quantity: 1 }] })).status).not.toBe(200);
    // The bill under B's token is B's alone.
    const bill = await t.http.get('/v1/public/payments/visit/bill').set(V(B.visitToken));
    expect(bill.body.orders.map((x: any) => x.id)).toEqual([B.guestOrderId]);
    // Share, checkout and ordering tokens resolve to B only.
    const share = await t.http.get(`/v1/public/payments/shares/${B.shareToken}`);
    expect(share.status).toBe(200);
    expect(JSON.stringify(share.body)).not.toContain(A.tenant.orgId);
    const pay = await t.http.get(`/v1/public/pay/${B.checkoutToken}`);
    expect(pay.body).toMatchObject({ purpose: 'order', amountMinor: PRICES.soda });
    expect(JSON.stringify(pay.body)).not.toContain('Alpha Bistro');
    const ordering = await t.http.get(`/v1/public/connect/ordering/${B.orderingToken}`);
    expect(ordering.status).toBe(200);
    const cart = await t.http.post(`/v1/public/connect/ordering/${B.orderingToken}/cart`).send({ version: ordering.body.version, lines: [{ productId: A.menu.fries, quantity: 1 }] });
    expect(cart.status).toBeGreaterThanOrEqual(400);
    expect(cart.status).toBeLessThan(500);
    // Guest tokens are never accepted on staff routes, and token kinds are not interchangeable.
    for (const tok of [B.visitToken, B.shareToken, B.checkoutToken, B.orderingToken]) {
      expect((await t.http.get(`/v1/o/${B.tenant.orgId}/orders`).set({ Authorization: `Bearer ${tok}` })).status).toBe(401);
      expect((await t.http.get(`/v1/o/${A.tenant.orgId}/orders`).set({ Authorization: `Bearer ${tok}` })).status).toBe(401);
    }
    for (const tok of [B.shareToken, B.checkoutToken, B.orderingToken]) expect((await t.http.get('/v1/public/visits/current').set(V(tok))).status).toBe(401);
  });

  it('3. A’s MCP key gets 404 on B’s org path, and the attempt is audited in A', async () => {
    const K = { Authorization: `Bearer ${A.mcpKey}` };
    expect((await t.http.post(`/v1/o/${B.tenant.orgId}/mcp/tools/list_orders`).set(K).send({ input: {} })).status).toBe(404);
    expect((await t.http.get(`/v1/o/${B.tenant.orgId}/mcp/tools`).set(K)).status).toBe(404);
    // B's order id through A's own org path is just "not found".
    expect((await t.http.post(`/v1/o/${A.tenant.orgId}/mcp/tools/get_order`).set(K).send({ input: { orderId: B.guestOrderId } })).status).toBe(404);
    const own = await t.http.post(`/v1/o/${A.tenant.orgId}/mcp/tools/list_orders`).set(K).send({ input: { limit: 50 } });
    expect(own.body.output.items.every((x: any) => x.id !== B.guestOrderId && x.id !== B.webOrder.id)).toBe(true);
    const audits = await sql(`select org_id from audit_logs where action = 'mcp.cross_tenant_denied' and actor_id = $1`, [A.mcpClientId]);
    expect(audits.length).toBe(2);
    expect(audits.every((r) => r.org_id === A.tenant.orgId)).toBe(true);
    expect(await sql(`select 1 from mcp_tool_calls where org_id = $1 and client_id = $2`, [B.tenant.orgId, A.mcpClientId])).toHaveLength(0);
  });

  it('4. public slugs: A’s slug never serves, prices or reveals B’s branches, products or orders', async () => {
    const s = A.tenant.slug;
    expect((await t.http.post(`/v1/public/order/${s}/quote`).send({ branchId: B.tenant.branchId, fulfillment: 'pickup', lines: [{ productId: B.menu.soda, quantity: 1 }] })).status).toBe(404);
    const crossProduct = await t.http.post(`/v1/public/order/${s}/quote`).send({ branchId: A.tenant.branchId, fulfillment: 'pickup', lines: [{ productId: B.menu.soda, quantity: 1 }] });
    expect(crossProduct.status).toBeGreaterThanOrEqual(400);
    expect(crossProduct.status).toBeLessThan(500);
    const place = await t.http.post(`/v1/public/order/${s}/orders`).set('Idempotency-Key', key()).send({
      branchId: B.tenant.branchId, fulfillment: 'pickup', payment: 'pay_at_pickup', lines: [{ productId: B.menu.soda, quantity: 1 }], customer: { name: 'X', phone: '+201009990009' },
    });
    expect(place.status).toBe(404);
    expect((await t.http.get(`/v1/public/order/${s}/orders/${B.webOrder.publicRef}`)).status).toBe(404);
    const menu = await t.http.get(`/v1/public/menu/${s}`);
    const ids = menu.body.categories.flatMap((c: any) => c.products.map((p: any) => p.id));
    expect(ids).not.toContain(B.menu.burger);
    expect(menu.body.branches.map((b: any) => b.id)).not.toContain(B.tenant.branchId);
  });

  it('5. storage: signed media URLs cannot be re-pointed at another tenant or re-timed', async () => {
    const ok = await t.http.get(path(A.imageUrl));
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toBe('image/png');
    const a = new URL(A.imageUrl);
    const b = new URL(B.imageUrl);
    const aObject = decodeURIComponent(a.pathname.replace('/v1/media/', ''));
    const bObject = decodeURIComponent(b.pathname.replace('/v1/media/', ''));
    expect(aObject.startsWith(`${A.tenant.orgId}/`)).toBe(true);
    expect(bObject.startsWith(`${B.tenant.orgId}/`)).toBe(true);
    // A's signature on B's object path.
    expect((await t.http.get(`/v1/media/${encodeURIComponent(bObject)}${a.search}`)).status).toBe(404);
    // A's object re-prefixed with B's org id.
    const swapped = aObject.replace(A.tenant.orgId, B.tenant.orgId);
    expect((await t.http.get(`/v1/media/${encodeURIComponent(swapped)}${a.search}`)).status).toBe(404);
    // Extending the expiry invalidates the signature; no signature at all is refused.
    const exp = Number(a.searchParams.get('exp'));
    expect((await t.http.get(`/v1/media/${encodeURIComponent(aObject)}?exp=${exp + 86400}&sig=${a.searchParams.get('sig')}`)).status).toBe(404);
    expect((await t.http.get(`/v1/media/${encodeURIComponent(aObject)}`)).status).toBe(404);
    // Path traversal is refused too.
    expect((await t.http.get(`/v1/media/${encodeURIComponent(`${A.tenant.orgId}/../${bObject}`)}${a.search}`)).status).toBe(404);
  });

  // Audit PS-01/PCL-02: the `authenticated` role used to read its own tenant's rows across every branch (bypassing the
  // API's roles, branch scope and PII rules). Direct Supabase clients now get no tenant data at all.
  it('6. a direct database session as `authenticated` (Supabase client) reads no tenant data and cannot write', async () => {
    const c = await testDb().connect();
    const as = async <T>(fn: () => Promise<T>, forgedOrg?: string) => {
      await c.query('begin');
      try {
        await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: A.tenant.owner.userId, role: 'authenticated' })]);
        if (forgedOrg) await c.query(`select set_config('app.org_id', $1, true)`, [forgedOrg]);
        await c.query('set local role authenticated');
        return await fn();
      } finally {
        await c.query('rollback');
      }
    };
    try {
      await expect(as(() => c.query('select org_id from orders'))).rejects.toThrow(/permission denied/);
      await expect(as(() => c.query('select org_id from orders where org_id = $1', [B.tenant.orgId]), B.tenant.orgId)).rejects.toThrow(/permission denied/);
      await expect(as(() => c.query('select id from organizations'))).rejects.toThrow(/permission denied/);
      await expect(as(() => c.query('select guest_phone from reservations'))).rejects.toThrow(/permission denied/);
      await expect(as(() => c.query('select body from messages'))).rejects.toThrow(/permission denied/);
      await expect(as(() => c.query(`update orders set total_minor = 0 where org_id = $1`, [A.tenant.orgId]))).rejects.toThrow(/permission denied/);
      await expect(as(() => c.query(`update orders set total_minor = 0 where org_id = $1`, [B.tenant.orgId]))).rejects.toThrow(/permission denied/);
      await expect(as(() => c.query('select * from payments'))).rejects.toThrow(/permission denied/);
      await expect(as(() => c.query('select key_hash from mcp_clients'))).rejects.toThrow(/permission denied/);
    } finally {
      c.release();
    }
  });

  it('7. AI / intelligence endpoints are tenant-bound', async () => {
    const ai = `/v1/o/${A.tenant.orgId}/intelligence`;
    const thread = await t.http.post(`${ai}/assistant`).set(auth(A.tenant.owner)).send({ message: 'How much did we sell today?' });
    expect(thread.status, JSON.stringify(thread.body)).toBe(201);
    const [{ revenue }] = await sql(`select coalesce(sum(total_minor), 0)::int as revenue from orders where org_id = $1 and business_date = $2 and status not in ('cancelled', 'awaiting_payment')`, [A.tenant.orgId, today]);
    expect(thread.body.toolCalls[0].result.revenueMinor).toBe(revenue); // A's numbers only
    const [{ both }] = await sql(`select coalesce(sum(total_minor), 0)::int as both from orders where org_id = any($1) and business_date = $2 and status not in ('cancelled', 'awaiting_payment')`,
      [[A.tenant.orgId, B.tenant.orgId], today]);
    expect(both).toBeGreaterThan(revenue);
    const b = B.tenant.owner;
    expect((await t.http.get(`${ai}/insights`).set(auth(b))).status).toBe(404);
    expect((await t.http.post(`${ai}/assistant`).set(auth(b)).send({ message: 'sales today' })).status).toBe(404);
    expect((await t.http.get(`${ai}/assistant/threads/${thread.body.threadId}/messages`).set(auth(b))).status).toBe(404);
    expect((await t.http.get(`/v1/o/${B.tenant.orgId}/intelligence/assistant/threads/${thread.body.threadId}/messages`).set(auth(b))).status).toBe(404);
    expect((await t.http.get(`/v1/o/${B.tenant.orgId}/intelligence/forecast`).query({ branchId: A.tenant.branchId }).set(auth(b))).status).toBe(404);
    expect((await t.http.post(`/v1/o/${B.tenant.orgId}/intelligence/routes/plan`).set(auth(b)).send({ branchId: A.tenant.branchId, driverId: A.tenant.owner.userId })).status).toBe(404);
  });

  it('8. analytics are tenant-bound and never mix B’s sales into A’s', async () => {
    const q = `from=${today}&to=${today}`;
    expect((await t.http.get(`/v1/o/${A.tenant.orgId}/analytics/summary?${q}`).set(auth(B.tenant.owner))).status).toBe(404);
    expect((await t.http.get(`/v1/o/${B.tenant.orgId}/analytics/summary?${q}&branchId=${A.tenant.branchId}`).set(auth(B.tenant.owner))).status).toBe(404);
    expect((await t.http.get(`/v1/o/${A.tenant.orgId}/analytics/overview`).set(auth(B.tenant.owner))).status).toBe(404);
    const mine = await t.http.get(`/v1/o/${A.tenant.orgId}/analytics/products?${q}`).set(auth(A.tenant.owner));
    expect(mine.status).toBe(200);
    expect(JSON.stringify(mine.body)).not.toContain(B.menu.burger);
    expect(JSON.stringify(mine.body)).not.toContain(B.menu.fries);
  });
});
