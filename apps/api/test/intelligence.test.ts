import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { formatMoney, renderInsight } from '@resuto/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantContext } from '../src/common/auth/context';
import { DbService } from '../src/common/db/db.service';
import { EventDispatcher } from '../src/common/events/dispatcher.service';
import { OrdersKernelService } from '../src/modules/kernel/orders-kernel.service';
import { AssistantService, isGrounded, numbersIn, routeIntent } from '../src/modules/intelligence/assistant.service';
import type { GeminiContent, LlmClient } from '../src/modules/intelligence/gemini.client';
import { InsightsService } from '../src/modules/intelligence/insights.service';
import { addMember, auth, bootTestApp, createTenant, seedMenu, sql, type SeededMenu, type TestApp, type TestTenant, type TestUser } from './helpers';

// ---------------------------------------------------------------------------
// The real Python AI service runs as a subprocess (no mocks). If it cannot start, the suite fails.
// ---------------------------------------------------------------------------
// AI_TEST_PORT lets concurrent runs on one machine use different ports (the default stays 8107).
const AI_PORT = Number(process.env.AI_TEST_PORT ?? 8107);
const AI_TOKEN = 'e1-integration-test-token-0123456789';
let ai: ChildProcess | null = null;

const portFree = (port: number) => new Promise<boolean>((resolve) => {
  const s = net.createServer().once('error', () => resolve(false)).once('listening', () => s.close(() => resolve(true))).listen(port, '127.0.0.1');
});

