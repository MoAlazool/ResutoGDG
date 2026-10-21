// Proves the demo integrity check (scripts/demo/integrity-check.mjs) holds on a consistent demo tenant and that each
// assertion catches the defect it names (audits DF-10, DF-11, VP-14).
//
// The tenant is built the way scripts/db/seed.mjs builds it (the legacy fixture through tools/legacy-migration,
// re-timed to now, stale work imported as closed history), then completed with what the API loader adds (fixed costs,
// stock, photos, the Smash & Co storefront) as plain rows. Each defect is injected inside a transaction that is rolled
// back, so the cases are independent.
//
//   DEMO_TEST_DATABASE_URL (default: <TEST_DATABASE_URL name>_demo_integrity on the local cluster)
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { ensureDatabase } from '../../db/ensure-db.mjs';
import { migrate } from '../../db/migrate.mjs';
import { migrateLegacy } from '../../../tools/legacy-migration/migrate.mjs';
import { CHECKS, checkDemoIntegrity, LIVE_STALE_HOURS } from '../integrity-check.mjs';
import { fixedCostSchedule } from '../lib/fixed-costs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const base = new URL(process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:54329/resuto_test');
const url = process.env.DEMO_TEST_DATABASE_URL ?? (() => { const u = new URL(base); u.pathname = `${base.pathname}_demo_integrity`; return u.toString(); })();
const manifest = JSON.parse(readFileSync(path.join(ROOT, 'supabase/seeds/olive-room.demo.json'), 'utf8'));
let db;
let orgId;
const q = async (text, params = []) => (await db.query(text, params)).rows;

before(async () => {
  if (!['127.0.0.1', 'localhost', '::1'].includes(new URL(url).hostname)) throw new Error('local databases only');
  await ensureDatabase(url);
  await migrate({ url, reset: true, log: () => {} });
  const document = JSON.parse(readFileSync(path.join(ROOT, manifest.fixture), 'utf8'));
  const report = await migrateLegacy({ url, document, options: {
    restaurantId: manifest.restaurantId, slug: manifest.slug, planId: 'pro', subscriptionStatus: 'active',
    nameAr: manifest.nameAr, categoryNamesAr: manifest.categoryNamesAr,
    retimeTo: new Date(Date.now() - 30 * 60_000), closeStaleAfterHours: LIVE_STALE_HOURS,
  }, media: { assetsDir: path.join(ROOT, 'legacy/public'), storageDir: mkdtempSync(path.join(tmpdir(), 'demo-integrity-')) } });
  assert.equal(report.committed, true, 'the re-timed fixture still reconciles');
  orgId = report.orgId;
  db = new pg.Client({ connectionString: url });
  await db.connect();

  // What the API loader adds on top of the migrated tenant.
  const [{ tz }] = await q(`select timezone as tz from organizations where id = $1`, [orgId]);
  const [{ first, today }] = await q(`select min(business_date)::text as first, (now() at time zone $2)::date::text as today from orders where org_id = $1`, [orgId, tz]);
  const cats = Object.fromEntries((await q(`select kind, id from expense_categories where org_id = $1`, [orgId])).map((r) => [r.kind, r.id]));
  for (const e of fixedCostSchedule({ from: first, to: today })) {
    await q(`insert into expenses(org_id, category_id, amount_minor, tax_minor, currency, incurred_on, vendor, description, external_ref)
             values ($1, $2, $3, $4, 'EGP', $5, $6, $7, $8)`, [orgId, cats[e.kind], e.amountMinor, e.taxMinor, e.incurredOn, e.vendor, e.description, e.externalRef]);
  }
  const [main] = await q(`select id from branches where org_id = $1 and code = 'main'`, [orgId]);
  const [burger] = await q(`select id from branches where org_id = $1 and code <> 'main'`, [orgId]);
  const [item] = await q(`insert into inventory_items(org_id, name, unit) values ($1, 'Potatoes', 'kg') returning id`, [orgId]);
  const [order] = await q(`select id, placed_at from orders where org_id = $1 and status <> 'cancelled' order by placed_at limit 1`, [orgId]);
  await q(`insert into stock_movements(org_id, branch_id, item_id, quantity_delta, reason, created_at) values ($1, $2, $3, 10, 'purchase', $4::timestamptz - interval '1 day')`,
    [orgId, main.id, item.id, order.placed_at]);
  await q(`insert into stock_movements(org_id, branch_id, item_id, quantity_delta, reason, reference_type, reference_id, created_at)
           values ($1, $2, $3, -0.5, 'sale', 'order', $4, $5::timestamptz + interval '15 min')`, [orgId, main.id, item.id, order.id, order.placed_at]);
  await q(`insert into stock_levels(org_id, branch_id, item_id, quantity) values ($1, $2, $3, 9.5)
           on conflict (branch_id, item_id) do update set quantity = 9.5`, [orgId, main.id, item.id]);
  const media = async (p) => (await q(`insert into media_assets(org_id, path, content_type, byte_size) values ($1, $2, 'image/webp', 1) returning id`, [orgId, `${orgId}/${p}`]))[0].id;
  for (const p of await q(`select id from products where org_id = $1`, [orgId])) {
    await q(`update products set image_media_id = $2 where id = $1`, [p.id, await media(`menu/${p.id}.webp`)]);
  }
  await q(`update websites set theme = coalesce(theme, '{}'::jsonb) || jsonb_build_object('heroMediaId', $2::text) where org_id = $1`, [orgId, await media('website/hero.webp')]);
  await q(`insert into branch_storefronts(branch_id, org_id, slug, brand_name, brand_name_ar, hero_media_id, is_published)
           values ($1, $2, 'smash-and-co', 'Smash & Co', 'سماش آند كو', $3, true)`, [burger.id, orgId, await media('storefront/hero.webp')]);
});
after(async () => { await db?.end(); });

