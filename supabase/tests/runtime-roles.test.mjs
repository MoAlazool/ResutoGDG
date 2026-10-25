// Least-privilege runtime roles (audit PS-16, migration 20261022030001_runtime_roles.sql): resuto_platform and
// resuto_api exist without LOGIN, BYPASSRLS or ownership; migrations never create credentials; every table granted to
// the platform role has a matching policy (no silent empty reads); the platform role reaches only its grants; the API
// login can do nothing until it switches into an execution role; tenant isolation holds for it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migrate } from '../../scripts/db/migrate.mjs';
import { ensureDatabase } from '../../scripts/db/ensure-db.mjs';

const base = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:54329/resuto_test';
const url = base.replace(/\/([^/?]+)(\?.*)?$/, (_m, db, q = '') => `/${db}_roles${q}`);
const pool = new pg.Pool({ connectionString: url, max: 4 });
const q = (sql, params) => pool.query(sql, params).then((r) => r.rows);
const ids = {};
const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');

async function as(role, { org, user } = {}, fn) {
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
    const [u] = await q(`insert into auth.users(email) values ($1) returning id`, [`roles${k}@example.test`]);
    const [o] = await q(`insert into organizations(slug, name) values ($1, $2) returning id`, [`roles-${k.toLowerCase()}`, `Roles ${k}`]);
    const [b] = await q(`insert into branches(org_id, code, name) values ($1, 'main', 'Main') returning id`, [o.id]);
    await q(`insert into memberships(org_id, user_id, role) values ($1, $2, 'owner')`, [o.id, u.id]);
    await q(`insert into dining_tables(org_id, branch_id, label, capacity, qr_token) values ($1, $2, 'T1', 4, $3)`, [o.id, b.id, `roles-qr-${k}-0123456789`]);
    ids[k] = { org: o.id, user: u.id, branch: b.id };
  }
});
after(async () => pool.end());

test('runtime roles are NOLOGIN in migrations, never superuser or BYPASSRLS, and own nothing', async () => {
  const roles = await q(`select rolname, rolsuper, rolbypassrls, rolinherit, rolcreaterole, rolcreatedb from pg_roles
    where rolname in ('resuto_api', 'resuto_platform', 'resuto_member', 'resuto_tenant') order by rolname`);
  assert.deepEqual(roles.map((r) => r.rolname), ['resuto_api', 'resuto_member', 'resuto_platform', 'resuto_tenant']);
  for (const r of roles) {
    assert.equal(r.rolsuper || r.rolbypassrls || r.rolcreaterole || r.rolcreatedb, false, `${r.rolname} has no elevated attribute`);
  }
  assert.equal(roles.find((r) => r.rolname === 'resuto_api').rolinherit, false, 'resuto_api is NOINHERIT');
  const owned = await q(`select c.relname from pg_class c join pg_roles r on r.oid = c.relowner
    where r.rolname in ('resuto_api', 'resuto_platform', 'resuto_member', 'resuto_tenant')`);
  assert.deepEqual(owned, []);
  const members = await q(`select g.rolname from pg_auth_members m join pg_roles g on g.oid = m.roleid join pg_roles u on u.oid = m.member
    where u.rolname = 'resuto_api' order by 1`);
  assert.deepEqual(members.map((r) => r.rolname), ['resuto_member', 'resuto_platform', 'resuto_tenant']);
});

test('every migration has its own version (scripts/db/migrate.mjs keys applied migrations by the 14-digit prefix)', () => {
  // Two files with one version: a fresh database fails on the second, and a database that already applied the first
  // silently skips the second for good (21-ONB and 21-STUDIO both shipped 20261026100001).
  const versions = readdirSync(migrationsDir).filter((x) => /^\d{14}_.+\.sql$/.test(x)).map((x) => x.slice(0, 14));
  assert.deepEqual(versions.filter((v, i) => versions.indexOf(v) !== i), []);
});

test('no migration creates a login role or stores a password', () => {
  for (const f of readdirSync(migrationsDir).filter((x) => x.endsWith('.sql'))) {
    const sql = readFileSync(path.join(migrationsDir, f), 'utf8').replace(/--.*$/gm, '');
    assert.doesNotMatch(sql, /\bpassword\b/i, `${f} mentions a password`);
    assert.doesNotMatch(sql, /(create|alter)\s+(role|user)\b[^;]*\b(?<!no)login\b/i, `${f} creates or alters a LOGIN role`);
    assert.doesNotMatch(sql, /(create|alter)\s+(role|user)\b[^;]*\bbypassrls\b/i, `${f} grants BYPASSRLS`);
  }
});