async function startAiService() {
  const dir = path.resolve(process.cwd(), '../ai-service');
  const py = path.join(dir, '.venv/bin/python');
  if (!fs.existsSync(py)) throw new Error(`AI service virtualenv missing (${py}). Run: cd apps/ai-service && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`);
  if (!(await portFree(AI_PORT))) throw new Error(`Port ${AI_PORT} is already in use; stop the process using it before running the intelligence tests`);
  let log = '';
  ai = spawn(py, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(AI_PORT), '--log-level', 'warning'],
    { cwd: dir, env: { ...process.env, AI_SERVICE_TOKEN: AI_TOKEN, AI_SERVICE_ALLOW_NO_AUTH: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  ai.stdout!.on('data', (d) => { log += d; });
  ai.stderr!.on('data', (d) => { log += d; });
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    if (ai.exitCode !== null) throw new Error(`AI service exited (${ai.exitCode}):\n${log}`);
    try {
      const r = await fetch(`http://127.0.0.1:${AI_PORT}/v1/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`AI service did not become healthy:\n${log}`);
}

let t: TestApp;
let down: TestApp;
let A: TestTenant;
let B: TestTenant;
let menu: SeededMenu;
let ctxA: TenantContext;
let cashier: TestUser;
let marketing: TestUser;
let today: string;
let yesterday: string;
const customers: Record<string, string> = {};
let driverId: string;
let yesterdayRevenue = 0;

const day = (offset: number) => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};
const dow = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay(); // 0 = Sunday

beforeAll(async () => {
  await startAiService();
  process.env.AI_SERVICE_URL = `http://127.0.0.1:${AI_PORT}`;
  process.env.AI_SERVICE_TOKEN = AI_TOKEN;
  delete process.env.GEMINI_API_KEY;
  t = await bootTestApp();
  A = await createTenant(t, { country: 'EG', planId: 'pro', name: 'Koshary Lab' });
  B = await createTenant(t, { country: 'SA', planId: 'pro' });
  menu = await seedMenu(A);
  cashier = await addMember(t, A, 'cashier');
  marketing = await addMember(t, A, 'marketing');
  ctxA = new TenantContext(A.orgId, 'owner', null, A.owner.userId, 'user', A.owner.userId);
  [{ today }] = await sql(`select (now() at time zone 'Africa/Cairo')::date::text as today`);
  yesterday = day(-1);

  const db = t.app.get(DbService);
  const kernel = t.app.get(OrdersKernelService);
  await sql(`update product_branch_settings set stock_qty = 100000 where product_id = $1`, [menu.products.limited]);
  await sql(`update branches set latitude = 30.0444, longitude = 31.2357 where id = $1`, [A.branchId]);
  const burgerLine = (q: number) => ({ productId: menu.products.burger, quantity: q, modifiers: [{ groupId: menu.groups.size, optionId: menu.options.regular }] });
  const place = async (date: string, hour: number, lines: any[], opts: { customer?: string; readyMinutes?: number; fulfillment?: 'pickup' | 'delivery' } = {}) => {
    const phone = opts.customer ? `+2010${String(Object.keys(customers).indexOf(opts.customer) + 10).padStart(8, '0')}` : null;
    const o = await db.scoped(ctxA, (tx) => kernel.place(tx, ctxA, {
      branchId: A.branchId, channel: 'staff', fulfillment: opts.fulfillment ?? 'pickup', lines,
      customer: opts.customer ? { name: opts.customer, phone } : null,
      deliveryAddress: opts.fulfillment === 'delivery' ? { line1: `${opts.customer} street` } : null,
    }));
    if (opts.customer && !customers[opts.customer]) customers[opts.customer] = o.customerId!;
    await sql(`update orders set business_date = $2::date, placed_at = ($2::date + make_interval(hours => $3)) at time zone 'Africa/Cairo',
                 ready_at = case when $4::int is null then null else ($2::date + make_interval(hours => $3, mins => $4)) at time zone 'Africa/Cairo' end
               where id = $1`, [o.id, date, hour, opts.readyMinutes ?? null]);
    return o;
  };
  for (const c of ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'vip', 'newbie']) customers[c] = '';

  // 120 days of history ending yesterday. Weekend (Thu evening / Fri) uplift on burgers; fries co-occur with burgers.
  for (let d = 120; d >= 2; d--) {
    const date = day(-d);
    const wk = [4, 5].includes(dow(date));
    const b = wk ? 5 : 3;
    const lines: any[] = [burgerLine(b), { productId: menu.products.fries, quantity: b - 1 }, { productId: menu.products.soda, quantity: 1 }];
    if (d <= 30) lines.push({ productId: menu.products.limited, quantity: 2 });
    await place(date, 13, lines, { customer: `c${d % 8}`, readyMinutes: d <= 15 ? 10 : undefined });
    if (d >= 70 && d % 4 === 0) await place(date, 20, [burgerLine(8), { productId: menu.products.fries, quantity: 6 }], { customer: 'vip' });
  }
  await place(day(-2), 19, [{ productId: menu.products.soda, quantity: 1 }], { customer: 'newbie' });
  // Yesterday: a soda spike, a revenue drop and a slow kitchen.
  await place(yesterday, 13, [{ productId: menu.products.soda, quantity: 12 }], { customer: 'c1', readyMinutes: 25 });
  for (let i = 0; i < 3; i++) await place(yesterday, 14 + i, [{ productId: menu.products.soda, quantity: 1 }], { readyMinutes: 26 });
  await sql(`update product_branch_settings set stock_qty = 3 where product_id = $1`, [menu.products.limited]);
  [{ revenue: yesterdayRevenue }] = await sql(`select sum(total_minor)::int as revenue from orders where org_id = $1 and business_date = $2`, [A.orgId, yesterday]);

  // Three delivery orders today with drop-offs at increasing distance, assigned to one driver.
  const [drv] = await sql(`insert into drivers(org_id, display_name, status, availability) values ($1, 'Driver One', 'active', 'busy') returning id`, [A.orgId]);
  driverId = drv.id;
  const drops = [[30.1000, 31.2357], [30.0500, 31.2357], [30.0700, 31.2357]];
  for (let i = 0; i < drops.length; i++) {
    const o = await db.scoped(ctxA, (tx) => kernel.place(tx, ctxA, {
      branchId: A.branchId, channel: 'staff', fulfillment: 'delivery', lines: [{ productId: menu.products.fries, quantity: 1 }],
      customer: { name: `Delivery ${i}`, phone: `+20111000000${i}` }, deliveryAddress: { line1: `Street ${i}` },
    }));
    await sql(`insert into delivery_jobs(org_id, branch_id, order_id, driver_id, status, dropoff, dropoff_latitude, dropoff_longitude)
               values ($1, $2, $3, $4, 'assigned', $5, $6, $7)`, [A.orgId, A.branchId, o.id, driverId, { line1: `Street ${i}` }, drops[i]![0], drops[i]![1]]);
  }
}, 240_000);

afterAll(async () => {
  await t?.close();
  await down?.close();
  ai?.kill('SIGTERM');
});

const base = () => `/v1/o/${A.orgId}/intelligence`;

describe('demand forecast (end to end on kernel-created orders)', () => {
  it('forecasts the top items with intervals, model selection and backtest metrics', async () => {
    const res = await t.http.get(`${base()}/forecast`).query({ branchId: A.branchId, horizon: 14, top: 3 }).set(auth(A.owner));
    expect(res.status).toBe(200);
    expect(res.body.asOf).toBe(yesterday);
    expect(res.body.isSyntheticData).toBe(false);
    expect(res.body.calendar.weekendDays).toEqual(['fri', 'sat']);
    const burger = res.body.items.find((i: any) => i.productId === menu.products.burger);
    expect(burger.name).toBe('Smash burger');
    expect(burger.forecast).toHaveLength(14);
    expect(burger.forecast[0].date).toBe(today);
    for (const p of burger.forecast) expect(p.lower <= p.yhat && p.yhat <= p.upper).toBe(true);
    expect(burger.candidates.map((c: any) => c.model).sort()).toEqual(['hist_gbm', 'moving_average_28', 'seasonal_naive_7']);
    const gbm = burger.candidates.find((c: any) => c.model === 'hist_gbm');
    expect(gbm.metrics.n).toBeGreaterThan(0); // 120 days of history: the gradient-boosting model is eligible
    const chosen = burger.candidates.find((c: any) => c.model === burger.model);
    for (const c of burger.candidates) expect(chosen.metrics.wape).toBeLessThanOrEqual(c.metrics.wape);
    expect(burger.coverage).toMatchObject({ end: yesterday, days: 120, nonZeroDays: 119 });
    const [pred] = await sql(`select count(*)::int as n from ai_predictions where org_id = $1 and kind = 'demand_forecast' and subject_id = $2`, [A.orgId, menu.products.burger]);
    expect(pred.n).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it('falls back to a baseline with a reason on short history', async () => {
    const res = await t.http.get(`${base()}/forecast`).query({ branchId: A.branchId, productId: menu.products.limited, horizon: 7 }).set(auth(A.owner));
    expect(res.status).toBe(200);
    const [item] = res.body.items;
    expect(['seasonal_naive_7', 'moving_average_28']).toContain(item.model);
    expect(item.fallbackReason).toMatch(/^history_too_short/);
  });

  it('DF-05: marks generated demo history as synthetic and real history as not', async () => {
    const q = { branchId: A.branchId, productId: menu.products.limited, horizon: 7 };
    const real = await t.http.get(`${base()}/forecast`).query(q).set(auth(A.owner));
    expect(real.body).toMatchObject({ isSyntheticData: false, syntheticReason: null });
    await sql(`update organizations set onboarding = onboarding || '{"demo": true}'::jsonb where id = $1`, [A.orgId]);
    try {
      const demo = await t.http.get(`${base()}/forecast`).query(q).set(auth(A.owner));
      expect(demo.status).toBe(200);
      expect(demo.body).toMatchObject({ isSyntheticData: true, syntheticReason: 'demo_tenant' });
    } finally {
      await sql(`update organizations set onboarding = onboarding - 'demo' where id = $1`, [A.orgId]);
    }
  });

  it('validates input and enforces tenancy', async () => {
    expect((await t.http.get(`${base()}/forecast`).query({ branchId: A.branchId, horizon: 30 }).set(auth(A.owner))).status).toBe(400);
    expect((await t.http.get(`${base()}/forecast`).set(auth(A.owner))).status).toBe(400);
    // Tenant B cannot forecast tenant A's branch or product.
    const other = await t.http.get(`/v1/o/${B.orgId}/intelligence/forecast`).query({ branchId: A.branchId }).set(auth(B.owner));
    expect(other.status).toBe(404);
    const prod = await t.http.get(`/v1/o/${B.orgId}/intelligence/forecast`).query({ branchId: B.branchId, productId: menu.products.burger }).set(auth(B.owner));
    expect(prod.status).toBe(404);
    expect((await t.http.get(`${base()}/forecast`).query({ branchId: A.branchId }).set(auth(B.owner))).status).toBe(404);
  });
});

describe('customer intelligence', () => {
  it('segments customers with RFM and lists members (customers:read)', async () => {
    const res = await t.http.get(`${base()}/segments`).set(auth(A.owner));
    expect(res.status).toBe(200);
    expect(res.body.method).toBe('rfm_quintiles');
    const total = res.body.segments.reduce((s: number, x: any) => s + x.count, 0);
    expect(total).toBe(res.body.totalCustomers);
    expect(res.body.totalCustomers).toBeGreaterThanOrEqual(10);
    expect(res.body.segments.find((s: any) => s.key === 'new').count).toBeGreaterThanOrEqual(1);
    const members = await t.http.get(`${base()}/segments/new/customers`).set(auth(A.owner));
    expect(members.status).toBe(200);
    expect(members.body.items.map((m: any) => m.displayName)).toContain('newbie');
    expect((await t.http.get(`${base()}/segments/whales/customers`).set(auth(A.owner))).status).toBe(400);
  });

  it('ranks churn risk and labels the heuristic when labels are not derivable', async () => {
    const res = await t.http.get(`${base()}/churn`).query({ limit: 5 }).set(auth(marketing));
    expect(res.status).toBe(200);
    expect(res.body.method).toBe('heuristic');
    expect(res.body.isHeuristic).toBe(true);
    expect(res.body.reason).toMatch(/^labels_not_derivable/);
    expect(res.body.customers[0].displayName).toBe('vip'); // last order 70 days ago, usually every 4 days
    expect(res.body.customers[0].band).toBe('high');
  });
});

describe('recommendations', () => {
  it('returns frequently-bought-with items and excludes unavailable products', async () => {
    const res = await t.http.get(`${base()}/recommendations`).query({ branchId: A.branchId, productId: menu.products.burger, k: 3 }).set(auth(A.owner));
    expect(res.status).toBe(200);
    const [item] = res.body.items;
    expect(item.frequentlyBoughtWith[0]).toMatchObject({ productId: menu.products.fries, name: 'Fries', source: 'association' });
    expect(item.frequentlyBoughtWith[0].lift).toBeGreaterThan(0);
    await sql(`insert into product_branch_settings(org_id, product_id, branch_id, is_available) values ($1, $2, $3, false)`, [A.orgId, menu.products.fries, A.branchId]);
    const after = await t.http.get(`${base()}/recommendations`).query({ branchId: A.branchId, productId: menu.products.burger, customerId: customers.c2, k: 3 }).set(auth(A.owner));
    expect(after.status).toBe(200);
    expect(after.body.items[0].frequentlyBoughtWith.map((r: any) => r.productId)).not.toContain(menu.products.fries);
    expect(after.body.customer.nextItems.map((r: any) => r.productId)).not.toContain(menu.products.fries);
    expect(after.body.customer.nextItems.length).toBe(3);
    await sql(`delete from product_branch_settings where product_id = $1 and branch_id = $2`, [menu.products.fries, A.branchId]);
  });

  it("never recommends a dish the kitchen 86'd, while it stays offered (FT-02 / DF-01)", async () => {
    const fbw = async () => {
      const res = await t.http.get(`${base()}/recommendations`).query({ branchId: A.branchId, productId: menu.products.burger, k: 3 }).set(auth(A.owner));
      expect(res.status).toBe(200);
      return res.body.items[0].frequentlyBoughtWith.map((r: any) => r.productId) as string[];
    };
    expect(await fbw()).toContain(menu.products.fries);
    // The 86 as menu.service writes it: offered here (is_available true), sold out until the end of the day.
    await sql(`insert into product_branch_settings(org_id, product_id, branch_id, is_available, sold_out, sold_out_until)
               values ($1, $2, $3, true, true, now() + interval '6 hours')`, [A.orgId, menu.products.fries, A.branchId]);
    expect(await fbw()).not.toContain(menu.products.fries);
    // Once the restore time passes the dish is recommended again.
    await sql(`update product_branch_settings set sold_out_until = now() - interval '1 minute' where product_id = $1 and branch_id = $2`, [menu.products.fries, A.branchId]);
    expect(await fbw()).toContain(menu.products.fries);
    await sql(`delete from product_branch_settings where product_id = $1 and branch_id = $2`, [menu.products.fries, A.branchId]);
  });
});

describe('route planning', () => {
  it("orders a driver's open jobs and compares with the naive order", async () => {
    const res = await t.http.post(`${base()}/routes/plan`).set(auth(A.owner)).send({ branchId: A.branchId, driverId });
    expect(res.status).toBe(200);
    expect(res.body.start.source).toBe('branch');
    expect(res.body.stops.map((s: any) => s.lat)).toEqual([30.05, 30.07, 30.1]);
    expect(res.body.stops.map((s: any) => s.naiveSequence)).toEqual([2, 3, 1]);
    expect(res.body.distanceKm).toBeLessThan(res.body.naive.distanceKm);
    expect(res.body.distanceModel).toMatchObject({ kind: 'haversine', roadFactor: 1.3 });
    expect(res.body.computationMs).toBeGreaterThanOrEqual(0);
    const [p] = await sql(`select kind, subject_id from ai_predictions where id = $1`, [res.body.predictionId]);
    expect(p).toMatchObject({ kind: 'route_plan', subject_id: driverId });
  });

  it('lists drivers with open jobs for the planner', async () => {
    const res = await t.http.get(`${base()}/routes/drivers`).query({ branchId: A.branchId }).set(auth(A.owner));
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([{ id: driverId, displayName: 'Driver One', availability: 'busy', openJobs: 3 }]);
    expect((await t.http.get(`${base()}/routes/drivers`).query({ branchId: A.branchId }).set(auth(marketing))).status).toBe(403);
  });

  it('requires delivery:dispatch and a driver of this tenant', async () => {
    expect((await t.http.post(`${base()}/routes/plan`).set(auth(marketing)).send({ branchId: A.branchId, driverId })).status).toBe(403);
    expect((await t.http.post(`/v1/o/${B.orgId}/intelligence/routes/plan`).set(auth(B.owner)).send({ branchId: B.branchId, driverId })).status).toBe(404);
    expect((await t.http.post(`${base()}/routes/plan`).set(auth(A.owner)).send({ branchId: A.branchId })).status).toBe(400);
  });
});

describe('insights', () => {
  let insightId: string;

  it('generates deterministic and model-based insights with evidence', async () => {
    const res = await t.http.post(`${base()}/insights/refresh`).set(auth(A.owner));
    expect(res.status).toBe(200);
    expect(res.body.created).toBeGreaterThanOrEqual(5);
    const list = await t.http.get(`${base()}/insights`).set(auth(A.owner));
    const keys = (await sql(`select coalesce(dedupe_key, episode_key) as dedupe_key, method, severity, evidence, template_key, template_params from ai_insights where org_id = $1`, [A.orgId]));
    const byPrefix = (p: string) => keys.find((k) => k.dedupe_key.startsWith(p));
    const drop = byPrefix(`revenue_drop:${A.branchId}:${yesterday}`)!;
    expect(drop.method).toBe('deterministic');
    expect(drop.severity).toBe('critical');
    expect(drop.evidence.revenueMinor).toBe(yesterdayRevenue);
    expect(byPrefix(`item_anomaly:${A.branchId}:${menu.products.soda}:${yesterday}`)).toBeTruthy();
    expect(byPrefix(`stockout:${A.branchId}:${menu.products.limited}`)!.evidence).toMatchObject({ stock: 3, averageDailySales: 1.9 });
    expect(byPrefix(`slow_kitchen:${A.branchId}:${yesterday}`)!.evidence).toMatchObject({ medianMinutes: 26, orders: 4, baselineMedianMinutes: 10 });
    expect(byPrefix('inactive_valuable:')!.evidence.customerIds).toContain(customers.vip);
    expect(keys.some((k) => k.method === 'model')).toBe(true);
    expect(list.body.items.length).toBe(keys.length);
    // FT-15: every generated insight carries a template key + params; the stored English text is only a fallback.
    expect(keys.every((k) => typeof k.template_key === 'string' && k.template_params)).toBe(true);
    expect(drop.template_key).toBe('revenue_drop');
    expect(drop.template_params).toMatchObject({ revenueMinor: yesterdayRevenue, date: yesterday, currency: 'EGP', branch: { en: 'Main branch' } });
    const item = list.body.items.find((i: any) => i.templateKey === 'revenue_drop');
    expect(item).toMatchObject({ templateKey: 'revenue_drop', params: { date: yesterday } });
    expect(item.title).toMatch(/^Revenue down [\d.]+% at Main branch$/);
    const ar = renderInsight(item.templateKey, item.params, 'ar')!;
    expect(ar.title).toContain('انخفض الإيراد');
    expect(ar.body).not.toMatch(/[٠-٩]/);
    expect(ar.evidence.map((e) => e.label)).toContain('الإيراد');
    insightId = list.body.items[0].id;
  }, 120_000);

  it('deduplicates repeated runs, including the scheduled job', async () => {
    const before = (await sql(`select count(*)::int as n from ai_insights where org_id = $1`, [A.orgId]))[0].n;
    const again = await t.http.post(`${base()}/insights/refresh`).set(auth(A.owner));
    expect(again.body).toMatchObject({ created: 0, modelSkipped: 'ran_recently' });
    expect(t.app.get(EventDispatcher).registered.jobs).toContain('intelligence.insights');
    await t.app.get(InsightsService).runScheduled();
    const after = (await sql(`select count(*)::int as n from ai_insights where org_id = $1`, [A.orgId]))[0].n;
    expect(after).toBe(before);
  });

  it('tracks status changes with audit and keeps closed insights closed', async () => {
    const res = await t.http.patch(`${base()}/insights/${insightId}`).set(auth(A.owner)).send({ status: 'dismissed' });
    expect(res.status).toBe(200);
    expect((await t.http.patch(`${base()}/insights/${insightId}`).set(auth(A.owner)).send({ status: 'seen' })).status).toBe(409);
    expect((await t.http.patch(`${base()}/insights/${insightId}`).set(auth(A.owner)).send({ status: 'archived' })).status).toBe(400);
    const [audit] = await sql(`select metadata from audit_logs where org_id = $1 and action = 'intelligence.insight.status' and entity_id = $2`, [A.orgId, insightId]);
    expect(audit.metadata).toMatchObject({ from: 'new', to: 'dismissed' });
    const dismissed = await t.http.get(`${base()}/insights`).query({ status: 'dismissed' }).set(auth(A.owner));
    expect(dismissed.body.items.map((i: any) => i.id)).toEqual([insightId]);
    expect((await t.http.patch(`/v1/o/${B.orgId}/intelligence/insights/${insightId}`).set(auth(B.owner)).send({ status: 'acted' })).status).toBe(404);
  });

  it('closes open stock insights on refresh once the item is restocked', async () => {
    const items = await sql(`insert into inventory_items(org_id, name, unit, reorder_level) values ($1, 'Rice', 'kg', 5), ($1, 'Oil', 'l', 3) returning id, name`, [A.orgId]);
    const id = (name: string) => items.find((i) => i.name === name).id;
    await sql(`insert into stock_levels(org_id, branch_id, item_id, quantity) values ($1, $2, $3, -2), ($1, $2, $4, 1)`, [A.orgId, A.branchId, id('Rice'), id('Oil')]);
    await t.http.post(`${base()}/insights/refresh`).set(auth(A.owner));
    const status = async (rule: string, key: string, subject: string) => (await sql(
      `select status from ai_insights where org_id = $1 and evidence->>'rule' = $2 and evidence->>$3 = $4`, [A.orgId, rule, key, subject])).map((r) => r.status);
    expect(await status('inventory_below_reorder_level', 'itemId', id('Rice'))).toEqual(['new']);
    expect(await status('inventory_below_reorder_level', 'itemId', id('Oil'))).toEqual(['new']);
    const stockout = await status('stock_cover_vs_14d_average', 'productId', menu.products.limited);
    expect(stockout.length).toBe(1);

    await sql(`update stock_levels set quantity = 20 where item_id = $1`, [id('Rice')]);
    await sql(`update product_branch_settings set stock_qty = 100000 where product_id = $1`, [menu.products.limited]);
    const res = await t.http.post(`${base()}/insights/refresh`).set(auth(A.owner));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 0 });
    expect(res.body.resolved).toBe(stockout[0] === 'dismissed' ? 1 : 2);
    // Closed by the system as 'resolved' (DF-03), not 'acted' (which records that a person acted on it).
    expect(await status('inventory_below_reorder_level', 'itemId', id('Rice'))).toEqual(['resolved']);
    expect(await status('inventory_below_reorder_level', 'itemId', id('Oil'))).toEqual(['new']);
    expect(await status('stock_cover_vs_14d_average', 'productId', menu.products.limited)).toEqual([stockout[0] === 'dismissed' ? 'dismissed' : 'resolved']);
    const open = await t.http.get(`${base()}/insights`).query({ status: 'new' }).set(auth(A.owner));
    expect(open.body.items.some((i: any) => i.evidence.itemId === id('Rice'))).toBe(false);
    await sql(`update product_branch_settings set stock_qty = 3 where product_id = $1`, [menu.products.limited]);
  });

  it('DF-03: a restock resolves the low-stock insight at once; a re-breach opens a new one; a continuing breach refreshes one card', async () => {
    const inv = `/v1/o/${A.orgId}/inventory`;
    const created = await t.http.post(`${inv}/items`).set(auth(A.owner)).send({ name: 'Burrata', nameAr: 'بوراتا', unit: 'pcs', costPerUnitMinor: 5000, reorderLevel: 5 });
    expect(created.status).toBe(201);
    const itemId = created.body.id;
    const move = (body: Record<string, unknown>) => t.http.post(`${inv}/movements`).set(auth(A.owner)).send({ branchId: A.branchId, itemId, ...body });
    const cards = async () => sql(`select id, status, template_params, episode_ended_at from ai_insights where org_id = $1 and evidence->>'itemId' = $2 order by created_at`, [A.orgId, itemId]);

    expect((await move({ kind: 'purchase', quantity: 10, unitCostMinor: 5000 })).status).toBe(201);
    expect((await move({ kind: 'waste', quantity: 9, reason: 'spoiled' })).status).toBe(201); // 1 left, alert opens
    await t.http.post(`${base()}/insights/refresh`).set(auth(A.owner));
    let rows = await cards();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'new', template_params: { quantity: 1, reorderLevel: 5, unit: 'pcs', item: { en: 'Burrata', ar: 'بوراتا' } } });

    // A continuing breach (stock moves but stays low) refreshes the same card instead of adding one.
    expect((await move({ kind: 'purchase', quantity: 2, unitCostMinor: 5000 })).status).toBe(201); // 3 left, still low
    const again = await t.http.post(`${base()}/insights/refresh`).set(auth(A.owner));
    rows = await cards();
    expect(rows).toHaveLength(1);
    expect(rows[0].template_params.quantity).toBe(3);
    expect(again.body.created).toBe(0);

    // Restock: the inventory transaction resolves the alert and closes the card immediately (no refresh needed).
    expect((await move({ kind: 'purchase', quantity: 20, unitCostMinor: 5000 })).status).toBe(201);
    rows = await cards();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('resolved');
    expect(rows[0].episode_ended_at).not.toBeNull();
    const open = await t.http.get(`${base()}/insights`).query({ status: 'new' }).set(auth(A.owner));
    expect(open.body.items.some((i: any) => i.evidence.itemId === itemId)).toBe(false);

    // Same-day re-breach: a new card (the resolved one does not suppress it).
    expect((await move({ kind: 'waste', quantity: 21, reason: 'spoiled' })).status).toBe(201); // 2 left
    const rebreach = await t.http.post(`${base()}/insights/refresh`).set(auth(A.owner));
    rows = await cards();
    expect(rows.map((r) => r.status)).toEqual(['resolved', 'new']);
    expect(rows[1].template_params.quantity).toBe(2);
    expect(rebreach.body.created).toBeGreaterThanOrEqual(1);

    // A card the owner dismissed while the breach continues stays dismissed and is not re-created by the next run.
    await t.http.patch(`${base()}/insights/${rows[1].id}`).set(auth(A.owner)).send({ status: 'dismissed' });
    await t.http.post(`${base()}/insights/refresh`).set(auth(A.owner));
    rows = await cards();
    expect(rows.map((r) => r.status)).toEqual(['resolved', 'dismissed']);
    // The restock ends that episode too, keeping the owner's status.
    expect((await move({ kind: 'purchase', quantity: 20, unitCostMinor: 5000 })).status).toBe(201);
    rows = await cards();
    expect(rows.map((r) => r.status)).toEqual(['resolved', 'dismissed']);
    expect(rows[1].episode_ended_at).not.toBeNull();
  });
});

