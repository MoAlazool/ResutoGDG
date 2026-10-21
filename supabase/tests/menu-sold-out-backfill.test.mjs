// FT-02 / DF-01 backfill (20261021010001_menu_sold_out.sql): before the split, a kitchen 86 wrote
// product_branch_settings.is_available = false, the same flag as "not offered at this branch". The migration turns rows
// whose latest availability entry in the audit log is an 86 into offered + sold out, and leaves real "not offered" rows.
// A later per-branch price or stock edit (menu.product.branch_updated without isAvailable) must not mask the 86.
//
// The test migrates a fresh database, rolls this one migration back the way its header describes, recreates the
// pre-split state (is_available = false + audit history) and applies the migration again.
// Uses its own database (<TEST_DATABASE_URL name>_sold_out) so it can run next to the other DB suites.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { migrate } from '../../scripts/db/migrate.mjs';

const VERSION = '20261021010001';
const base = new URL(process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:54329/resuto_test');
const name = `${base.pathname.slice(1)}_sold_out`;
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

  // Roll back this migration (header "Reverse"), so the database looks like it did before the split.
  await q(`alter table product_branch_settings drop column sold_out, drop column sold_out_until, drop column sold_out_reason,
             drop column sold_out_at, drop column sold_out_by`);
  await q(`delete from supabase_migrations.schema_migrations where version = $1`, [VERSION]);

  const [o] = await q(`insert into organizations(slug, name) values ('sold-out-backfill', 'Backfill') returning id`);
  const [b] = await q(`insert into branches(org_id, code, name) values ($1, 'main', 'Main') returning id`, [o.id]);
  const [m] = await q(`insert into menus(org_id, name) values ($1, 'Menu') returning id`, [o.id]);
  const [cat] = await q(`insert into menu_categories(org_id, menu_id, name) values ($1, $2, 'Mains') returning id`, [o.id, m.id]);
  ids.org = o.id; ids.branch = b.id;
  const dish = async (label) => {
    const [p] = await q(`insert into products(org_id, category_id, name, price_minor, currency) values ($1, $2, $3, 5000, 'EGP') returning id`, [o.id, cat.id, label]);
    await q(`insert into product_branch_settings(org_id, product_id, branch_id, is_available) values ($1, $2, $3, false)`, [o.id, p.id, b.id]);
    ids[label] = p.id;
    return p.id;
  };
  let minute = 0;
  const audit = async (productId, action, metadata) => q(
    `insert into audit_logs(org_id, actor_type, actor_id, action, entity_type, entity_id, metadata, created_at)
     values ($1, 'user', 'kitchen-1', $2, 'product', $3, $4, now() - interval '1 day' + make_interval(mins => $5))`,
    [o.id, action, productId, { branchId: b.id, ...metadata }, minute++]);

  // 86'd, nothing after.
  await audit(await dish('eightySixed'), 'menu.product.unavailable', { reason: 'out of fish' });
  // 86'd, then the branch price was edited (no isAvailable): still an 86.
  const priced = await dish('eightySixedThenPriced');
  await audit(priced, 'menu.product.unavailable', { reason: 'ran out' });
  await audit(priced, 'menu.product.branch_updated', { fields: ['priceOverrideMinor'] });
  // 86'd, then stock was counted: still an 86.
  const stocked = await dish('eightySixedThenStock');
  await audit(stocked, 'menu.product.unavailable', {});
  await audit(stocked, 'menu.product.branch_updated', { fields: ['stockQty', 'priceOverrideMinor'] });
  // 86'd, then the manager switched it off for this branch: not offered.
  const unassigned = await dish('eightySixedThenUnassigned');
  await audit(unassigned, 'menu.product.unavailable', {});
  await audit(unassigned, 'menu.product.branch_updated', { fields: ['isAvailable'] });
  // Switched off for the branch, never 86'd: not offered.
  await audit(await dish('notOffered'), 'menu.product.branch_updated', { fields: ['isAvailable', 'priceOverrideMinor'] });
  // No history at all: not offered.
  await dish('noHistory');

  await migrate({ url: url.toString(), log: () => {} });
});

after(async () => {
  await pool?.end();
  const c = new pg.Client({ connectionString: admin.toString() });
  await c.connect();
  try { await c.query(`drop database if exists ${name} with (force)`); } finally { await c.end(); }
});

const row = async (label) => (await q(
  `select is_available, sold_out, sold_out_until, sold_out_reason, sold_out_by from product_branch_settings where product_id = $1 and branch_id = $2`,
  [ids[label], ids.branch]))[0];

test('an 86 becomes offered + sold out, with who and why', async () => {
  assert.deepEqual(await row('eightySixed'),
    { is_available: true, sold_out: true, sold_out_until: null, sold_out_reason: 'out of fish', sold_out_by: 'user:kitchen-1' });
});

test('a later price or stock edit does not mask the 86', async () => {
  assert.equal((await row('eightySixedThenPriced')).sold_out, true);
  assert.equal((await row('eightySixedThenPriced')).is_available, true);
  assert.equal((await row('eightySixedThenStock')).sold_out, true);
  assert.equal((await row('eightySixedThenStock')).is_available, true);
});

test('rows the branch does not offer stay not offered', async () => {
  for (const label of ['eightySixedThenUnassigned', 'notOffered', 'noHistory']) {
    const r = await row(label);
    assert.equal(r.is_available, false, label);
    assert.equal(r.sold_out, false, label);
  }
});