test('every table granted to resuto_platform has a platform policy for each granted command', async () => {
  const missing = await q(`
    with g as (
      select c.oid, c.relname, p.cmd from pg_class c join pg_namespace n on n.oid = c.relnamespace
      cross join unnest(array['select', 'insert', 'update', 'delete']) as p(cmd)
      where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relrowsecurity and has_table_privilege('resuto_platform', c.oid, p.cmd))
    select g.relname, g.cmd from g where not exists (
      select 1 from pg_policies pol where pol.schemaname = 'public' and pol.tablename = g.relname
        and 'resuto_platform' = any(pol.roles) and lower(pol.cmd) in (g.cmd, 'all'))
    order by 1, 2`);
  assert.deepEqual(missing, []);
  const granted = await q(`select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and has_table_privilege('resuto_platform', c.oid, 'select')`);
  const all = await q(`select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'`);
  assert.ok(granted[0].n < all[0].n, `platform role reaches ${granted[0].n} of ${all[0].n} tables, not all`);
});

test('the platform role reaches what it is granted and nothing else', async () => {
  // the QR, slug and token lookups resolve across tenants
  const found = await as('resuto_platform', {}, (c) => c.query(`select org_id from dining_tables where qr_token = $1`, ['roles-qr-B-0123456789']));
  assert.equal(found.rows[0].org_id, ids.B.org);
  for (const table of ['order_lines', 'stock_movements', 'expenses', 'customer_consent_events', 'recipe_components']) {
    await assert.rejects(as('resuto_platform', {}, (c) => c.query(`select 1 from ${table} limit 1`)), /permission denied/, table);
  }
  await assert.rejects(as('resuto_platform', {}, (c) => c.query(`update orders set total_minor = 0`)), /permission denied/);
  await assert.rejects(as('resuto_platform', {}, (c) => c.query(`delete from audit_logs`)), /permission denied/);
  await assert.rejects(as('resuto_platform', {}, (c) => c.query(`create table public.roles_probe (id int)`)), /permission denied/);
  await assert.rejects(as('resuto_platform', {}, (c) => c.query(`create function public.roles_probe() returns int language sql as 'select 1'`)), /permission denied/);
  await assert.rejects(as('resuto_platform', {}, (c) => c.query(`alter table orders disable row level security`)), /must be owner/);
  await assert.rejects(as('resuto_platform', {}, (c) => c.query(`select app.grant_platform('public.order_lines', array['select'])`)), /permission denied/);
});

test('the execution roles cannot create objects either', async () => {
  for (const role of ['resuto_member', 'resuto_tenant']) {
    await assert.rejects(as(role, { org: ids.A.org, user: ids.A.user }, (c) => c.query(`create table public.roles_probe (id int)`)), /permission denied/, role);
  }
});

test('the API login can do nothing until it takes an execution role, and tenant isolation holds once it does', async () => {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query('set local role resuto_api');
    await assert.rejects(c.query('select 1 from organizations limit 1'), /permission denied/);
  } finally {
    await c.query('rollback').catch(() => {});
    c.release();
  }
  // resuto_api -> resuto_tenant: confined to app.org_id like every tenant session
  const t = await pool.connect();
  try {
    await t.query('begin');
    await t.query('set local role resuto_api');
    await t.query(`select set_config('app.org_id', $1, true)`, [ids.A.org]);
    await t.query('set local role resuto_tenant');
    const rows = (await t.query('select org_id from dining_tables')).rows;
    assert.ok(rows.length > 0 && rows.every((r) => r.org_id === ids.A.org));
  } finally {
    await t.query('rollback').catch(() => {});
    t.release();
  }
});

test('notification e-mails are read through a definer function only the platform role may call', async () => {
  const rows = await as('resuto_platform', {}, (c) => c.query(`select e from app.notification_recipient_emails($1, $2, '{}', null) e`, [ids.A.org, ids.A.user]));
  assert.deepEqual(rows.rows.map((r) => r.e), ['rolesA@example.test']);
  for (const role of ['resuto_member', 'resuto_tenant', 'authenticated', 'anon']) {
    await assert.rejects(as(role, { org: ids.A.org, user: ids.A.user }, (c) => c.query(`select app.notification_recipient_emails($1, null, '{owner}', null)`, [ids.A.org])),
      /permission denied/, role);
  }
});

test('shared rate-limit windows (PS-13) are platform-only and hold key hashes, not addresses', async () => {
  await as('resuto_platform', {}, async (c) => {
    await c.query(`insert into rate_limit_windows(key_hash, window_start, count, expires_at) values (repeat('a', 64), now(), 1, now() + interval '1 minute')`);
    await assert.rejects(c.query(`insert into rate_limit_windows(key_hash, window_start, count, expires_at) values ('ip:203.0.113.9', now(), 1, now())`), /check constraint/);
  });
  for (const role of ['resuto_member', 'resuto_tenant', 'authenticated', 'anon']) {
    await assert.rejects(as(role, { org: ids.A.org, user: ids.A.user }, (c) => c.query('select 1 from rate_limit_windows limit 1')), /permission denied/, role);
  }
});