describe('owner assistant (rules mode, no GEMINI_API_KEY)', () => {
  it('answers sales questions with tool-derived numbers and persists the thread', async () => {
    const res = await t.http.post(`${base()}/assistant`).set(auth(A.owner)).send({ message: 'How much did we sell yesterday?' });
    expect(res.status).toBe(201);
    expect(res.body.mode).toBe('rules');
    expect(res.body.toolCalls[0].name).toBe('sales_summary');
    expect(res.body.toolCalls[0].result.revenueMinor).toBe(yesterdayRevenue);
    expect(res.body.answer).toContain(formatMoney(yesterdayRevenue, 'EGP', 'en'));
    expect(res.body.citations).toEqual(['sales_summary']);
    const msgs = await t.http.get(`${base()}/assistant/threads/${res.body.threadId}/messages`).set(auth(A.owner));
    expect(msgs.body.items.map((m: any) => m.role)).toEqual(['user', 'tool', 'assistant']);
    // Another user cannot read this thread.
    expect((await t.http.get(`${base()}/assistant/threads/${res.body.threadId}/messages`).set(auth(marketing))).status).toBe(404);
  });

  it('answers in Arabic and continues a thread', async () => {
    const first = await t.http.post(`${base()}/assistant`).set(auth(A.owner)).send({ message: 'ما هي الأصناف الأكثر مبيعًا هذا الأسبوع؟', locale: 'ar' });
    expect(first.body.toolCalls[0]).toMatchObject({ name: 'top_items', args: { direction: 'top', period: 'last_7_days' } });
    expect(first.body.answer).toContain('الأكثر مبيعًا');
    const items = first.body.toolCalls[0].result.items;
    expect(items[0].quantity).toBeGreaterThanOrEqual(items[1].quantity);
    const next = await t.http.post(`${base()}/assistant`).set(auth(A.owner)).send({ threadId: first.body.threadId, message: 'وكم الحجوزات اليوم؟', locale: 'ar' });
    expect(next.body.threadId).toBe(first.body.threadId);
    expect(next.body.toolCalls[0].name).toBe('reservations_today');
  });

  it('is idempotent with an Idempotency-Key', async () => {
    const key = `assist-${Date.now()}`;
    const a = await t.http.post(`${base()}/assistant`).set({ ...auth(A.owner), 'Idempotency-Key': key }).send({ message: 'sales this month' });
    const b = await t.http.post(`${base()}/assistant`).set({ ...auth(A.owner), 'Idempotency-Key': key }).send({ message: 'sales this month' });
    expect(b.body.messageId).toBe(a.body.messageId);
    // REM-A03: the replay answers with the first call's status, which is the status stored with the key.
    expect(b.status).toBe(a.status);
    expect((await sql(`select status_code from idempotency_keys where org_id = $1 and key = $2`, [A.orgId, key]))[0].status_code).toBe(a.status);
    const [n] = await sql(`select count(*)::int as n from assistant_messages where thread_id = $1`, [a.body.threadId]);
    expect(n.n).toBe(3);
    const c = await t.http.post(`${base()}/assistant`).set({ ...auth(A.owner), 'Idempotency-Key': key }).send({ message: 'different' });
    expect(c.status).toBe(409);
  });

  it('only runs tools the role may use and explains what it can do', async () => {
    const res = await t.http.post(`${base()}/assistant`).set(auth(marketing)).send({ message: 'What is low in stock?' });
    expect(res.body.toolCalls[0].error).toMatch(/^not_permitted/);
    expect(res.body.answer).toContain('Your role cannot view inventory');
    const help = await t.http.post(`${base()}/assistant`).set(auth(A.owner)).send({ message: 'Tell me a joke' });
    expect(help.body.toolCalls).toEqual([]);
    expect(help.body.answer).toMatch(/^I can answer/);
    expect((await t.http.post(`${base()}/assistant`).set(auth(A.owner)).send({ message: '' })).status).toBe(400);
  });

  it('routes English and Arabic intents deterministically', () => {
    expect(routeIntent('best sellers last month')).toEqual({ tool: 'top_items', args: { period: 'last_month', direction: 'top', limit: 5 } });
    expect(routeIntent('مبيعات امبارح')).toEqual({ tool: 'sales_summary', args: { period: 'yesterday' } });
    expect(routeIntent('forecast for the next two weeks')).toEqual({ tool: 'demand_forecast', args: { days: 14 } });
    expect(numbersIn('١٬٢٣٤٫٥٠ ج.م and 1,155.00 EGP\n1. item')).toEqual([1234.5, 1155]);
  });
});

