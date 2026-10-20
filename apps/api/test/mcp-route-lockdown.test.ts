import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IS_PUBLIC } from '../src/common/auth/decorators';
import { auth, bootTestApp, createTenant, seedMenu, sql, type SeededMenu, type TestApp, type TestTenant } from './helpers';

// An MCP client key (rmcp_...) may reach ONLY the MCP runtime: whoami, the tool list and tool calls. Everything a
// client does must pass the tool path (allow-list, approvals for sensitive tools, per-tool limits, PII masking,
// output caps and the mcp_tool_calls audit). Audit FT-01/PS-03: @AllowMcp REST routes let a key restricted to
// list_orders create payment links, change availability and transition orders directly.

const RUNTIME = new Set(['GET /v1/mcp/whoami', 'GET /v1/o/:orgId/mcp/tools', 'POST /v1/o/:orgId/mcp/tools/:tool']);
const VERBS: Partial<Record<RequestMethod, 'get' | 'post' | 'put' | 'patch' | 'delete'>> = {
  [RequestMethod.GET]: 'get', [RequestMethod.POST]: 'post', [RequestMethod.PUT]: 'put',
  [RequestMethod.PATCH]: 'patch', [RequestMethod.DELETE]: 'delete',
};

interface Route { verb: 'get' | 'post' | 'put' | 'patch' | 'delete'; path: string; isPublic: boolean }

/** Every HTTP route the application registers, read from Nest's controller metadata. */
function enumerateRoutes(t: TestApp): Route[] {
  const discovery = t.app.get(DiscoveryService);
  const scanner = t.app.get(MetadataScanner);
  const reflector = t.app.get(Reflector);
  const routes: Route[] = [];
  const join = (...parts: string[]) => `/${parts.map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/')}`;
  for (const wrapper of discovery.getControllers()) {
    const cls = wrapper.metatype as any;
    if (!cls) continue;
    const base = [Reflect.getMetadata(PATH_METADATA, cls) ?? ''].flat() as string[];
    for (const name of scanner.getAllMethodNames(cls.prototype)) {
      const handler = cls.prototype[name];
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
      if (method === undefined) continue;
      const verb = VERBS[method];
      if (!verb) throw new Error(`unexpected HTTP method ${method} on ${cls.name}.${name}`);
      const isPublic = !!reflector.getAllAndOverride<boolean>(IS_PUBLIC, [handler, cls]);
      for (const b of base) for (const p of [Reflect.getMetadata(PATH_METADATA, handler) ?? ''].flat() as string[]) {
        routes.push({ verb, path: join('v1', b, p), isPublic });
      }
    }
  }
  return routes;
}

let t: TestApp;
let a: TestTenant;
let menu: SeededMenu;
let mcpKey: string;
let routes: Route[];

beforeAll(async () => {
  t = await bootTestApp();
  a = await createTenant(t, { name: 'Lockdown Grill' });
  menu = await seedMenu(a);
  // A manager-level key that may only list orders: anything else must be refused.
  const res = await t.http.post(`/v1/o/${a.orgId}/mcp/clients`).set(auth(a.owner))
    .send({ name: 'Restricted assistant', actingRole: 'manager', allowedTools: ['list_orders'], rateLimitPerMin: 600 });
  expect(res.status).toBe(201);
  mcpKey = res.body.key;
  routes = enumerateRoutes(t);
});
afterAll(async () => { await t?.close(); });

const asMcp = (verb: Route['verb'], path: string) => t.http[verb](path).set({ Authorization: `Bearer ${mcpKey}` });

describe('MCP client keys reach only the MCP runtime', () => {
  it('enumerates the application routes', () => {
    expect(routes.length).toBeGreaterThan(150);
    for (const r of RUNTIME) expect(routes.some((x) => `${x.verb.toUpperCase()} ${x.path}` === r)).toBe(true);
  });

  it('refuses an MCP key on every authenticated route outside the runtime (403 before any handler runs)', async () => {
    const fill = (path: string) => path
      .replace(':orgId', a.orgId)
      .replace(/\*\w+/g, 'x/y.png')
      .replace(/:(\w+)/g, '6f1c2a40-0000-4000-8000-0000000000ff');
    const leaks: string[] = [];
    for (const r of routes) {
      if (r.isPublic || RUNTIME.has(`${r.verb.toUpperCase()} ${r.path}`)) continue;
      const res = await asMcp(r.verb, fill(r.path)).send({});
      if (res.status !== 403 || res.body?.error?.code !== 'mcp_runtime_only') leaks.push(`${r.verb.toUpperCase()} ${r.path} -> ${res.status} ${res.body?.error?.code ?? ''}`);
    }
    expect(leaks).toEqual([]);
  });

  it('does not let a list_orders-only key change availability, transition orders or create payment links over REST', async () => {
    const before = await sql(`select count(*)::int as n from checkout_sessions where org_id = $1`, [a.orgId]);
    const avail = await asMcp('post', `/v1/o/${a.orgId}/menu/products/${menu.products.fries}/availability`)
      .send({ branchId: a.branchId, available: false });
    expect(avail.status).toBe(403);
    const link = await asMcp('post', `/v1/o/${a.orgId}/payments/links`).send({ amountMinor: 5000, description: 'Deposit' });
    expect(link.status).toBe(403);
    const reservations = await asMcp('get', `/v1/o/${a.orgId}/reservations?date=2030-01-01`);
    expect(reservations.status).toBe(403);
    expect(await sql(`select count(*)::int as n from checkout_sessions where org_id = $1`, [a.orgId])).toEqual(before);
    const [setting] = await sql(`select is_available from product_branch_settings where product_id = $1 and branch_id = $2`,
      [menu.products.fries, a.branchId]);
    expect(setting?.is_available ?? true).toBe(true);
  });

  it('still serves the runtime: whoami, the allowed tool list and an allowed tool call; other tools stay blocked', async () => {
    expect((await asMcp('get', '/v1/mcp/whoami')).status).toBe(200);
    const tools = await asMcp('get', `/v1/o/${a.orgId}/mcp/tools`);
    expect(tools.status).toBe(200);
    expect(tools.body.items.map((x: { name: string }) => x.name)).toEqual(['list_orders']);
    expect((await asMcp('post', `/v1/o/${a.orgId}/mcp/tools/list_orders`).send({ input: {} })).status).toBe(200);
    const denied = await asMcp('post', `/v1/o/${a.orgId}/mcp/tools/create_payment_link`).send({ input: { amountMinor: 100, description: 'x' } });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('tool_not_allowed');
  });

  it('keeps staff tokens working on the same REST routes', async () => {
    expect((await t.http.get(`/v1/o/${a.orgId}/reservations?date=2030-01-01`).set(auth(a.owner))).status).toBe(200);
    expect((await t.http.get(`/v1/o/${a.orgId}`).set(auth(a.owner))).status).toBe(200);
  });
});
