// S07 — AI on real operational data. 90 days of orders are created through the staff
// orders API (the kernel path every channel uses); because the API always stamps "now",
// each order's placed_at/business_date is then BACK-DATED WITH SQL (a stand-in for the
// passage of time — stated in docs/qa/SCENARIOS.md). The real Python AI service runs as
// a subprocess. Forecast → backtest metrics; insights refresh → evidence-backed insight;
// owner assistant (rules mode, no Gemini key) → sales numbers that match SQL.
import type { ChildProcess } from 'node:child_process';
import { formatMoney } from '@resuto/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, auth, bootTestApp, createTenant, sql, type TestApp, type TestTenant, type TestUser } from '../helpers';
import { addDays, buildMenuViaApi, burgerLine, cairoToday, key, startAiService, type ApiMenu } from './support';

const AI_PORT = 8117;
const AI_TOKEN = 'g-scenario-ai-token-0123456789abcdef';
const DAYS = 90;

let ai: ChildProcess | null = null;
let t: TestApp;
let tenant: TestTenant;
let menu: ApiMenu;
let waiter: TestUser;
let today: string;
let yesterday: string;

const I = (p: string) => `/v1/o/${tenant.orgId}/intelligence${p}`;

async function orderOn(date: string, hour: number, lines: unknown[]) {
  const res = await t.http.post(`/v1/o/${tenant.orgId}/orders`).set(auth(waiter)).set('Idempotency-Key', key('hist'))
    .send({ branchId: tenant.branchId, fulfillment: 'pickup', lines, customer: { name: `Guest ${date}`, phone: `+2010${date.replace(/-/g, '').slice(-8)}` } });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  // Back-dating (SQL stand-in for time passing): the API cannot create orders in the past.
  await sql(`update orders set business_date = $2::date, placed_at = ($2::date + make_interval(hours => $3)) at time zone 'Africa/Cairo' where id = $1`,
    [res.body.id, date, hour]);
  return res.body.id as string;
}

beforeAll(async () => {
  ai = await startAiService(AI_PORT, AI_TOKEN);
  process.env.AI_SERVICE_URL = `http://127.0.0.1:${AI_PORT}`;
  process.env.AI_SERVICE_TOKEN = AI_TOKEN;
  delete process.env.GEMINI_API_KEY;
  t = await bootTestApp();
  tenant = await createTenant(t, { country: 'EG', name: 'Forecast Grill' });
  menu = await buildMenuViaApi(t, tenant);
  waiter = await addMember(t, tenant, 'waiter');
  today = await cairoToday();
  yesterday = addDays(today, -1);
  // Steady trade for DAYS days ending two days ago; Thursday/Friday evenings are busier.
  for (let d = DAYS; d >= 2; d--) {
    const date = addDays(today, -d);
    const weekend = [4, 5].includes(new Date(`${date}T00:00:00Z`).getUTCDay());
    const burgers = weekend ? 5 : 3;
    await orderOn(date, 13, [burgerLine(menu, burgers), { productId: menu.fries, quantity: burgers - 1 }, { productId: menu.soda, quantity: 2 }]);
  }
  // Yesterday: a sharp drop (one soda).
  await orderOn(yesterday, 14, [{ productId: menu.soda, quantity: 1 }]);
}, 240_000);

afterAll(async () => {
  await t?.close();
  ai?.kill('SIGTERM');
});