describe('owner assistant (LLM function-calling path with a scripted model)', () => {
  const scripted = (fn: (contents: GeminiContent[], tools: any[]) => GeminiContent): LlmClient & { tools: string[] } => {
    const llm = {
      provider: 'gemini' as const, tools: [] as string[],
      async generate(req: any) { llm.tools = (req.tools ?? []).map((x: any) => x.name); return fn(req.contents, req.tools); },
    };
    return llm;
  };
  const lastResult = (contents: GeminiContent[]) => (contents.at(-1)!.parts[0]!.functionResponse!.response as any).result;

  it('executes validated tool calls and accepts answers grounded in tool results', async () => {
    const assistant = t.app.get(AssistantService);
    const { base: env } = await assistant.prepare(ctxA, {});
    let round = 0;
    const llm = scripted((contents) => {
      round++;
      if (round === 1) return { role: 'model', parts: [{ functionCall: { name: 'sales_summary', args: { period: 'yesterday' } } }] };
      const r = lastResult(contents);
      return { role: 'model', parts: [{ text: `Yesterday you took ${r.orders} orders worth EGP ${(r.revenueMinor / 100).toFixed(2)} [sales_summary].` }] };
    });
    const draft = await assistant.answerWithLlm(env, 'How did yesterday go?', 'en', llm);
    expect(draft).toMatchObject({ mode: 'gemini', grounded: true, llmCalls: 2 });
    expect(draft.answer).toContain((yesterdayRevenue / 100).toFixed(2));
    expect(llm.tools).toContain('low_stock');
  });

  it('replaces answers with numbers not found in tool results', async () => {
    const assistant = t.app.get(AssistantService);
    const { base: env } = await assistant.prepare(ctxA, {});
    let round = 0;
    const llm = scripted(() => (++round === 1
      ? { role: 'model', parts: [{ functionCall: { name: 'sales_summary', args: { period: 'yesterday' } } }] }
      : { role: 'model', parts: [{ text: 'Revenue was EGP 99,999.00, up 12% [sales_summary].' }] }));
    const draft = await assistant.answerWithLlm(env, 'How did yesterday go?', 'en', llm);
    expect(draft.grounded).toBe(false);
    expect(draft.answer).not.toContain('99,999');
    expect(draft.answer).toContain(formatMoney(yesterdayRevenue, 'EGP', 'en'));
  });

  it('rejects invalid tool arguments and hides tools the role cannot use', async () => {
    const assistant = t.app.get(AssistantService);
    const mctx = new TenantContext(A.orgId, 'marketing', null, marketing.userId, 'user', marketing.userId);
    const { base: env } = await assistant.prepare(mctx, {});
    let round = 0;
    const llm = scripted(() => (++round === 1
      ? { role: 'model', parts: [{ functionCall: { name: 'sales_summary', args: { period: 'decade' } } }, { functionCall: { name: 'low_stock', args: {} } }] }
      : { role: 'model', parts: [{ text: 'I could not read that period.' }] }));
    const draft = await assistant.answerWithLlm(env, 'sales?', 'en', llm);
    expect(draft.toolCalls[0]!.error).toMatch(/^invalid_arguments/);
    expect(draft.toolCalls[1]!.error).toMatch(/^not_permitted/);
    expect(llm.tools).not.toContain('low_stock');
    expect(isGrounded('EGP 12.50 from 3 orders', [{ revenueMinor: 1250, orders: 3 }], '')).toBe(true);
    expect(isGrounded('EGP 13.50', [{ revenueMinor: 1250 }], '')).toBe(false);
  });
});

