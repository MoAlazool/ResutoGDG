// Database gate for 21-STUDIO 20261026100002_studio_sections_discounts: the new website section kinds are accepted
// (and nothing else), products.compare_at_price_minor is positive or null, change_ops takes product.discount.set, and
// both tables stay tenant-isolated for the new data (a member or tenant session of B never reads or edits A's sections
// or discounts, even with a forged org). Own disposable database (<TEST_DATABASE_URL>_ws21studio).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { migrate } from '../../scripts/db/migrate.mjs';
import { ensureDatabase } from '../../scripts/db/ensure-db.mjs';

const base = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:54329/resuto_test';
const url = base.replace(/\/([^/?]+)(\?.*)?$/, (_m, db, q = '') => `/${db}_ws21studio${q}`);
const pool = new pg.Pool({ connectionString: url, max: 4 });
const q = (sql, params) => pool.query(sql, params).then((r) => r.rows);
const ids = {};

async function as(role, { user, org } = {}, fn) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    if (user) await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: user, role: 'authenticated' })]);
    if (org) await c.query(`select set_config('app.org_id', $1, true)`, [org]);
    await c.query(`set local role ${role}`);
    return await fn(c);
  } finally {
    await c.query('rollback').catch(() => {});
    c.release();
  }
}

before(async () => {
  await ensureDatabase(url);
  await migrate({ url, reset: true, log: () => {} });
  for (const k of ['A', 'B']) {
    const [u] = await q(`insert into auth.users(email) values ($1) returning id`, [`ws21studio-owner${k}@example.test`]);
    const [o] = await q(`insert into organizations(slug, name) values ($1, $2) returning id`, [`ws21studio-${k.toLowerCase()}`, `Studio ${k}`]);
    await q(`insert into memberships(org_id, user_id, role) values ($1, $2, 'owner')`, [o.id, u.id]);
    const [w] = await q(`insert into websites(org_id) values ($1) returning id`, [o.id]);
    const [m] = await q(`insert into menus(org_id, name) values ($1, 'Main') returning id`, [o.id]);
    const [c] = await q(`insert into menu_categories(org_id, menu_id, name) values ($1, $2, 'Mains') returning id`, [o.id, m.id]);
    const [p] = await q(`insert into products(org_id, category_id, name, price_minor, currency) values ($1, $2, 'Koshari', 3825, 'EGP') returning id`, [o.id, c.id]);
    ids[k] = { user: u.id, org: o.id, website: w.id, product: p.id };
  }
});
after(async () => pool.end());

test('website_sections accepts the 21-STUDIO kinds and still refuses unknown ones', async () => {
  for (const kind of ['promo_banner', 'offers', 'social', 'faq', 'menu_full', 'hero']) {
    await q(`insert into website_sections(org_id, website_id, kind, content) values ($1, $2, $3, '{}')`, [ids.A.org, ids.A.website, kind]);
  }
  await assert.rejects(q(`insert into website_sections(org_id, website_id, kind) values ($1, $2, 'script')`, [ids.A.org, ids.A.website]), /website_sections_kind_check/);
});

test('compare_at_price_minor is positive or null', async () => {
  await q('update products set compare_at_price_minor = 4500 where id = $1', [ids.A.product]);
  await q('update products set compare_at_price_minor = null where id = $1', [ids.A.product]);
  for (const bad of [0, -1]) {
    await assert.rejects(q('update products set compare_at_price_minor = $2 where id = $1', [ids.A.product, bad]), /products_compare_at_price_valid/);
  }
});

test('change_ops takes product.discount.set (group prices) and still refuses unknown op types', async () => {
  const [cs] = await q(`insert into change_sets(org_id, origin, actor_type, actor_id, title) values ($1, 'studio_ai', 'user', $2, 'Eid') returning id`, [ids.A.org, ids.A.user]);
  await q(`insert into change_ops(org_id, change_set_id, seq, op_type, op_group, kind, input) values ($1, $2, 0, 'product.discount.set', 'prices', 'local', $3)`,
    [ids.A.org, cs.id, JSON.stringify({ productId: ids.A.product, discountBps: 1500 })]);
  await assert.rejects(q(`insert into change_ops(org_id, change_set_id, seq, op_type, op_group, kind, input) values ($1, $2, 1, 'product.delete', 'menu', 'local', '{}')`,
    [ids.A.org, cs.id]), /change_ops_op_type_check/);
});

test('new section kinds and dish discounts are tenant-isolated (member and tenant sessions, forged org)', async () => {
  await q(`insert into website_sections(org_id, website_id, kind, content) values ($1, $2, 'offers', '{"badge":{"en":"B only"}}')`, [ids.B.org, ids.B.website]);
  await q('update products set compare_at_price_minor = 4500 where id = $1', [ids.B.product]);
  const own = await as('resuto_member', { user: ids.A.user, org: ids.A.org }, (c) => c.query(`select org_id from website_sections where kind = 'offers'`));
  assert.ok(own.rows.length >= 1 && own.rows.every((r) => r.org_id === ids.A.org));
  const forged = await as('resuto_member', { user: ids.A.user, org: ids.B.org }, (c) => c.query(`select id from website_sections where kind = 'offers'`));
  assert.equal(forged.rowCount, 0);
  const tenant = await as('resuto_tenant', { org: ids.A.org }, (c) => c.query('select id, compare_at_price_minor from products'));
  assert.deepEqual(tenant.rows.map((r) => r.id), [ids.A.product]);
  // B's discount cannot be changed from A's tenant session (the row is invisible: nothing is updated).
  const write = await as('resuto_tenant', { org: ids.A.org }, (c) => c.query('update products set compare_at_price_minor = null where id = $1', [ids.B.product]));
  assert.equal(write.rowCount, 0);
  assert.equal(Number((await q('select compare_at_price_minor from products where id = $1', [ids.B.product]))[0].compare_at_price_minor), 4500);
  // Anonymous and plain authenticated sessions read nothing.
  for (const role of ['anon', 'authenticated']) {
    const r = await as(role, {}, (c) => c.query(`select id from website_sections`).catch((e) => ({ rowCount: 0, error: e.code })));
    assert.equal(r.rowCount, 0, role);
  }
});
