// Shared support for the end-to-end business scenarios (Agent G, docs/qa/SCENARIOS.md).
// Everything here goes through HTTP endpoints; SQL is used only to read state.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { expect } from 'vitest';
import { auth, sql, type TestApp, type TestTenant, type TestUser } from '../helpers';
import { key } from '../ops-fixtures';

export { key };

/** A restaurant menu built through the menu API (bilingual names, modifiers, costs). */
export interface ApiMenu {
  categoryId: string;
  drinksCategoryId: string;
  burger: string; fries: string; soda: string;
  size: string; extras: string;
  regular: string; large: string; cheese: string; bacon: string;
}

export const PRICES = { burger: 18500, fries: 4500, soda: 2500, large: 3000, cheese: 1500, bacon: 2500 } as const;
export const COSTS = { burger: 5500, fries: 1350, soda: 750 } as const;

export async function buildMenuViaApi(t: TestApp, tenant: TestTenant, as: TestUser = tenant.owner): Promise<ApiMenu> {
  const base = `/v1/o/${tenant.orgId}/menu`;
  const ok = (res: { status: number; body: any }, status = 201) => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    return res.body;
  };
  const mains = ok(await t.http.post(`${base}/categories`).set(auth(as)).send({ name: 'Mains', nameAr: 'الأطباق الرئيسية', defaultStation: 'Grill' }));
  const drinks = ok(await t.http.post(`${base}/categories`).set(auth(as)).send({ name: 'Drinks', nameAr: 'المشروبات', defaultStation: 'Bar' }));
  const product = async (categoryId: string, name: string, nameAr: string, priceMinor: number, costMinor: number, extra: Record<string, unknown> = {}) =>
    ok(await t.http.post(`${base}/products`).set(auth(as)).send({ categoryId, name, nameAr, priceMinor, costMinor, ...extra })).id as string;
  const burger = await product(mains.id, 'Smash burger', 'برجر سماش', PRICES.burger, COSTS.burger, { allergens: ['wheat', 'milk'], prepMinutes: 12 });
  const fries = await product(mains.id, 'Fries', 'بطاطس مقلية', PRICES.fries, COSTS.fries, { station: 'Fryer', dietary: ['vegetarian'] });
  const soda = await product(drinks.id, 'Soda', 'مشروب غازي', PRICES.soda, COSTS.soda);
  const size = ok(await t.http.post(`${base}/modifier-groups`).set(auth(as)).send({ name: 'Size', nameAr: 'الحجم', minSelect: 1, maxSelect: 1 }));
  const extras = ok(await t.http.post(`${base}/modifier-groups`).set(auth(as)).send({ name: 'Extras', nameAr: 'إضافات', minSelect: 0, maxSelect: 2 }));
  const option = async (groupId: string, name: string, nameAr: string, priceDeltaMinor: number) => {
    const g = ok(await t.http.post(`${base}/modifier-groups/${groupId}/options`).set(auth(as)).send({ name, nameAr, priceDeltaMinor }));
    return g.options.find((o: any) => o.name === name).id as string;
  };
  const regular = await option(size.id, 'Regular', 'عادي', 0);
  const large = await option(size.id, 'Large', 'كبير', PRICES.large);
  const cheese = await option(extras.id, 'Cheese', 'جبنة', PRICES.cheese);
  const bacon = await option(extras.id, 'Bacon', 'بيكون', PRICES.bacon);
  ok(await t.http.put(`${base}/products/${burger}/modifier-groups`).set(auth(as)).send({ groupIds: [size.id, extras.id] }), 200);
  return { categoryId: mains.id, drinksCategoryId: drinks.id, burger, fries, soda, size: size.id, extras: extras.id, regular, large, cheese, bacon };
}

export const burgerLine = (m: ApiMenu, quantity = 1, opts: { large?: boolean; cheese?: boolean } = {}) => ({
  productId: m.burger, quantity,
  modifiers: [
    { groupId: m.size, optionId: opts.large ? m.large : m.regular },
    ...(opts.cheese ? [{ groupId: m.extras, optionId: m.cheese }] : []),
  ],
});

/** Pays a ResutoPay checkout through the simulated provider: start → sandbox complete (signed webhook path). */
export async function payViaSandbox(t: TestApp, checkoutToken: string, outcome: 'success' | 'failure' = 'success', method = 'card') {
  const start = await t.http.post(`/v1/public/pay/${checkoutToken}/start`).send({ method });
  expect(start.status, JSON.stringify(start.body)).toBe(200);
  expect(start.body).toMatchObject({ kind: 'redirect', sandbox: true });
  const done = await t.http.post(`/v1/public/pay/${checkoutToken}/sandbox/complete`).send({ outcome });
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  return { start: start.body, view: done.body };
}

export const tokenFromUrl = (url: string, marker: '/pay/' | '/s/' | '/o/' | '/t/') => url.split(marker)[1]!;

export async function outboundMessages(conversationId: string) {
  return sql<{ id: string; kind: string; body: string; payload: any; status: string }>(
    `select id, kind, body, payload, status from messages where conversation_id = $1 and direction = 'outbound' order by created_at, id`, [conversationId]);
}

export async function cairoToday(): Promise<string> {
  return (await sql(`select (now() at time zone 'Africa/Cairo')::date::text as d`))[0].d;
}

export const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// ---------------------------------------------------------------------------
// The real Python AI service as a subprocess (no mocks), on a port of our own.
// ---------------------------------------------------------------------------
const portFree = (port: number) => new Promise<boolean>((resolve) => {
  const s = net.createServer().once('error', () => resolve(false)).once('listening', () => s.close(() => resolve(true))).listen(port, '127.0.0.1');
});

export async function startAiService(port: number, token: string): Promise<ChildProcess> {
  const dir = path.resolve(process.cwd(), '../ai-service');
  const py = path.join(dir, '.venv/bin/python');
  if (!fs.existsSync(py)) throw new Error(`AI service virtualenv missing (${py}). Run: cd apps/ai-service && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`);
  if (!(await portFree(port))) throw new Error(`Port ${port} is already in use`);
  let log = '';
  const proc = spawn(py, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(port), '--log-level', 'warning'],
    { cwd: dir, env: { ...process.env, AI_SERVICE_TOKEN: token, AI_SERVICE_ALLOW_NO_AUTH: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout!.on('data', (d) => { log += d; });
  proc.stderr!.on('data', (d) => { log += d; });
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`AI service exited (${proc.exitCode}):\n${log}`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/v1/health`)).ok) return proc;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  proc.kill('SIGTERM');
  throw new Error(`AI service did not become healthy:\n${log}`);
}