describe('copy generation, research registry, usage', () => {
  it('uses the labelled template fallback without GEMINI_API_KEY (Arabic and English)', async () => {
    const ar = await t.http.post(`${base()}/generate-copy`).set(auth(marketing)).send({ kind: 'caption', locale: 'ar', productId: menu.products.burger });
    expect(ar.status).toBe(200);
    expect(ar.body).toMatchObject({ provider: 'template', isFallback: true, locale: 'ar' });
    expect(ar.body.text).toContain('Smash burger');
    expect(ar.body.text).toContain('اطلب الآن');
    const en = await t.http.post(`${base()}/generate-copy`).set(auth(A.owner))
      .send({ kind: 'menu_description', locale: 'en', subject: { name: 'Hawawshi', description: 'Spiced minced beef in crisp baladi bread' }, tone: 'premium' });
    expect(en.body.text).toBe('Hawawshi: Spiced minced beef in crisp baladi bread. Crafted daily in the Koshary Lab kitchen.');
    expect((await t.http.post(`${base()}/generate-copy`).set(auth(A.owner)).send({ kind: 'caption', locale: 'en' })).status).toBe(400);
  });

  it('exposes the platform baselines with synthetic-data labels', async () => {
    const res = await t.http.get(`${base()}/research`).set(auth(A.owner));
    expect(res.status).toBe(200);
    expect(res.body.notice).toMatch(/SYNTHETIC/);
    expect(res.body.models.length).toBeGreaterThanOrEqual(10);
    for (const m of res.body.models) {
      expect(m.isSyntheticData).toBe(true);
      expect(m.dataset.kind).toBe('synthetic');
      for (const e of m.evaluations) expect(e.isSyntheticData).toBe(true);
    }
    const gbm = res.body.models.find((m: any) => m.name === 'hist_gbm');
    expect(gbm.evaluations.find((e: any) => e.split === 'test').metrics.wape).toBeGreaterThan(0);
  });

  it('meters every AI service call as ai_requests usage', async () => {
    const rows = await sql(`select metadata->>'endpoint' as endpoint from usage_events where org_id = $1 and metric = 'ai_requests'`, [A.orgId]);
    const endpoints = new Set(rows.map((r) => r.endpoint));
    for (const e of ['forecast/demand', 'customers/segment', 'customers/churn', 'recommend/items', 'routing/optimize']) expect(endpoints).toContain(e);
  });

  it('reports service status', async () => {
    const res = await t.http.get(`${base()}/status`).set(auth(A.owner));
    expect(res.body).toMatchObject({ aiService: { configured: true, reachable: true }, assistant: { mode: 'rules' }, copy: { mode: 'template' } });
  });
});

