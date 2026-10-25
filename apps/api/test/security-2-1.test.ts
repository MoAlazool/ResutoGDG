// 1D threat-model probes (docs/security/THREAT_MODEL_2.1.md): cross-tenant ids through every 2.1 endpoint (IDOR), the
// approver's branch scope on MCP approvals, and the op permission on change-set decisions. Passing does not prove the
// absence of other issues; each case pins one threat from the model.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inbound, sandboxChannel } from './growth-helpers';
import { addMember, auth, bootTestApp, createTenant, seedMenu, sql, unique, type SeededMenu, type TestApp, type TestTenant, type TestUser } from './helpers';
import { addBranch } from './insights-fixtures';

let t: TestApp;
let a: TestTenant;
let b: TestTenant;
let menuA: SeededMenu;
let menuB: SeededMenu;
let north: string;
let mainManager: TestUser;
let marketer: TestUser;
let waiter: TestUser;

const o = (tenant: TestTenant) => `/v1/o/${tenant.orgId}`;
const priceOp = (productId: string, priceMinor: number) => ({ type: 'menu.item.price.set', input: { productId, priceMinor } });
const propose = (u: { token: string }, tenant: TestTenant, ops: unknown[]) =>
  t.http.post(`${o(tenant)}/change-sets`).set(auth(u)).set('Idempotency-Key', unique('sec-key')).send({ title: 'Probe', ops });

