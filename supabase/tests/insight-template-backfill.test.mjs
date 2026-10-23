// REM-A07 (FT-15 / DF-15): insights stored before 20261021020001 have no template_key, so Arabic readers saw the
// English text. 20261023020002_insight_template_backfill rebuilds template_key + params from the stored evidence.
// The test migrates a fresh database, stores legacy rows the way the old producers did (English title/body, evidence,
// no template), applies the backfill SQL again (it is idempotent) and checks that every row now renders in English
// exactly as the stored title and in Arabic with Western digits. Uses its own database (<TEST_DATABASE_URL>_insights).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import pg from 'pg';
import { migrate } from '../../scripts/db/migrate.mjs';

const require = createRequire(import.meta.url);
const { renderInsight, stripIsolates } = require('../../packages/contracts/dist/index.js');
const BACKFILL = readFileSync(new URL('../migrations/20261023020002_insight_template_backfill.sql', import.meta.url), 'utf8');

const base = new URL(process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:54329/resuto_test');
const name = `${base.pathname.slice(1)}_insights`;
const url = new URL(base); url.pathname = `/${name}`;
const admin = new URL(base); admin.pathname = '/postgres';
let pool;
const q = (sql, params) => pool.query(sql, params).then((r) => r.rows);
const ids = {};

before(async () => {
  if (!['127.0.0.1', 'localhost', '::1'].includes(base.hostname)) throw new Error('local databases only');
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`unsupported database name ${name}`);
  const c = new pg.Client({ connectionString: admin.toString() });
  await c.connect();
  try {
    await c.query(`drop database if exists ${name} with (force)`);
    await c.query(`create database ${name}`);
  } finally { await c.end(); }
  pool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  await migrate({ url: url.toString(), log: () => {} });

  const [o] = await q(`insert into organizations(slug, name, currency) values ('insight-backfill', 'Olive', 'EGP') returning id`);
  const [b] = await q(`insert into branches(org_id, code, name, name_ar) values ($1, 'main', 'Zamalek', 'الزمالك') returning id`, [o.id]);
  const [m] = await q(`insert into menus(org_id, name) values ($1, 'Menu') returning id`, [o.id]);
  const [cat] = await q(`insert into menu_categories(org_id, menu_id, name) values ($1, $2, 'Mains') returning id`, [o.id, m.id]);
  const [p] = await q(`insert into products(org_id, category_id, name, name_ar, price_minor, currency) values ($1, $2, 'Loaded Fries', 'بطاطس محمّلة', 5000, 'EGP') returning id`, [o.id, cat.id]);
  const [it] = await q(`insert into inventory_items(org_id, name, name_ar, unit, reorder_level) values ($1, 'Beef patty', 'شريحة لحم', 'pcs', 40) returning id`, [o.id]);
  Object.assign(ids, { org: o.id, branch: b.id, product: p.id, item: it.id });

  // The English text the old producers stored, with their evidence (insights.service.ts before templates).
  const rows = [
    ['sales', b.id, 'Revenue down 100% at Zamalek', { rule: 'revenue_vs_same_weekday_4w', date: '2026-10-19', revenueMinor: 0, baselineMinor: 250000, dropPct: 100,
      weeks: [{ date: '2026-10-12', revenueMinor: 273000 }, { date: '2026-10-05', revenueMinor: 196500 }, { date: '2026-09-28', revenueMinor: 280500 }], currency: 'EGP', orders: 0 }],
    ['anomaly', b.id, 'Loaded Fries sold far above normal', { rule: 'item_sales_zscore_28d', productId: p.id, date: '2026-10-17', quantity: 4, mean: 0.6, sd: 0.8, z: 3.4 }],
    ['inventory', b.id, 'Beef patty is below its reorder level at Zamalek', { rule: 'inventory_below_reorder_level', itemId: it.id, quantity: -68, reorderLevel: 40, unit: 'pcs' }],
    ['inventory', b.id, 'Loaded Fries is sold out', { rule: 'stock_cover_vs_14d_average', productId: p.id, stock: 0, averageDailySales: 3.5, coverDays: 0 }],
    ['operations', b.id, 'Kitchen 50% slower at Zamalek', { rule: 'median_ready_minutes_vs_14d', date: '2026-10-19', medianMinutes: 18, orders: 12, baselineMedianMinutes: 12, baselineOrders: 80 }],
    ['customers', null, '3 valuable customers have not ordered in a while', { rule: 'top20_spend_overdue_2x_gap', customers: 3, spendMinor: 950000, currency: 'EGP', customerIds: [] }],
    ['sales', b.id, 'Demand for Loaded Fries expected to fall 37.5%', { rule: 'forecast_next7_vs_last7', productId: p.id, model: 'moving_average_28', next7: 5, last7: 8, changePct: -37.5 }],
    ['customers', null, '24 customers at high churn risk', { rule: 'churn_risk_high_band', method: 'heuristic', customers: 24, customerIds: [] }],
    // A product that no longer exists: stays on the English fallback.
    ['anomaly', b.id, 'Gone dish sold far above normal', { rule: 'item_sales_zscore_28d', productId: '00000000-0000-4000-8000-000000000000', date: '2026-10-17', quantity: 4, mean: 0.6, z: 3.4 }],
  ];
  for (const [kind, branchId, title, evidence] of rows) {
    await q(`insert into ai_insights(org_id, branch_id, kind, severity, title, body, evidence, method) values ($1, $2, $3, 'warning', $4, 'legacy body', $5, 'deterministic')`,
      [o.id, branchId, kind, title, evidence]);
  }
  await q(BACKFILL);
});

