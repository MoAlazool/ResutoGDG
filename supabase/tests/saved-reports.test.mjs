// 21-INSIGHTS migration 20261026300001: saved_reports. A staff session (resuto_member) reads its own reports and the
// reports colleagues shared when its role may read analytics; it writes only its own rows. Never another
// restaurant's (also with a forged org), never a colleague's private report, never a report pinned to a branch outside
// its scope, not after the membership ends. Tenant, platform and client roles have no access.
// Own disposable database (<TEST_DATABASE_URL>_reports).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { migrate } from '../../scripts/db/migrate.mjs';
import { ensureDatabase } from '../../scripts/db/ensure-db.mjs';

const base = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:54329/resuto_test';
const url = base.replace(/\/([^/?]+)(\?.*)?$/, (_m, db, q = '') => `/${db}_reports${q}`);
const pool = new pg.Pool({ connectionString: url, max: 4 });
const ids = {};
const VIEW = { period: '7d', compare: 'previous_period', filters: {} };

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

const q = (sql, params) => pool.query(sql, params).then((r) => r.rows);
const names = (role, opts) => as(role, opts, (c) => c.query('select name from saved_reports order by name')).then((r) => r.rows.map((x) => x.name), (e) => e.message);
const insert = (org, user, name, { shared = false, branch = null } = {}) =>
  q(`insert into saved_reports(org_id, user_id, branch_id, name, section, view, shared) values ($1, $2, $3, $4, 'sales', $5, $6) returning id`,
    [org, user, branch, name, VIEW, shared]).then((r) => r[0].id);

before(async () => {
  await ensureDatabase(url);
  await migrate({ url, reset: true, log: () => {} });
  for (const k of ['A', 'B']) {
    const users = {};
    for (const role of ['owner', 'manager', 'cashier', 'accountant', 'scoped']) {
      [users[role]] = await q(`insert into auth.users(email) values ($1) returning id`, [`reports-${role}${k}@example.test`]);
    }
    const [o] = await q(`insert into organizations(slug, name) values ($1, $2) returning id`, [`reports-${k.toLowerCase()}`, `Reports ${k}`]);
    const [main] = await q(`insert into branches(org_id, code, name) values ($1, 'main', 'Main') returning id`, [o.id]);
    const [north] = await q(`insert into branches(org_id, code, name) values ($1, 'north', 'North') returning id`, [o.id]);
    await q(`insert into memberships(org_id, user_id, role) values ($1, $2, 'owner'), ($1, $3, 'manager'), ($1, $4, 'cashier'), ($1, $5, 'accountant')`,
      [o.id, users.owner.id, users.manager.id, users.cashier.id, users.accountant.id]);
    await q(`insert into memberships(org_id, user_id, role, branch_ids) values ($1, $2, 'manager', $3)`, [o.id, users.scoped.id, [main.id]]);
    ids[k] = { org: o.id, main: main.id, north: north.id, ...Object.fromEntries(Object.entries(users).map(([r, u]) => [r, u.id])) };
    await insert(o.id, users.owner.id, `${k} owner private`);
    await insert(o.id, users.owner.id, `${k} owner shared`, { shared: true });
    await insert(o.id, users.owner.id, `${k} owner shared north`, { shared: true, branch: north.id });
    await insert(o.id, users.manager.id, `${k} manager private`);
  }
});

after(async () => pool.end());

test('RLS is on, client, tenant and platform roles have no grant, and only member policies exist', async () => {
  const [{ relrowsecurity }] = await q(`select relrowsecurity from pg_class where oid = 'public.saved_reports'::regclass`);
  assert.equal(relrowsecurity, true);
  for (const role of ['anon', 'authenticated', 'resuto_tenant', 'resuto_platform']) {
    const [p] = await q(`select has_table_privilege($1, 'public.saved_reports', 'select') as s, has_table_privilege($1, 'public.saved_reports', 'insert') as i,
      has_table_privilege($1, 'public.saved_reports', 'update') as u, has_table_privilege($1, 'public.saved_reports', 'delete') as d`, [role]);
    assert.deepEqual(p, { s: false, i: false, u: false, d: false }, role);
  }
  const policies = await q(`select policyname, cmd, roles::text[] as roles from pg_policies where schemaname = 'public' and tablename = 'saved_reports' order by policyname`);
  assert.deepEqual(policies.map((p) => [p.policyname, p.cmd]), [['saved_reports_delete', 'DELETE'], ['saved_reports_insert', 'INSERT'], ['saved_reports_read', 'SELECT'], ['saved_reports_update', 'UPDATE']]);
  for (const p of policies) assert.deepEqual(p.roles, ['resuto_member']);
  const [{ definer }] = await q(`select prosecdef as definer from pg_proc where oid = 'app.can_read_analytics(uuid)'::regprocedure`);
  assert.equal(definer, true);
  assert.equal((await q(`select has_function_privilege('anon', 'app.can_read_analytics(uuid)', 'execute') as x`))[0].x, false);
});