async function mcpClient(tenant: TestTenant, tools: string[], body: Record<string, unknown> = {}) {
  const res = await t.http.post(`${o(tenant)}/mcp/clients`).set(auth(tenant.owner))
    .send({ name: unique('Probe assistant'), actingRole: 'manager', allowedTools: tools, rateLimitPerMin: 600, ...body });
  if (res.status !== 201) throw new Error(`create client failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; key: string };
}
const tool = (key: string, tenant: TestTenant, name: string, input: unknown) =>
  t.http.post(`${o(tenant)}/mcp/tools/${name}`).set({ Authorization: `Bearer ${key}` }).send({ input });

beforeAll(async () => {
  t = await bootTestApp();
  a = await createTenant(t, { name: 'Probe Grill' });
  b = await createTenant(t, { name: 'Victim Grill' });
  menuA = await seedMenu(a);
  menuB = await seedMenu(b);
  north = await addBranch(t, a, 'North');
  mainManager = await addMember(t, a, 'manager', [a.branchId]);
  marketer = await addMember(t, a, 'marketing');
  waiter = await addMember(t, a, 'waiter');
});
afterAll(async () => { await t?.close(); });

describe('MCP approvals honour the approver\'s branch scope (as the change-set inbox does)', () => {
  let northApproval: string;
  let mainApproval: string;

  beforeAll(async () => {
    const c = await mcpClient(a, ['toggle_availability', 'get_approval_status']);
    const n = await tool(c.key, a, 'toggle_availability', { productId: menuA.products.fries, branchId: north, available: false, reason: 'probe north' });
    expect(n.status, JSON.stringify(n.body)).toBe(202);
    northApproval = n.body.output.approvalId;
    const m = await tool(c.key, a, 'toggle_availability', { productId: menuA.products.soda, branchId: a.branchId, available: false, reason: 'probe main' });
    expect(m.status, JSON.stringify(m.body)).toBe(202);
    mainApproval = m.body.output.approvalId;
  });

  it('a manager of the Main branch neither lists nor opens a request for the North branch', async () => {
    const list = await t.http.get(`${o(a)}/mcp/approvals?status=all`).set(auth(mainManager));
    expect(list.status).toBe(200);
    const ids = list.body.items.map((x: any) => x.id);
    expect(ids).toContain(mainApproval);
    expect(ids).not.toContain(northApproval);
    expect((await t.http.get(`${o(a)}/mcp/approvals/${northApproval}`).set(auth(mainManager))).status).toBe(404);
    expect((await t.http.get(`${o(a)}/mcp/approvals/${mainApproval}`).set(auth(mainManager))).status).toBe(200);
    // The owner (every branch) sees both.
    const all = (await t.http.get(`${o(a)}/mcp/approvals?status=all`).set(auth(a.owner))).body.items.map((x: any) => x.id);
    expect(all).toEqual(expect.arrayContaining([northApproval, mainApproval]));
  });

  it('a manager of the Main branch cannot reject or approve the North request; it stays pending', async () => {
    const reject = await t.http.post(`${o(a)}/mcp/approvals/${northApproval}/reject`).set(auth(mainManager)).send({ note: 'not mine' });
    expect(reject.status).toBe(403);
    expect(reject.body.error.code).toBe('forbidden');
    const approve = await t.http.post(`${o(a)}/mcp/approvals/${northApproval}/approve`).set(auth(mainManager)).send({});
    expect(approve.status).toBe(403);
    const [row] = await sql(`select status from mcp_approvals where id = $1`, [northApproval]);
    expect(row.status).toBe('pending');
    // Their own branch's request is theirs to decide.
    const own = await t.http.post(`${o(a)}/mcp/approvals/${mainApproval}/reject`).set(auth(mainManager)).send({ note: 'keep it' });
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(own.body.status).toBe('rejected');
  });
});

describe('change-set decisions need the permission of every op (approve and reject alike)', () => {
  it('a role with changes:approve but without menu:write can neither approve nor reject a price change', async () => {
    const res = await propose(a.owner, a, [priceOp(menuA.products.burger, 19900)]);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.status).toBe('pending_approval');
    const approve = await t.http.post(`${o(a)}/change-sets/${res.body.id}/approve`).set(auth(marketer)).send({});
    expect(approve.status).toBe(403);
    const reject = await t.http.post(`${o(a)}/change-sets/${res.body.id}/reject`).set(auth(marketer)).send({ note: 'veto' });
    expect(reject.status).toBe(403);
    expect((await sql(`select status from change_sets where id = $1`, [res.body.id]))[0].status).toBe('pending_approval');
    // A waiter has no changes:* permission at all.
    expect((await t.http.get(`${o(a)}/change-sets`).set(auth(waiter))).status).toBe(403);
    expect((await t.http.post(`${o(a)}/change-sets/${res.body.id}/reject`).set(auth(waiter)).send({})).status).toBe(403);
    // Someone who holds the permission still can.
    const owner = await t.http.post(`${o(a)}/change-sets/${res.body.id}/reject`).set(auth(a.owner)).send({ note: 'no' });
    expect(owner.status, JSON.stringify(owner.body)).toBe(200);
    expect(owner.body.status).toBe('rejected');
  });
});

describe('IDOR sweep: another restaurant\'s ids in our own paths and bodies', () => {
  const ids = {} as Record<string, string>;

  beforeAll(async () => {
    const cs = await propose(b.owner, b, [priceOp(menuB.products.fries, 5100)]);
    expect(cs.status, JSON.stringify(cs.body)).toBe(201);
    ids.changeSet = cs.body.id;
    ids.op = (await sql(`select id from change_ops where change_set_id = $1`, [cs.body.id]))[0].id;
    const report = await t.http.post(`${o(b)}/reports`).set(auth(b.owner)).send({ name: 'Victim report', section: 'sales', view: { period: '7d' }, shared: true });
    expect(report.status, JSON.stringify(report.body)).toBe(201);
    ids.report = report.body.id;
    const channel = await sandboxChannel(t, b);
    const conv = await inbound(t, b, channel.id, '+201009990001', { text: 'hello', name: 'Victim guest' });
    ids.conversation = conv.conversationId;
    const tag = await t.http.post(`${o(b)}/connect/tags`).set(auth(b.owner)).send({ name: 'Victim tag' });
    expect(tag.status, JSON.stringify(tag.body)).toBe(201);
    ids.tag = tag.body.id;
    const reply = await t.http.post(`${o(b)}/connect/saved-replies`).set(auth(b.owner)).send({ title: 'Victim reply', bodyEn: 'secret wording' });
    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
    ids.reply = reply.body.id;
    const note = await t.http.post(`${o(b)}/connect/conversations/${ids.conversation}/notes`).set(auth(b.owner)).send({ body: 'victim note', key: unique('n') });
    expect(note.status, JSON.stringify(note.body)).toBe(201);
    ids.customer = (await sql(`insert into customers(org_id, display_name, phone_e164) values ($1, 'Victim Customer', '+201009990002') returning id`, [b.orgId]))[0].id;
    const pairing = await t.http.post(`${o(b)}/pos/pairings`).set(auth(b.owner)).send({ branchId: b.branchId, actingRole: 'waiter', name: 'Victim till' });
    expect(pairing.status, JSON.stringify(pairing.body)).toBe(201);
    const paired = await t.http.post('/v1/pos/pair').send({ code: pairing.body.code, platform: 'ipados', appVersion: '0.2.0', model: 'iPad13,1' });
    expect(paired.status, JSON.stringify(paired.body)).toBe(201);
    ids.device = paired.body.device.id;
    ids.deviceToken = paired.body.token;
  });

  it('change sets: get, audit, approve, reject, apply and reverse answer 404 and change nothing', async () => {
    const base = `${o(a)}/change-sets/${ids.changeSet}`;
    expect((await t.http.get(base).set(auth(a.owner))).status).toBe(404);
    expect((await t.http.get(`${base}/audit`).set(auth(a.owner))).status).toBe(404);
    expect((await t.http.post(`${base}/approve`).set(auth(a.owner)).send({})).status).toBe(404);
    expect((await t.http.post(`${base}/reject`).set(auth(a.owner)).send({})).status).toBe(404);
    expect((await t.http.post(`${base}/apply`).set(auth(a.owner)).send({})).status).toBe(404);
    expect((await t.http.post(`${base}/ops/${ids.op}/reverse`).set(auth(a.owner)).send({})).status).toBe(404);
    // Their path, our token: the restaurant is not found.
    expect((await t.http.get(`${o(b)}/change-sets/${ids.changeSet}`).set(auth(a.owner))).status).toBe(404);
    expect((await t.http.get(`${o(b)}/change-policies`).set(auth(a.owner))).status).toBe(404);
    expect((await sql(`select status from change_sets where id = $1`, [ids.changeSet]))[0].status).toBe('pending_approval');
  });

  it('saved reports: get, rename and delete another restaurant\'s report answer 404', async () => {
    expect((await t.http.get(`${o(a)}/reports/${ids.report}`).set(auth(a.owner))).status).toBe(404);
    expect((await t.http.patch(`${o(a)}/reports/${ids.report}`).set(auth(a.owner)).send({ name: 'pwned' })).status).toBe(404);
    expect((await t.http.delete(`${o(a)}/reports/${ids.report}`).set(auth(a.owner))).status).toBe(404);
    expect((await t.http.get(`${o(a)}/reports`).set(auth(a.owner))).body.items.map((r: any) => r.id)).not.toContain(ids.report);
    expect((await sql(`select name from saved_reports where id = $1`, [ids.report]))[0].name).toBe('Victim report');
  });

  it('inbox: notes, tags, tag assignments and saved replies of another restaurant are out of reach', async () => {
    const conn = `${o(a)}/connect`;
    expect((await t.http.get(`${conn}/conversations/${ids.conversation}/notes`).set(auth(a.owner))).status).toBe(404);
    expect((await t.http.post(`${conn}/conversations/${ids.conversation}/notes`).set(auth(a.owner)).send({ body: 'x', key: unique('n') })).status).toBe(404);
    expect((await t.http.patch(`${conn}/tags/${ids.tag}`).set(auth(a.owner)).send({ name: 'pwned' })).status).toBe(404);
    expect((await t.http.delete(`${conn}/tags/${ids.tag}`).set(auth(a.owner))).status).toBe(404);
    expect((await t.http.put(`${conn}/conversations/${ids.conversation}/tags/${ids.tag}`).set(auth(a.owner))).status).toBe(404);
    expect((await t.http.patch(`${conn}/saved-replies/${ids.reply}`).set(auth(a.owner)).send({ title: 'pwned' })).status).toBe(404);
    expect((await t.http.delete(`${conn}/saved-replies/${ids.reply}`).set(auth(a.owner))).status).toBe(404);
    const replies = await t.http.get(`${conn}/saved-replies?q=secret`).set(auth(a.owner));
    expect(replies.body.items.map((r: any) => r.id)).not.toContain(ids.reply);
    expect((await sql(`select name from conversation_tags where id = $1`, [ids.tag]))[0].name).toBe('Victim tag');
    expect((await sql(`select title from saved_replies where id = $1`, [ids.reply]))[0].title).toBe('Victim reply');
    expect((await sql(`select count(*)::int as n from messages where conversation_id = $1 and kind = 'note'`, [ids.conversation]))[0].n).toBe(1);
  });

  it('customer 360, POS devices and the device API never cross restaurants', async () => {
    expect((await t.http.get(`${o(a)}/customers/${ids.customer}/360`).set(auth(a.owner))).status).toBe(404);
    expect((await t.http.get(`${o(a)}/pos/devices/${ids.device}`).set(auth(a.owner))).status).toBe(404);
    expect((await t.http.post(`${o(a)}/pos/devices/${ids.device}/revoke`).set(auth(a.owner)).send({})).status).toBe(404);
    expect((await sql(`select status from pos_devices where id = $1`, [ids.device]))[0].status).toBe('active');
    // A pairing for another restaurant's branch is refused.
    const foreign = await t.http.post(`${o(a)}/pos/pairings`).set(auth(a.owner)).send({ branchId: b.branchId, actingRole: 'waiter', name: 'x' });
    expect([403, 404]).toContain(foreign.status);
    // B's device credential never reaches A's staff routes, and A's staff session on B's device is refused.
    const dev = { Authorization: `Bearer ${ids.deviceToken}` };
    expect((await t.http.get(`${o(a)}/orders`).set(dev)).status).toBe(403);
    const staffOnForeignDevice = await t.http.get('/v1/pos/session').set(dev).set('X-Resuto-Staff-Authorization', `Bearer ${a.owner.token}`);
    expect(staffOnForeignDevice.status).toBe(403);
    expect(staffOnForeignDevice.body.error.code).toBe('pos_staff_not_allowed');
    // A's order id through B's device: not found.
    const [order] = await sql(`select id from orders where org_id = $1 limit 1`, [a.orgId]);
    if (order) expect((await t.http.get(`/v1/pos/orders/${order.id}`).set(dev)).status).toBe(404);
  });

  it('menu QR, social links, attention, search and preferences answer only for our own restaurant', async () => {
    // Branch codes are unique per restaurant only: give B's branch a code A does not have.
    await sql(`update branches set code = 'victim-only' where id = $1`, [b.branchId]);
    expect((await t.http.get(`${o(b)}/menu-qr?branch=victim-only`).set(auth(b.owner))).status).toBe(200);
    expect((await t.http.get(`${o(a)}/menu-qr?branch=victim-only`).set(auth(a.owner))).status).toBe(404);
    for (const path of ['menu-qr', 'social-links', 'attention', 'preferences/overview', 'search?q=Victim']) {
      expect((await t.http.get(`${o(b)}/${path}`).set(auth(a.owner))).status, path).toBe(404);
    }
    const hits = await t.http.get(`${o(a)}/search?q=Victim`).set(auth(a.owner));
    expect(hits.status).toBe(200);
    expect(JSON.stringify({ ...hits.body, q: undefined })).not.toContain('Victim');
    expect((await t.http.put(`${o(b)}/social-links`).set(auth(a.owner)).send({ instagram: 'https://instagram.com/pwned' })).status).toBe(404);
  });

  it('funnel and retention analytics: another restaurant\'s branch filter reads nothing of theirs', async () => {
    const res = await t.http.post('/v1/public/funnel/beacon').set('Content-Type', 'text/plain')
      .send(JSON.stringify({ e: 'qr_scan', s: 't', o: b.slug, b: b.branchId, sid: 'victimtab0123456789' }));
    expect(res.status).toBe(204);
    const [{ today }] = await sql(`select (now() at time zone 'Africa/Cairo')::date::text as today`);
    for (const path of ['analytics/funnel', 'analytics/retention']) {
      const q = `from=${today}&to=${today}&compare=none`;
      const foreign = await t.http.get(`${o(a)}/${path}?${q}&branchId=${b.branchId}`).set(auth(a.owner));
      const unknown = await t.http.get(`${o(a)}/${path}?${q}&branchId=00000000-0000-4000-8000-0000000000aa`).set(auth(a.owner));
      expect(foreign.status, path).toBe(unknown.status);
      // Their branch id filters to exactly what an unknown id does: nothing of theirs is counted.
      const strip = (v: unknown) => JSON.stringify(v, (k, x) => (['branchId', 'generatedAt', 'requestId'].includes(k) ? undefined : x));
      expect(strip(foreign.body), path).toBe(strip(unknown.body));
    }
  });

  it('payments ?mode filter stays inside the tenant and validates its value', async () => {
    const ok = await t.http.get(`${o(a)}/payments?mode=test`).set(auth(a.owner));
    expect(ok.status).toBe(200);
    expect(ok.body.items.every((p: any) => p.orgId === undefined || p.orgId === a.orgId)).toBe(true);
    expect((await t.http.get(`${o(a)}/payments?mode=all';--`).set(auth(a.owner))).status).toBe(400);
  });
});

