// Database gate for the public-site migrations (20261020050002 sales inquiries, 20261020050003 branch storefronts):
// sales inquiries are platform-only (no tenant, member or client access), storefront branding is tenant data with
// branch scope, and a storefront cannot point at another organization's branch. Uses its own database
// (<TEST_DATABASE_URL>_publicsite) so it can run beside rls.test.mjs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { migrate } from '../../scripts/db/migrate.mjs';
import { ensureDatabase } from '../../scripts/db/ensure-db.mjs';

const base = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:54329/resuto_test';
const url = base.replace(/\/([^/?]+)(\?.*)?$/, (_m, db, q = '') => `/${db}_publicsite${q}`);
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
    const [u] = await q(`insert into auth.users(email) values ($1) returning id`, [`owner-site-${k}@example.test`]);
    const [o] = await q(`insert into organizations(slug, name) values ($1, $2) returning id`, [`site-${k.toLowerCase()}`, `Site ${k}`]);
    const [main] = await q(`insert into branches(org_id, code, name) values ($1, 'main', 'Main') returning id`, [o.id]);
    const [burger] = await q(`insert into branches(org_id, code, name) values ($1, 'burger', 'Burger bar') returning id`, [o.id]);
    await q(`insert into memberships(org_id, user_id, role) values ($1, $2, 'owner')`, [o.id, u.id]);
    await q(`insert into branch_storefronts(branch_id, org_id, slug, brand_name, theme, is_published) values ($1, $2, 'smash', 'Smash', '{"primaryColor":"#d7261e","accentColor":"#ffd23f"}', true)`, [burger.id, o.id]);
    ids[k] = { user: u.id, org: o.id, main: main.id, burger: burger.id };
  }
  const [k] = await q(`insert into auth.users(email) values ('kitchen-site@example.test') returning id`);
  await q(`insert into memberships(org_id, user_id, role, branch_ids) values ($1, $2, 'kitchen', array[$3::uuid])`, [ids.A.org, k.id, ids.A.main]);
  ids.kitchenA = k.id;
  await q(`insert into sales_inquiries(restaurant, email, branches, requirements, idempotency_key) values ('Lead (test)', 'lead@example.test', 2, 'QR ordering', 'key-public-site-0001')`);
});
after(async () => pool.end());

test('sales inquiries are platform-only: no tenant, member or client role can read or write them', async () => {
  for (const [role, ctx] of [['resuto_member', { user: ids.A.user, org: ids.A.org }], ['resuto_tenant', { org: ids.A.org }], ['authenticated', { user: ids.A.user }], ['anon', {}]]) {
    await assert.rejects(as(role, ctx, (c) => c.query('select * from sales_inquiries')), /permission denied/, `${role} read`);
    await assert.rejects(as(role, ctx, (c) => c.query(`insert into sales_inquiries(restaurant, email, branches, requirements, idempotency_key) values ('x', 'x@x.x', 1, 'x', 'key-xxxxxxxx')`)), /permission denied/, `${role} write`);
  }
  const [{ relrowsecurity }] = await q(`select relrowsecurity from pg_class where oid = 'public.sales_inquiries'::regclass`);
  assert.equal(relrowsecurity, true);
});

test('sales inquiry constraints: branch count range and a unique idempotency key', async () => {
  await assert.rejects(q(`insert into sales_inquiries(restaurant, email, branches, requirements, idempotency_key) values ('x', 'x@x.x', 0, 'x', 'key-range-0001')`), /check/);
  await assert.rejects(q(`insert into sales_inquiries(restaurant, email, branches, requirements, idempotency_key) values ('x', 'x@x.x', 1, 'x', 'key-public-site-0001')`), /duplicate key/);
});

test('storefront branding is tenant-isolated and branch-scoped', async () => {
  const own = await as('resuto_member', { user: ids.A.user, org: ids.A.org }, (c) => c.query('select org_id from branch_storefronts'));
  assert.equal(own.rowCount, 1);
  assert.equal(own.rows[0].org_id, ids.A.org);
  const forged = await as('resuto_member', { user: ids.A.user, org: ids.B.org }, (c) => c.query('select * from branch_storefronts'));
  assert.equal(forged.rowCount, 0, 'a member of A sees nothing when app.org_id is forged to B');
  const kitchen = await as('resuto_member', { user: ids.kitchenA, org: ids.A.org }, (c) => c.query('select * from branch_storefronts'));
  assert.equal(kitchen.rowCount, 0, 'staff scoped to the main branch do not see the burger branch storefront');
  const tenant = await as('resuto_tenant', { org: ids.B.org }, (c) => c.query('select org_id from branch_storefronts'));
  assert.deepEqual(tenant.rows.map((r) => r.org_id), [ids.B.org]);
  await assert.rejects(as('authenticated', { user: ids.A.user }, (c) => c.query('select * from branch_storefronts')), /permission denied/);
  await assert.rejects(as('anon', {}, (c) => c.query('select * from branch_storefronts')), /permission denied/);
});

test('a storefront cannot be attached to another organization\'s branch, and slugs are unique per organization', async () => {
  await assert.rejects(q(`insert into branch_storefronts(branch_id, org_id, slug, brand_name) values ($1, $2, 'stolen', 'Stolen')`, [ids.B.main, ids.A.org]), /does not belong/);
  await assert.rejects(as('resuto_member', { user: ids.A.user, org: ids.A.org }, (c) =>
    c.query(`insert into branch_storefronts(branch_id, org_id, slug, brand_name) values ($1, $2, 'stolen', 'Stolen')`, [ids.B.main, ids.B.org])), /row-level security|does not belong/);
  await assert.rejects(q(`insert into branch_storefronts(branch_id, org_id, slug, brand_name) values ($1, $2, 'smash', 'Twice')`, [ids.A.main, ids.A.org]), /duplicate key/);
  await assert.rejects(q(`insert into branch_storefronts(branch_id, org_id, slug, brand_name) values ($1, $2, 'revalidate', 'Reserved')`, [ids.A.main, ids.A.org]), /check/);
});