/** Runs `mutate` inside a transaction, returns the integrity report, and rolls everything back. */
async function withDefect(mutate) {
  await db.query('begin');
  try {
    await mutate();
    return await checkDemoIntegrity(q, { slug: manifest.slug });
  } finally {
    await db.query('rollback');
  }
}
const failing = (report) => report.results.filter((r) => !r.ok).map((r) => r.name);

describe('demo integrity check', () => {
  it('holds on a consistent tenant built from the re-timed legacy fixture', async () => {
    const report = await checkDemoIntegrity(q, { slug: manifest.slug });
    assert.deepEqual(failing(report), [], JSON.stringify(report.results.filter((r) => !r.ok)));
    assert.equal(report.results.length, CHECKS.length);
  });

  it('the legacy seed alone passes the migration profile (stale legacy work was imported as closed history)', async () => {
    const report = await withDefect(async () => {
      await q(`delete from expenses where org_id = $1`, [orgId]);
      await q(`delete from branch_storefronts where org_id = $1`, [orgId]);
    });
    assert.deepEqual(failing(report).sort(), ['fixed_costs_every_month', 'smash_storefront_present']);
    await db.query('begin');
    try {
      await q(`delete from expenses where org_id = $1`, [orgId]);
      await q(`delete from branch_storefronts where org_id = $1`, [orgId]);
      const seedOnly = await checkDemoIntegrity(q, { slug: manifest.slug, profile: 'migration' });
      assert.equal(seedOnly.ok, true, JSON.stringify(seedOnly.results.filter((r) => !r.ok)));
    } finally { await db.query('rollback'); }
  });

  const cases = [
    ['no_future_rows', 'an order placed tomorrow', () => q(`update orders set placed_at = now() + interval '1 day' where id = (select id from orders where org_id = $1 limit 1)`, [orgId])],
    ['no_future_rows', 'an expense dated next week', () => q(`update expenses set incurred_on = current_date + 7 where id = (select id from expenses where org_id = $1 limit 1)`, [orgId])],
    ['reconciliation_period_not_in_future', 'a run whose period ends an hour after it ran (old loader: to = now + 1 h)',
      () => q(`insert into reconciliation_runs(org_id, provider, period_start, period_end, status) values ($1, 'simulated', now() - interval '2 days', now() + interval '1 hour', 'completed')`, [orgId])],
    ['no_negative_stock_running_balance', 'sales booked before the opening stock (running balance below zero)',
      () => q(`update stock_movements set created_at = created_at - interval '3 days' where org_id = $1 and reason = 'sale'`, [orgId])],
    ['stock_levels_match_movements', 'a balance that disagrees with its ledger', () => q(`update stock_levels set quantity = quantity + 3 where org_id = $1`, [orgId])],
    ['sale_movements_follow_their_order', 'stock deducted at load time instead of with its order',
      () => q(`update stock_movements set created_at = now() where org_id = $1 and reason = 'sale'`, [orgId])],
    ['checkout_sessions_follow_their_order', 'a checkout session stamped at load time for an order placed weeks earlier', async () => {
      const [o] = await q(`select id, branch_id, currency, total_minor from orders where org_id = $1 and total_minor > 0 order by placed_at limit 1`, [orgId]);
      await q(`insert into checkout_sessions(org_id, branch_id, token_hash, purpose, order_id, amount_minor, currency, status, expires_at, paid_at)
               values ($1, $2, md5(random()::text), 'order', $3, $4, $5, 'paid', now() + interval '30 min', now())`, [orgId, o.branch_id, o.id, o.total_minor, o.currency]);
    }],
    ['history_orders_unique', 'a history day placed twice after an interrupted refresh (two orders with one plan tag)',
      () => q(`update orders set external_ref = 'demo-hist:2026-10-12:0' where id in (select id from orders where org_id = $1 order by placed_at limit 2)`, [orgId])],
    ['fixed_costs_every_month', 'a month without payroll (old loader: no payroll in the current month)',
      () => q(`delete from expenses where org_id = $1 and external_ref like 'demo-fixed:%:labor' and incurred_on >= date_trunc('month', current_date)`, [orgId])],
    ['no_stale_reservations', 'a booking still confirmed a day after its start',
      () => q(`update reservations set status = 'confirmed', starts_at = now() - interval '1 day', ends_at = now() - interval '22 hours' where id = (select id from reservations where org_id = $1 limit 1)`, [orgId])],
    ['no_stale_open_visits', 'a table visit open for 14 days',
      () => q(`update visits set status = 'open', closed_at = null, opened_at = now() - interval '14 days' where id = (select id from visits where org_id = $1 limit 1)`, [orgId])],
    ['no_stale_service_requests', 'a waiter call open since yesterday',
      () => q(`update service_requests set status = 'open', resolved_at = null, created_at = now() - interval '1 day' where id = (select id from service_requests where org_id = $1 limit 1)`, [orgId])],
    ['no_stale_kitchen_tickets', 'a ticket preparing for 443 h (legacy fx-order-6)',
      () => q(`update orders set status = 'preparing', fulfilled_at = null, placed_at = now() - interval '443 hours', business_date = (now() - interval '443 hours')::date where id = (select id from orders where org_id = $1 and status <> 'cancelled' limit 1)`, [orgId])],
    ['no_stale_delivery_jobs', 'a delivery waiting for a driver for two days', async () => {
      const [o] = await q(`select id, branch_id from orders where org_id = $1 limit 1`, [orgId]);
      await q(`insert into delivery_jobs(org_id, branch_id, order_id, status, dropoff, created_at) values ($1, $2, $3, 'unassigned', '{}', now() - interval '2 days')`, [orgId, o.branch_id, o.id]);
    }],
    ['order_timeline_consistent', 'an order accepted before it was placed',
      () => q(`update orders set accepted_at = placed_at - interval '1 hour' where id = (select id from orders where org_id = $1 limit 1)`, [orgId])],
    ['arabic_names_present', 'a category without its Arabic name', () => q(`update menu_categories set name_ar = null where id = (select id from menu_categories where org_id = $1 limit 1)`, [orgId])],
    ['photos_present', 'a dish without a photo', () => q(`update products set image_media_id = null where id = (select id from products where org_id = $1 and is_active limit 1)`, [orgId])],
    ['photos_present', 'a website without its hero', () => q(`update websites set theme = theme - 'heroMediaId' where org_id = $1`, [orgId])],
    ['smash_storefront_present', 'an unpublished Smash & Co storefront', () => q(`update branch_storefronts set is_published = false where org_id = $1`, [orgId])],
  ];
  for (const [check, defect, mutate] of cases) {
    it(`${check} catches ${defect}`, async () => {
      const report = await withDefect(mutate);
      assert.ok(failing(report).includes(check), `${check} did not fail: ${JSON.stringify(report.results.filter((r) => !r.ok).map((r) => r.name))}`);
    });
  }

  it('every assertion has at least one defect case', () => {
    const covered = new Set(cases.map(([c]) => c));
    assert.deepEqual(CHECKS.map((c) => c.name).filter((n) => !covered.has(n)), []);
  });

  it('runs read-only (the CLI sets default_transaction_read_only, and every statement is a SELECT)', () => {
    for (const c of CHECKS) assert.match(c.sql.trim(), /^(with|select)\b/i, c.name);
  });
});