test('own reports plus colleagues\' shared reports, for roles that may read analytics', async () => {
  const A = ids.A;
  assert.deepEqual(await names('resuto_member', { user: A.owner, org: A.org }), ['A owner private', 'A owner shared', 'A owner shared north']);
  assert.deepEqual(await names('resuto_member', { user: A.manager, org: A.org }), ['A manager private', 'A owner shared', 'A owner shared north']);
  // An accountant reads analytics: the shared ones. A cashier does not: nothing (they have none of their own).
  assert.deepEqual(await names('resuto_member', { user: A.accountant, org: A.org }), ['A owner shared', 'A owner shared north']);
  assert.deepEqual(await names('resuto_member', { user: A.cashier, org: A.org }), []);
});

test('a report pinned to a branch is hidden from staff without that branch', async () => {
  const A = ids.A;
  assert.deepEqual(await names('resuto_member', { user: A.scoped, org: A.org }), ['A owner shared']);
  await assert.rejects(as('resuto_member', { user: A.scoped, org: A.org }, (c) => c.query(
    `insert into saved_reports(org_id, user_id, branch_id, name, section, view) values ($1, $2, $3, 'north', 'sales', '{}')`, [A.org, A.scoped, A.north])),
    // The same-org trigger runs first and cannot see the branch through the branches RLS; either way it is refused.
    /row-level security|does not belong/);
  const ok = await as('resuto_member', { user: A.scoped, org: A.org }, async (c) => {
    await c.query(`insert into saved_reports(org_id, user_id, branch_id, name, section, view) values ($1, $2, $3, 'main', 'sales', '{}')`, [A.org, A.scoped, A.main]);
    // Moving it to a branch outside the scope is refused.
    await c.query('savepoint s');
    const moved = await c.query(`update saved_reports set branch_id = $1 where name = 'main'`, [A.north]).then(() => 'moved', (e) => e.message);
    await c.query('rollback to savepoint s');
    return [(await c.query(`select name from saved_reports where user_id = $1`, [A.scoped])).rows.map((r) => r.name), moved];
  });
  assert.deepEqual(ok[0], ['main']);
  assert.match(ok[1], /row-level security|does not belong/);
});

test('a forged restaurant, a missing membership and an ended membership see nothing', async () => {
  const A = ids.A;
  assert.deepEqual(await names('resuto_member', { user: A.owner, org: ids.B.org }), []);
  assert.deepEqual(await names('resuto_member', { user: A.owner }), []);
  await q(`update memberships set status = 'suspended' where org_id = $1 and user_id = $2`, [A.org, A.manager]);
  try {
    assert.deepEqual(await names('resuto_member', { user: A.manager, org: A.org }), []);
  } finally {
    await q(`update memberships set status = 'active' where org_id = $1 and user_id = $2`, [A.org, A.manager]);
  }
  // A role that loses analytics:read stops seeing colleagues' shared reports (its own stay).
  await q(`update memberships set role = 'cashier' where org_id = $1 and user_id = $2`, [A.org, A.manager]);
  try {
    assert.deepEqual(await names('resuto_member', { user: A.manager, org: A.org }), ['A manager private']);
  } finally {
    await q(`update memberships set role = 'manager' where org_id = $1 and user_id = $2`, [A.org, A.manager]);
  }
});