describe('access control', () => {
  it('requires ai:use', async () => {
    expect((await t.http.get(`${base()}/insights`).set(auth(cashier))).status).toBe(403);
    expect((await t.http.post(`${base()}/assistant`).set(auth(cashier)).send({ message: 'sales today' })).status).toBe(403);
  });

  it('requires the intelligence module', async () => {
    const free = await createTenant(t, { planId: 'free' });
    const res = await t.http.get(`/v1/o/${free.orgId}/intelligence/insights`).set(auth(free.owner));
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('module_not_entitled');
  });

  it('hides other tenants', async () => {
    expect((await t.http.get(`${base()}/insights`).set(auth(B.owner))).status).toBe(404);
    expect((await t.http.get(`${base()}/segments`).set(auth(B.owner))).status).toBe(404);
  });
});

describe('AI request quota (FT-10)', () => {
  it('refuses model endpoints with 402 once ai_requests_per_month is used while deterministic insights keep working', async () => {
    const Q = await createTenant(t, { planId: 'pro' });
    const qMenu = await seedMenu(Q);
    const ctxQ = new TenantContext(Q.orgId, 'owner', null, Q.owner.userId, 'user', Q.owner.userId);
    const qOrder = await t.app.get(DbService).scoped(ctxQ, (tx) => t.app.get(OrdersKernelService).place(tx, ctxQ, {
      branchId: Q.branchId, channel: 'staff', fulfillment: 'pickup', lines: [{ productId: qMenu.products.fries, quantity: 2 }],
      customer: { name: 'Guest', phone: '+201234500001' } }));
    // History before today, so the forecast has a series and would call the model.
    await sql(`update orders set business_date = $2::date, placed_at = ($2::date + interval '13 hours') at time zone 'Africa/Cairo' where id = $1`, [qOrder.id, day(-3)]);
    const [{ limits }] = await sql(`select p.limits from subscriptions s join plans p on p.id = s.plan_id where s.org_id = $1`, [Q.orgId]);
    const cap = Number(limits.ai_requests_per_month);
    expect(cap).toBeGreaterThan(0);
    await sql(`insert into usage_events(org_id, metric, quantity) values ($1, 'ai_requests', $2)`, [Q.orgId, cap]);
    const qb = `/v1/o/${Q.orgId}/intelligence`;
    const fc = await t.http.get(`${qb}/forecast`).query({ branchId: Q.branchId }).set(auth(Q.owner));
    expect(fc.status).toBe(402);
    expect(fc.body.error).toMatchObject({ code: 'plan_limit_reached', details: { limit: 'ai_requests_per_month', current: cap, allowed: cap } });
    expect((await t.http.get(`${qb}/segments`).set(auth(Q.owner))).status).toBe(402);
    expect((await t.http.get(`${qb}/churn`).set(auth(Q.owner))).status).toBe(402);
    expect((await t.http.get(`${qb}/recommendations`).query({ branchId: Q.branchId }).set(auth(Q.owner))).status).toBe(402);
    // Nothing was metered for refused calls.
    const [{ n }] = await sql(`select coalesce(sum(quantity), 0)::int as n from usage_events where org_id = $1 and metric = 'ai_requests'`, [Q.orgId]);
    expect(n).toBe(cap);
    // Insights: the model part is skipped and reported; deterministic rules are free.
    const refresh = await t.http.post(`${qb}/insights/refresh`).set(auth(Q.owner));
    expect(refresh.status).toBe(200);
    expect(refresh.body.modelSkipped).toBe('plan_limit_reached');
    // Rules-mode assistant and template copy do not use a model and stay available.
    expect((await t.http.post(`${qb}/generate-copy`).set(auth(Q.owner)).send({ kind: 'caption', locale: 'en', productId: qMenu.products.fries })).status).toBe(200);
  });
});