describe('S07 AI on API-created operational history', () => {
  it('0. the history really is ≥ 60 days of kernel-created orders', async () => {
    const [h] = await sql(`select count(distinct business_date)::int as days, min(business_date)::text as first, max(business_date)::text as last,
                                  count(*) filter (where channel = 'staff')::int as staff
                             from orders where org_id = $1`, [tenant.orgId]);
    expect(h.days).toBeGreaterThanOrEqual(60);
    expect(h).toMatchObject({ first: addDays(today, -DAYS), last: yesterday, staff: DAYS });
  });

  it('1. the forecast returns a selected model with backtest metrics for the best sellers', async () => {
    const res = await t.http.get(I('/forecast')).query({ branchId: tenant.branchId, horizon: 14, top: 3 }).set(auth(tenant.owner));
    expect(res.status, JSON.stringify(res.body).slice(0, 500)).toBe(200);
    expect(res.body).toMatchObject({ asOf: yesterday, isSyntheticData: false });
    const burger = res.body.items.find((i: any) => i.productId === menu.burger);
    expect(burger).toBeTruthy();
    expect(burger.forecast).toHaveLength(14);
    expect(burger.forecast[0].date).toBe(today);
    for (const p of burger.forecast) expect(p.lower <= p.yhat && p.yhat <= p.upper).toBe(true);
    expect(burger.candidates.length).toBeGreaterThanOrEqual(2);
    const chosen = burger.candidates.find((c: any) => c.model === burger.model);
    expect(chosen).toBeTruthy();
    expect(chosen.metrics.n).toBeGreaterThan(0);
    expect(typeof chosen.metrics.wape).toBe('number');
    for (const c of burger.candidates) if (c.metrics?.n > 0) expect(chosen.metrics.wape).toBeLessThanOrEqual(c.metrics.wape);
    expect(burger.coverage).toMatchObject({ end: yesterday });
    expect(burger.coverage.days).toBeGreaterThanOrEqual(60);
  }, 120_000);

  it('2. an insights refresh produces at least one evidence-backed insight', async () => {
    const res = await t.http.post(I('/insights/refresh')).set(auth(tenant.owner));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.created).toBeGreaterThanOrEqual(1);
    const list = await t.http.get(I('/insights')).set(auth(tenant.owner));
    expect(list.status).toBe(200);
    expect(list.body.items.length).toBeGreaterThanOrEqual(1);
    const withEvidence = list.body.items.filter((i: any) => i.evidence && Object.keys(i.evidence).length > 0);
    expect(withEvidence.length).toBeGreaterThanOrEqual(1);
    // The revenue drop yesterday is detected with the real revenue as evidence.
    const [{ revenue }] = await sql(`select coalesce(sum(total_minor), 0)::int as revenue from orders where org_id = $1 and business_date = $2 and status <> 'cancelled'`, [tenant.orgId, yesterday]);
    const [drop] = await sql(`select evidence, method from ai_insights where org_id = $1 and dedupe_key like $2`, [tenant.orgId, `revenue_drop:${tenant.branchId}:${yesterday}%`]);
    expect(drop).toBeTruthy();
    expect(drop).toMatchObject({ method: 'deterministic', evidence: { revenueMinor: revenue } });
  }, 120_000);

  it('3. the owner assistant (rules mode) answers a sales question with numbers that match SQL', async () => {
    const [{ revenue, orders }] = await sql(`select coalesce(sum(total_minor), 0)::int as revenue, count(*)::int as orders
                                               from orders where org_id = $1 and business_date = $2 and status <> 'cancelled'`, [tenant.orgId, yesterday]);
    const res = await t.http.post(I('/assistant')).set(auth(tenant.owner)).send({ message: 'How much did we sell yesterday?' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.mode).toBe('rules');
    expect(res.body.toolCalls[0]).toMatchObject({ name: 'sales_summary' });
    expect(res.body.toolCalls[0].result).toMatchObject({ revenueMinor: revenue, orders });
    expect(res.body.answer).toContain(formatMoney(revenue, 'EGP', 'en'));
    expect(res.body.citations).toEqual(['sales_summary']);

    // A longer period: last 7 days, checked against SQL the same way.
    const week = await t.http.post(I('/assistant')).set(auth(tenant.owner)).send({ message: 'sales in the last 7 days' });
    expect(week.status).toBe(201);
    const call = week.body.toolCalls[0];
    expect(call.name).toBe('sales_summary');
    const { from, to } = call.result;
    expect(from).toBe(addDays(today, -6));
    expect(to).toBe(today);
    const [w] = await sql(`select coalesce(sum(total_minor), 0)::int as revenue, count(*)::int as orders from orders
                            where org_id = $1 and business_date between $2::date and $3::date and status <> 'cancelled'`, [tenant.orgId, from, to]);
    expect(call.result).toMatchObject({ revenueMinor: w.revenue, orders: w.orders });
    expect(week.body.answer).toContain(formatMoney(call.result.revenueMinor, 'EGP', 'en'));
  });
});
