// 20261022020001_menu_version_deleted_org.sql: deleting an organization cascades to its branches, menus and products;
// their menu-version triggers must not try to version the organization that is being deleted, and the security-definer
// bump must still version a live organization (and nothing else).
// Uses its own database (<TEST_DATABASE_URL name>_org_delete) so it can run next to the other DB suites.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { migrate } from '../../scripts/db/migrate.mjs';

const base = new URL(process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:54329/resuto_test');
const name = `${base.pathname.slice(1)}_org_delete`;
const url = new URL(base); url.pathname = `/${name}`;
const admin = new URL(base); admin.pathname = '/postgres';
let pool;
const q = (sql, params) => pool.query(sql, params).then((r) => r.rows);

async function tenant(slug) {
  const [o] = await q(`insert into organizations(slug, name) values ($1, $2) returning id`, [slug, slug]);
  const [b] = await q(`insert into branches(org_id, code, name) values ($1, 'main', 'Main') returning id`, [o.id]);
  const [m] = await q(`insert into menus(org_id, name) values ($1, 'Menu') returning id`, [o.id]);
  const [c] = await q(`insert into menu_categories(org_id, menu_id, name) values ($1, $2, 'Mains') returning id`, [o.id, m.id]);
  await q(`insert into products(org_id, category_id, name, price_minor, currency) values ($1, $2, 'Dish', 1000, 'EGP')`, [o.id, c.id]);
  return { orgId: o.id, branchId: b.id };
}

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
});
after(async () => { await pool?.end(); });

test('deleting an organization cascades through its menu without a menu_versions foreign-key error', async () => {
  const a = await tenant('org-delete-a');
  const b = await tenant('org-delete-b');
  const [before] = await q(`select version::int as v from menu_versions where org_id = $1`, [b.orgId]);
  await q(`delete from products where org_id = $1`, [a.orgId]);   // what the legacy rollback does first (RESTRICT refs)
  await q(`delete from organizations where id = $1`, [a.orgId]);
  assert.deepEqual(await q(`select 1 from organizations where id = $1`, [a.orgId]), []);
  assert.deepEqual(await q(`select 1 from menu_versions where org_id = $1`, [a.orgId]), [], 'no version row survives for a deleted organization');
  const [afterDelete] = await q(`select version::int as v from menu_versions where org_id = $1`, [b.orgId]);
  assert.equal(afterDelete.v, before.v, 'another tenant is not versioned by the deletion');
});

test('a live organization is still versioned by menu edits', async () => {
  const t = await tenant('org-delete-live');
  const [v1] = await q(`select version::int as v from menu_versions where org_id = $1`, [t.orgId]);
  await q(`update products set price_minor = 1200 where org_id = $1`, [t.orgId]);
  const [v2] = await q(`select version::int as v from menu_versions where org_id = $1`, [t.orgId]);
  assert.ok(v2.v > v1.v);
});

test('the security-definer bump keeps its pinned search_path', async () => {
  const [f] = await q(`select prosecdef, proconfig from pg_proc where oid = 'app.bump_menu_version(uuid)'::regprocedure`);
  assert.equal(f.prosecdef, true);
  assert.ok((f.proconfig ?? []).some((c) => /^search_path=public, ?pg_temp$/.test(c)), JSON.stringify(f.proconfig));
});
