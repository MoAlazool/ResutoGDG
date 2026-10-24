// End-to-end: built Resuto API (port 4108, own database) + built MCP server
// (port 7108) + the official MCP SDK client over Streamable HTTP.
// Orders are created through the API's shared order kernel.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const API_DIR = path.join(ROOT, 'apps/api');
const MCP_DIR = path.join(ROOT, 'apps/mcp-server');
const DB_URL = process.env.MCP_E2E_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:54329/resuto_test_e2_mcp';
const API_PORT = Number(process.env.MCP_E2E_API_PORT ?? 4108);
const MCP_PORT = Number(process.env.MCP_E2E_MCP_PORT ?? 7108);
const API = `http://127.0.0.1:${API_PORT}`;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;

const MCP2_PORT = Number(process.env.MCP_E2E_MCP2_PORT ?? MCP_PORT + 10);
const JWT_SECRET = 'e2e-jwt-secret-that-is-at-least-32-characters';

/** An access token as Supabase issues it after a verified TOTP code (aal2), signed with the dev secret the API trusts. */
function aal2Token(userId: string, email: string) {
  const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: userId, email, role: 'authenticated', aal: 'aal2', session_id: randomUUID(),
    aud: 'authenticated', iss: 'resuto-dev-auth', iat: now, exp: now + 600 })}`;
  return `${body}.${createHmac('sha256', JWT_SECRET).update(body).digest('base64url')}`;
}

const API_ENV = {
  NODE_ENV: 'test', PORT: String(API_PORT), DATABASE_URL: DB_URL, AUTH_DEV_MODE: 'true',
  SUPABASE_JWT_SECRET: JWT_SECRET, API_ORIGIN: API, APP_ORIGIN: 'http://127.0.0.1:3108',
  CORS_ORIGINS: 'http://127.0.0.1:3108', STORAGE_LOCAL_DIR: path.join(ROOT, '.local/e2e-mcp-storage'), PAYMENT_MODE: 'sandbox',
};

const procs: ChildProcess[] = [];
const output: string[] = [];
let pool: pg.Pool;
let orgId: string;
let ownerToken: string;
let ownerEmail: string;
let key: string;
let clientId: string;
let today: string;

function start(cmd: string, args: string[], cwd: string, env: Record<string, string>) {
  const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout!.on('data', (d) => output.push(String(d)));
  p.stderr!.on('data', (d) => output.push(String(d)));
  procs.push(p);
  return p;
}

async function waitFor(url: string, ms = 30_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      if ((await fetch(url)).ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${url}\n${output.join('').slice(-4000)}`);
}

async function api(method: string, p: string, body?: unknown, token = ownerToken) {
  const res = await fetch(`${API}/v1${p}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${JSON.stringify(json)}`);
  return json as any;
}

/** Places orders through the API's own order kernel (same code path as every channel). */
async function placeKernelOrders(branchId: string, products: { fries: string; soda: string }) {
  Object.assign(process.env, API_ENV);
  const req = createRequire(path.join(API_DIR, 'package.json'));
  req('reflect-metadata');
  const { NestFactory } = req('@nestjs/core');
  const { AppModule } = req(path.join(API_DIR, 'dist/app.module.js'));
  const { OrdersKernelService } = req(path.join(API_DIR, 'dist/modules/kernel/orders-kernel.service.js'));
  const { DbService } = req(path.join(API_DIR, 'dist/common/db/db.service.js'));
  const { TenantContext } = req(path.join(API_DIR, 'dist/common/auth/context.js'));
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const db = app.get(DbService);
    const kernel = app.get(OrdersKernelService);
    const [owner] = (await pool.query(`select user_id from memberships where org_id = $1 and role = 'owner'`, [orgId])).rows;
    const ctx = new TenantContext(orgId, 'owner', null, owner.user_id, 'user', owner.user_id);
    const place = (productId: string, quantity: number) => db.scoped(ctx, (tx: any) => kernel.place(tx, ctx, {
      branchId, channel: 'staff', fulfillment: 'pickup', lines: [{ productId, quantity }],
    }));
    await place(products.fries, 2); // 2 × 4500
    await place(products.soda, 3);  // 3 × 2500
    const c = await place(products.soda, 1);
    await db.scoped(ctx, (tx: any) => kernel.transition(tx, ctx, c.id, 'cancelled', { reason: 'e2e' }));
  } finally {
    await app.close();
  }
}