test('writes are limited to the caller\'s own rows: a shared report cannot be changed or deleted by a colleague', async () => {
  const A = ids.A;
  const self = { user: A.manager, org: A.org };
  await assert.rejects(as('resuto_member', self, (c) => c.query(`insert into saved_reports(org_id, user_id, name, section, view) values ($1, $2, 'x', 'sales', '{}')`,
    [A.org, A.owner])), /row-level security/);
  await assert.rejects(as('resuto_member', self, (c) => c.query(`insert into saved_reports(org_id, user_id, name, section, view) values ($1, $2, 'x', 'sales', '{}')`,
    [ids.B.org, A.manager])), /row-level security/);
  await assert.rejects(as('resuto_member', self, (c) => c.query(`update saved_reports set user_id = $1 where name = 'A manager private'`, [A.owner])), /row-level security/);
  const touched = await as('resuto_member', self, async (c) => {
    const u = await c.query(`update saved_reports set name = 'mine now', shared = false where name = 'A owner shared'`);
    const d = await c.query(`delete from saved_reports where user_id <> $1`, [A.manager]);
    return [u.rowCount, d.rowCount];
  });
  assert.deepEqual(touched, [0, 0]);
  // The author can.
  const own = await as('resuto_member', { user: A.owner, org: A.org }, async (c) => {
    const u = await c.query(`update saved_reports set shared = false where name = 'A owner shared'`);
    return u.rowCount;
  });
  assert.equal(own, 1);
});

test('tenant and platform contexts cannot read or write saved reports', async () => {
  for (const role of ['resuto_tenant', 'resuto_platform']) {
    assert.match(String(await names(role, { org: ids.A.org })), /permission denied/, role);
  }
  await assert.rejects(as('resuto_tenant', { org: ids.A.org }, (c) => c.query(`insert into saved_reports(org_id, user_id, name, section, view) values ($1, $2, 'x', 'sales', '{}')`,
    [ids.A.org, ids.A.owner])), /permission denied/);
  await assert.rejects(as('authenticated', { user: ids.A.owner }, (c) => c.query('select * from saved_reports')), /permission denied/);
  await assert.rejects(as('anon', {}, (c) => c.query('select * from saved_reports')), /permission denied/);
});

test('constraints: trimmed bounded names, unique per user (case-insensitive), small JSON views, branch of the same restaurant', async () => {
  const A = ids.A;
  await assert.rejects(insert(A.org, A.owner, ''), /check constraint/);
  await assert.rejects(insert(A.org, A.owner, ' padded '), /check constraint/);
  await assert.rejects(insert(A.org, A.owner, 'x'.repeat(81)), /check constraint/);
  await assert.rejects(insert(A.org, A.owner, 'a owner PRIVATE'), /duplicate key/);
  // Another user may use the same name.
  await insert(A.org, A.accountant, 'A owner private');
  await assert.rejects(q(`insert into saved_reports(org_id, user_id, name, section, view) values ($1, $2, 'bad section', 'Sales!', '{}')`, [A.org, A.owner]), /check constraint/);
  await assert.rejects(q(`insert into saved_reports(org_id, user_id, name, section, view) values ($1, $2, 'array', 'sales', '[]')`, [A.org, A.owner]), /check constraint/);
  await assert.rejects(q(`insert into saved_reports(org_id, user_id, name, section, view) values ($1, $2, 'big', 'sales', $3)`,
    [A.org, A.owner, { pad: randomBytes(6000).toString('hex') }]), /check constraint/);
  await assert.rejects(insert(A.org, A.owner, 'foreign branch', { branch: ids.B.main }), /does not belong/);
});

test('deleting the user, the branch or the restaurant removes their reports', async () => {
  const A = ids.A;
  const [u] = await q(`insert into auth.users(email) values ('reports-gone@example.test') returning id`);
  await q(`insert into memberships(org_id, user_id, role) values ($1, $2, 'manager')`, [A.org, u.id]);
  await insert(A.org, u.id, 'gone');
  await q(`delete from memberships where user_id = $1`, [u.id]);
  await q(`delete from auth.users where id = $1`, [u.id]);
  assert.equal((await q(`select count(*)::int as n from saved_reports where user_id = $1`, [u.id]))[0].n, 0);
  const [b] = await q(`insert into branches(org_id, code, name) values ($1, 'popup', 'Pop-up') returning id`, [A.org]);
  await insert(A.org, A.owner, 'pop-up', { branch: b.id });
  await q(`delete from branches where id = $1`, [b.id]);
  assert.equal((await q(`select count(*)::int as n from saved_reports where name = 'pop-up'`))[0].n, 0);
  await q(`delete from organizations where id = $1`, [ids.B.org]);
  assert.equal((await q(`select count(*)::int as n from saved_reports where org_id = $1`, [ids.B.org]))[0].n, 0);
});