describe('AI service unavailable', () => {
  it('returns 503 for model endpoints while deterministic insights keep working', async () => {
    process.env.AI_SERVICE_URL = 'http://127.0.0.1:8199';
    down = await bootTestApp();
    process.env.AI_SERVICE_URL = `http://127.0.0.1:${AI_PORT}`;
    const res = await down.http.get(`${base()}/forecast`).query({ branchId: A.branchId }).set(auth(A.owner));
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('ai_service_unavailable');
    expect((await down.http.get(`${base()}/segments`).set(auth(A.owner))).status).toBe(503);
    expect((await down.http.post(`${base()}/routes/plan`).set(auth(A.owner)).send({ branchId: A.branchId, driverId })).status).toBe(503);
    // A tenant whose model insights are due: deterministic rules still run, the model part is skipped and reported.
    const C = await createTenant(t, { planId: 'pro' });
    const cMenu = await seedMenu(C);
    const ctxC = new TenantContext(C.orgId, 'owner', null, C.owner.userId, 'user', C.owner.userId);
    await t.app.get(DbService).scoped(ctxC, (tx) => t.app.get(OrdersKernelService).place(tx, ctxC, {
      branchId: C.branchId, channel: 'staff', fulfillment: 'pickup', lines: [{ productId: cMenu.products.fries, quantity: 2 }],
      customer: { name: 'Guest', phone: '+201234567890' } }));
    const refresh = await down.http.post(`/v1/o/${C.orgId}/intelligence/insights/refresh`).set(auth(C.owner));
    expect(refresh.status).toBe(200);
    expect(refresh.body.modelSkipped).toBe('ai_service_unavailable');
    const status = await down.http.get(`${base()}/status`).set(auth(A.owner));
    expect(status.body.aiService.reachable).toBe(false);
  });
});