function connect(withKey: string | null) {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: withKey ? { headers: { Authorization: `Bearer ${withKey}` } } : undefined,
  });
  const client = new Client({ name: 'resuto-e2e', version: '1.0.0' });
  return { client, transport, ready: client.connect(transport) };
}

beforeAll(async () => {
  // Fresh database, migrated with the repository migrations.
  const { ensureDatabase } = await import(pathToFileURL(path.join(ROOT, 'scripts/db/ensure-db.mjs')).href);
  const { migrate } = await import(pathToFileURL(path.join(ROOT, 'scripts/db/migrate.mjs')).href);
  await ensureDatabase(DB_URL);
  await migrate({ url: DB_URL, reset: true, log: () => {} });
  pool = new pg.Pool({ connectionString: DB_URL, max: 2 });

  // Build both apps (the test runs what ships).
  for (const [cwd, cfg] of [[API_DIR, 'tsconfig.build.json'], [MCP_DIR, 'tsconfig.json']] as const) {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'node_modules/typescript/bin/tsc'), '-p', cfg], { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`build failed in ${cwd}:\n${r.stdout}${r.stderr}`);
  }

  start(process.execPath, ['dist/main.js'], API_DIR, API_ENV);
  await waitFor(`${API}/v1/health`);

  const email = `owner-${Date.now()}@example.test`;
  ownerEmail = email;
  ownerToken = (await api('POST', '/auth/dev/signup', { email, password: 'correct-horse-battery', fullName: 'Owner' }, '')).accessToken;
  const org = await api('POST', '/orgs', { name: 'Koshary Lab', slug: `koshary-${Date.now().toString(36)}`, country: 'EG', planId: 'pro', branch: { name: 'Downtown' } });
  orgId = org.id;
  const [{ id: menuId }] = (await pool.query(`select id from menus where org_id = $1 limit 1`, [orgId])).rows;
  const [{ id: catId }] = (await pool.query(`insert into menu_categories(org_id, menu_id, name) values ($1, $2, 'Mains') returning id`, [orgId, menuId])).rows;
  const product = async (name: string, price: number) => (await pool.query(
    `insert into products(org_id, category_id, name, price_minor, currency) values ($1, $2, $3, $4, 'EGP') returning id`, [orgId, catId, name, price])).rows[0].id;
  const products = { fries: await product('Fries', 4500), soda: await product('Soda', 2500) };
  await placeKernelOrders(org.branchId, products);
  today = (await pool.query(`select (now() at time zone 'Africa/Cairo')::date::text as d`)).rows[0].d;

  const created = await api('POST', `/o/${orgId}/mcp/clients`, {
    name: 'E2E Claude', actingRole: 'manager', rateLimitPerMin: 600,
    allowedTools: ['get_restaurant_profile', 'list_orders', 'get_sales_summary', 'list_top_items', 'create_payment_link', 'get_approval_status'],
  });
  key = created.key;
  clientId = created.id;

  start(process.execPath, ['dist/main.js'], MCP_DIR, { MCP_PORT: String(MCP_PORT), MCP_HOST: '127.0.0.1', RESUTO_API_URL: API, MCP_ALLOW_URL_KEY: 'true' });
  await waitFor(`http://127.0.0.1:${MCP_PORT}/health`);
});

afterAll(async () => {
  for (const p of procs) p.kill('SIGTERM');
  await pool?.end();
});