after(async () => { await pool?.end(); });

test('legacy insights get the template the producers use today and render in Arabic (Western digits)', async () => {
  const rows = await q(`select title, template_key, template_params from ai_insights where org_id = $1 order by created_at`, [ids.org]);
  const keys = rows.map((r) => r.template_key);
  assert.deepEqual(keys, ['revenue_drop', 'item_spike', 'low_stock', 'stock_sold_out', 'slow_kitchen', 'inactive_valuable', 'demand_fall', 'churn_high', null]);
  for (const r of rows.filter((x) => x.template_key)) {
    const en = renderInsight(r.template_key, r.template_params, 'en');
    const ar = renderInsight(r.template_key, r.template_params, 'ar');
    assert.ok(en && ar, r.template_key);
    const arText = stripIsolates(`${ar.title} ${ar.body} ${ar.evidence.map((e) => e.value).join(' ')}`);
    assert.doesNotMatch(arText, /undefined|NaN|null|—\s*$/, `${r.template_key}: ${arText}`);
    assert.doesNotMatch(arText, /[٠-٩۰-۹]/, `${r.template_key} uses Arabic-Indic digits`);
    assert.match(arText, /[؀-ۿ]/);
    if (['revenue_drop', 'item_spike', 'demand_fall', 'churn_high', 'stock_sold_out'].includes(r.template_key)) {
      assert.equal(stripIsolates(en.title), r.title, `${r.template_key}: the English rendering equals the stored title`);
    }
  }
  const lowStock = rows.find((r) => r.template_key === 'low_stock');
  assert.deepEqual(lowStock.template_params.item, { en: 'Beef patty', ar: 'شريحة لحم' });
  assert.equal(rows.find((r) => r.template_key === 'slow_kitchen').template_params.slowerPct, 50);
});

test('the backfill is idempotent and never rewrites a row that already has a template', async () => {
  await q(`update ai_insights set template_params = template_params || '{"marker": 1}'::jsonb where org_id = $1 and template_key = 'revenue_drop'`, [ids.org]);
  await q(BACKFILL);
  const [r] = await q(`select template_params from ai_insights where org_id = $1 and template_key = 'revenue_drop'`, [ids.org]);
  assert.equal(r.template_params.marker, 1);
  assert.equal((await q(`select count(*)::int as n from ai_insights where org_id = $1 and template_key is null`, [ids.org]))[0].n, 1);
});