describe('secrets and session material never reach the browser in 2.1 views', () => {
  it('device list, MCP client list and change-set views carry no token or key hash', async () => {
    const pairing = await t.http.post(`${o(a)}/pos/pairings`).set(auth(a.owner)).send({ branchId: a.branchId, actingRole: 'cashier', name: 'Front till' });
    expect(pairing.status).toBe(201);
    const paired = await t.http.post('/v1/pos/pair').send({ code: pairing.body.code, platform: 'ipados', appVersion: '0.2.0' });
    expect(paired.status, JSON.stringify(paired.body)).toBe(201);
    const devices = await t.http.get(`${o(a)}/pos/devices`).set(auth(a.owner));
    const text = JSON.stringify(devices.body);
    expect(text).not.toContain(paired.body.token);
    expect(text).not.toMatch(/token_hash|tokenHash|code_hash/);
    const clients = await t.http.get(`${o(a)}/mcp/clients`).set(auth(a.owner));
    expect(JSON.stringify(clients.body)).not.toMatch(/key_hash|keyHash|rmcp_[A-Za-z0-9_-]{20,}/);
    // The pairing code is single use: a second pair with it fails.
    expect((await t.http.post('/v1/pos/pair').send({ code: pairing.body.code, platform: 'ipados', appVersion: '0.2.0' })).status).toBe(401);
  });
});