describe('ResutoMCP over Streamable HTTP', () => {
  it('initializes, lists tools and calls list_orders / get_sales_summary with the SDK client', async () => {
    const { client, transport, ready } = connect(key);
    await ready;
    expect(client.getServerVersion()).toMatchObject({ name: 'resuto', version: '0.1.0' });
    expect(client.getInstructions()).toContain('Koshary Lab');
    expect(transport.sessionId).toMatch(/^[0-9a-f-]{36}$/);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['create_payment_link', 'get_approval_status', 'get_restaurant_profile', 'get_sales_summary', 'list_orders', 'list_top_items']);
    const lo = tools.find((t) => t.name === 'list_orders')!;
    expect(lo.inputSchema.type).toBe('object');
    expect(lo.outputSchema?.type).toBe('object');
    expect(lo.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(tools.find((t) => t.name === 'create_payment_link')!.annotations).toMatchObject({ destructiveHint: true });

    const orders = await client.callTool({ name: 'list_orders', arguments: { limit: 10 } });
    expect(orders.isError).toBeFalsy();
    const items = (orders.structuredContent as any).items;
    expect(items).toHaveLength(3);
    expect(items.map((o: any) => o.status).sort()).toEqual(['cancelled', 'placed', 'placed']);
    expect(items.every((o: any) => o.currency === 'EGP')).toBe(true);

    const summary = await client.callTool({ name: 'get_sales_summary', arguments: { from: today, to: today } });
    expect(summary.isError).toBeFalsy();
    expect(summary.structuredContent).toMatchObject({
      currency: 'EGP', orders: 2, revenueMinor: 9000 + 7500, averageOrderValueMinor: 8250, cancelledOrders: 1, method: 'deterministic_sql',
    });

    const profile = await client.callTool({ name: 'get_restaurant_profile', arguments: {} });
    expect(profile.structuredContent).toMatchObject({ name: 'Koshary Lab', actingRole: 'manager', branchCount: 1 });
    await client.close();
  });

  it('maps validation and permission failures to isError results and sensitive actions to approvals', async () => {
    const { client, ready } = connect(key);
    await ready;
    const bad = await client.callTool({ name: 'list_orders', arguments: { limit: 1000 } });
    expect(bad.isError).toBe(true);
    expect((bad.content as any)[0].text).toContain('invalid_input');
    const notAllowed = await client.callTool({ name: 'search_customers', arguments: { query: 'mona' } });
    expect(notAllowed.isError).toBe(true);
    expect((notAllowed.content as any)[0].text).toContain('tool_not_allowed');
    // Payment links are sensitive: with ResutoPay deployed the call waits for a human approval (not an error).
    const pay = await client.callTool({ name: 'create_payment_link', arguments: { amountMinor: 5000, description: 'Deposit' } });
    expect(pay.isError).toBeFalsy();
    expect((pay.structuredContent as any).approvalId).toEqual(expect.any(String));
    await client.close();

    const calls = (await pool.query(`select tool, outcome, request_id from mcp_tool_calls where client_id = $1 order by id`, [clientId])).rows;
    expect(calls.slice(-3).map((c) => `${c.tool}:${c.outcome}`)).toEqual(
      ['list_orders:invalid_input', 'search_customers:denied', 'create_payment_link:approval_required']);
    // Each tool call carries the MCP server's own X-Request-Id (PS-15), distinct per call and logged on both sides.
    const ids = calls.slice(-3).map((c) => c.request_id);
    expect(ids.every((id) => /^mcp-[0-9a-f-]{36}$/.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(3);
    expect(output.join('')).toContain(ids[2]);
  });

  it('rejects missing, malformed and unknown keys, foreign origins and session hijacking', async () => {
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } };
    const post = (headers: Record<string, string>, body: unknown = init) => fetch(MCP_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body),
    });
    const missing = await post({});
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toContain('Bearer');
    expect((await post({ Authorization: 'Bearer not-a-key' })).status).toBe(401);
    expect((await post({ Authorization: 'Bearer rmcp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' })).status).toBe(401);
    expect((await post({ Authorization: `Bearer ${key}`, Origin: 'https://evil.example' })).status).toBe(403);
    // DNS-rebinding protection: fetch cannot override Host, so use node:http directly.
    const hostStatus = await new Promise<number>((resolve, reject) => {
      const r = httpRequest(MCP_URL, { method: 'POST', headers: { Host: 'evil.example', Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } },
        (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      r.on('error', reject);
      r.end(JSON.stringify(init));
    });
    expect(hostStatus).toBe(403);
    expect((await post({ Authorization: `Bearer ${key}` }, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).status).toBe(400);

    const bogus = connect('rmcp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    await expect(bogus.ready).rejects.toThrow();
    const none = connect(null);
    await expect(none.ready).rejects.toThrow();

    // A session opened with key A cannot be driven with key B.
    const other = await api('POST', `/o/${orgId}/mcp/clients`, { name: 'Other', actingRole: 'cashier', allowedTools: ['list_orders'] });
    const a = connect(key);
    await a.ready;
    const hijack = await post({ Authorization: `Bearer ${other.key}`, 'Mcp-Session-Id': a.transport.sessionId!, 'Mcp-Protocol-Version': '2025-06-18' },
      { jsonrpc: '2.0', id: 3, method: 'tools/list' });
    expect(hijack.status).toBe(403);
    await a.client.close();
  });

  it('stops working immediately when the key is revoked', async () => {
    const created = await api('POST', `/o/${orgId}/mcp/clients`, { name: 'Short-lived', actingRole: 'manager', allowedTools: ['list_orders'] });
    const { client, ready } = connect(created.key);
    await ready;
    expect((await client.callTool({ name: 'list_orders', arguments: {} })).isError).toBeFalsy();
    await api('POST', `/o/${orgId}/mcp/clients/${created.id}/revoke`);
    const after = await client.callTool({ name: 'list_orders', arguments: {} });
    expect(after.isError).toBe(true);
    expect((after.content as any)[0].text).toContain('unauthorized');
    await client.close();
  });

  it('accepts the key in the URL path when MCP_ALLOW_URL_KEY is enabled (header-less connectors)', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${MCP_URL}/${key}`));
    const client = new Client({ name: 'resuto-e2e-url', version: '1.0.0' });
    await client.connect(transport);
    const res = await client.callTool({ name: 'list_orders', arguments: { limit: 1 } });
    expect((res.structuredContent as any).items).toHaveLength(1);
    await client.close();
    const other = await api('POST', `/o/${orgId}/mcp/clients`, { name: 'Mismatch', actingRole: 'cashier', allowedTools: ['list_orders'] });
    const mismatch = await fetch(`${MCP_URL}/${key}`, { method: 'POST', headers: { Authorization: `Bearer ${other.key}`, 'Content-Type': 'application/json' }, body: '{}' });
    expect(mismatch.status).toBe(401);
  });

  it('works over stdio for local clients (RESUTO_MCP_KEY)', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath, args: [path.join(MCP_DIR, 'dist/main.js'), '--stdio'], cwd: MCP_DIR, stderr: 'pipe',
      env: { PATH: process.env.PATH ?? '', RESUTO_API_URL: API, RESUTO_MCP_KEY: key },
    });
    const client = new Client({ name: 'resuto-e2e-stdio', version: '1.0.0' });
    await client.connect(transport);
    const res = await client.callTool({ name: 'get_sales_summary', arguments: { from: today, to: today } });
    expect(res.structuredContent).toMatchObject({ orders: 2, revenueMinor: 16500 });
    await client.close();
  });

  it('serves a health endpoint (with an optional API check)', async () => {
    const shallow = await fetch(`http://127.0.0.1:${MCP_PORT}/health`);
    const body = await shallow.json();
    expect(body).toMatchObject({ status: 'ok', service: 'resuto-mcp' });
    // CR-07: the deployed commit is visible in the body and on every response.
    expect(Object.keys(body.build).sort()).toEqual(['branch', 'builtAt', 'commit', 'startedAt']);
    expect(shallow.headers.get('x-build')).toMatch(/^mcp@([0-9a-f]{12}|local)$/);
    const deep = await fetch(`http://127.0.0.1:${MCP_PORT}/health?deep=1`);
    expect(await deep.json()).toMatchObject({ status: 'ok', api: 'ok', apiBuild: expect.stringMatching(/^api@/) });
  });
});

// 21-MCP: the write path end to end with the official SDK client. A connection made from permission groups reads the
// menu, proposes the "Eid offers" change set (a website section with three dishes, a 15% offer, publishing) with
// propose_changes, which waits for approval; the owner (who has a verified authenticator) approves through the API with
// an MFA-verified session; the set is applied and get_approval_status reports it; every step is audited. A second MCP
// server instance continues the same session (sessions live in the API database). Runs last: it enrols the owner's MFA.
describe('change sets through MCP (21-MCP)', () => {
  let groupKey: string;
  let groupClientId: string;
  let burger: string;

  beforeAll(async () => {
    const [{ id: catId }] = (await pool.query(`select id from menu_categories where org_id = $1 limit 1`, [orgId])).rows;
    burger = (await pool.query(`insert into products(org_id, category_id, name, price_minor, currency) values ($1, $2, 'Burger', 18500, 'EGP') returning id`,
      [orgId, catId])).rows[0].id;
    const created = await api('POST', `/o/${orgId}/mcp/clients`, {
      name: 'E2E Eid assistant', actingRole: 'manager', rateLimitPerMin: 600, groups: ['menu', 'website_drafts', 'website_publish', 'promotions'],
    });
    groupKey = created.key;
    groupClientId = created.id;
    expect(created.groups).toEqual(['menu', 'website_drafts', 'website_publish', 'promotions']);
    start(process.execPath, ['dist/main.js'], MCP_DIR, { MCP_PORT: String(MCP2_PORT), MCP_HOST: '127.0.0.1', RESUTO_API_URL: API });
    await waitFor(`http://127.0.0.1:${MCP2_PORT}/health`);
  });

  it('connect → read → propose_changes (Eid) → approval_required → approve with MFA → applied → get_approval_status → audit', async () => {
    const { client, ready } = connect(groupKey);
    await ready;
    const { tools } = await client.listTools();
    const names = tools.map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(['list_menu', 'propose_changes', 'draft_website_change', 'publish_website_revision', 'create_promotion',
      'get_website_draft', 'get_approval_status']));
    expect(names).not.toContain('list_orders');
    expect(tools.find((x) => x.name === 'propose_changes')!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });

    // Read.
    const menu = await client.callTool({ name: 'list_menu', arguments: {} });
    expect(menu.isError).toBeFalsy();
    const ids = (menu.structuredContent as any).items.map((i: any) => i.productId);
    expect(ids).toHaveLength(3);
    expect(ids).toContain(burger);
    const draft = await client.callTool({ name: 'get_website_draft', arguments: {} });
    const publishedBefore = (draft.structuredContent as any).publishedRevision;

    // Propose the Eid set: nothing changes until a person approves the 15% offer.
    const proposed = await client.callTool({ name: 'propose_changes', arguments: {
      title: 'Eid offers', summary: 'Eid section with three dishes at 15% off', idempotencyKey: `eid-${Date.now()}`,
      ops: [
        { type: 'website.section.add', input: { kind: 'menu_highlights', content: { headline: { en: 'Eid offers', ar: 'عروض العيد' }, productIds: ids } } },
        { type: 'promotion.create', input: { name: 'Eid 15', nameAr: 'خصم العيد', code: 'EID15', kind: 'percent', value: 1500 } },
        { type: 'website.publish', input: { note: 'Eid' } },
      ],
    } });
    expect(proposed.isError, JSON.stringify(proposed.content)).toBeFalsy();
    const out = proposed.structuredContent as any;
    expect(out).toMatchObject({ status: 'approval_required', policy: { mode: 'approval', requiresOwner: false } });
    expect(out.ops.map((o: any) => o.type)).toEqual(['website.section.add', 'promotion.create', 'website.publish']);
    expect((proposed.content as any)[0].text).toContain('must approve');
    const changeSetId: string = out.changeSetId;
    expect((await pool.query(`select count(*)::int as n from promotions where org_id = $1 and code = 'EID15'`, [orgId])).rows[0].n).toBe(0);
    const waiting = await client.callTool({ name: 'get_approval_status', arguments: { approvalId: changeSetId } });
    expect(waiting.structuredContent).toMatchObject({ status: 'pending', changeSetStatus: 'pending_approval', tool: 'propose_changes' });

    // The owner has a verified authenticator: approving needs an MFA-verified (aal2) session.
    const [owner] = (await pool.query(`select user_id from memberships where org_id = $1 and role = 'owner'`, [orgId])).rows;
    await pool.query(`insert into auth.mfa_factors(user_id, friendly_name, factor_type, status) values ($1, 'Authenticator app', 'totp', 'verified')`, [owner.user_id]);
    const aal1 = await fetch(`${API}/v1/o/${orgId}/change-sets/${changeSetId}/approve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` }, body: '{}' });
    expect(aal1.status).toBe(403);
    expect((await aal1.json()).error.code).toBe('mfa_required');
    const verified = aal2Token(owner.user_id, ownerEmail);
    const view = await api('GET', `/o/${orgId}/change-sets/${changeSetId}`, undefined, verified);
    expect(view).toMatchObject({ origin: 'mcp', status: 'pending_approval', sourceTool: 'propose_changes', actor: { type: 'mcp_client', mcpClientId: groupClientId } });
    const approved = await api('POST', `/o/${orgId}/change-sets/${changeSetId}/approve`, { note: 'Eid', previewDigest: view.previewDigest }, verified);
    expect(approved.status).toBe('applied');

    // Executed: the offer exists and the website was published with the section.
    expect((await pool.query(`select kind, value from promotions where org_id = $1 and code = 'EID15'`, [orgId])).rows).toEqual([{ kind: 'percent', value: 1500 }]);
    const [w] = (await pool.query(`select published_revision from websites where org_id = $1`, [orgId])).rows;
    expect(w.published_revision).toBe(publishedBefore + 1);
    const status = await client.callTool({ name: 'get_approval_status', arguments: { approvalId: changeSetId } });
    expect(status.structuredContent).toMatchObject({ status: 'executed', changeSetStatus: 'applied' });

    // Audit: every transition and op, the approver's MFA level, and the connection's call log.
    const actions = (await pool.query(`select action from audit_logs where entity_type = 'change_set' and entity_id = $1 order by id`, [changeSetId])).rows.map((r) => r.action);
    expect(actions).toEqual(['change_set.draft', 'change_op.proposed', 'change_op.proposed', 'change_op.proposed', 'change_set.validated',
      'change_set.pending_approval', 'change_set.approved', 'change_set.applying', 'change_op.applied', 'change_op.applied', 'change_op.applied', 'change_set.applied']);
    expect((await pool.query(`select aal, role from change_decisions where change_set_id = $1`, [changeSetId])).rows).toEqual([{ aal: 'aal2', role: 'owner' }]);
    const calls = (await pool.query(`select tool, outcome, via, change_set_id from mcp_tool_calls where client_id = $1 and tool = 'propose_changes' order by id`,
      [groupClientId])).rows;
    expect(calls).toEqual([
      { tool: 'propose_changes', outcome: 'approval_required', via: 'mcp', change_set_id: changeSetId },
      { tool: 'propose_changes', outcome: 'ok', via: 'approval', change_set_id: changeSetId },
    ]);
    await client.close();
  });

  it('continues a session on another MCP server instance (sessions live in the API database)', async () => {
    const first = connect(groupKey);
    await first.ready;
    const sid = first.transport.sessionId!;
    expect(sid).toMatch(/^[0-9a-f-]{36}$/);
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${groupKey}`,
      'Mcp-Session-Id': sid, 'Mcp-Protocol-Version': '2025-06-18' };
    const other = await fetch(`http://127.0.0.1:${MCP2_PORT}/mcp`, { method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'get_restaurant_profile', arguments: {} } }) });
    expect(other.status).toBe(200);
    expect(await other.text()).toContain('Koshary Lab');
    expect((await pool.query(`select client_id from mcp_sessions where id = $1`, [sid])).rows).toEqual([{ client_id: groupClientId }]);
    // Closed on the second instance: the session is gone for every instance.
    expect((await fetch(`http://127.0.0.1:${MCP2_PORT}/mcp`, { method: 'DELETE', headers })).status).toBe(200);
    const again = await fetch(`http://127.0.0.1:${MCP2_PORT}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }) });
    expect(again.status).toBe(404);
    await first.client.close().catch(() => undefined);
  });
});
