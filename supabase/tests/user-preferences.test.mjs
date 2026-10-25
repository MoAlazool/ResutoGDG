// 21-HOME migration 20261025400001: user_preferences rows belong to one user in one restaurant. A staff session
// (resuto_member) reads and writes only its own user's rows in the current restaurant with an active membership:
// never a colleague's (owners included), never another restaurant's (also with a forged org), not after the
// membership ends, and it cannot write a row for someone else. Tenant, platform and client roles have no access.
// Own disposable database (<TEST_DATABASE_URL>_prefs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { migrate } from '../../scripts/db/migrate.mjs';
import { ensureDatabase } from '../../scripts/db/ensure-db.mjs';

const base = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:54329/resuto_test';
const url = base.replace(/\/([^/?]+)(\?.*)?$/, (_m, db, q = '') => `/${db}_prefs${q}`);
const pool = new pg.Pool({ connectionString: url, max: 4 });
const ids = {};
const LAYOUT = { sections: [{ id: 'attention', visible: true }, { id: 'now', visible: false }] };

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
const rows = (role, opts) => as(role, opts, (c) => c.query('select org_id, user_id, value from user_preferences order by user_id')).then((r) => r.rows, (e) => e.message);

before(async () => {
  await ensureDatabase(url);
  await migrate({ url, reset: true, log: () => {} });
  for (const k of ['A', 'B']) {
    const [owner] = await q(`insert into auth.users(email) values ($1) returning id`, [`prefs-owner${k}@example.test`]);
    const [manager] = await q(`insert into auth.users(email) values ($1) returning id`, [`prefs-manager${k}@example.test`]);
    const [o] = await q(`insert into organizations(slug, name) values ($1, $2) returning id`, [`prefs-${k.toLowerCase()}`, `Prefs ${k}`]);
    await q(`insert into memberships(org_id, user_id, role) values ($1, $2, 'owner'), ($1, $3, 'manager')`, [o.id, owner.id, manager.id]);
    for (const u of [owner.id, manager.id]) {
      await q(`insert into user_preferences(org_id, user_id, scope, value) values ($1, $2, 'overview', $3)`, [o.id, u, { sections: [{ id: 'now', visible: true, by: u }] }]);
    }
    ids[k] = { org: o.id, owner: owner.id, manager: manager.id };
  }
  // A user who belongs to both restaurants (owner of A, manager of B has their own row in B only via membership).
  await q(`insert into memberships(org_id, user_id, role) values ($1, $2, 'manager')`, [ids.B.org, ids.A.owner]);
  await q(`insert into user_preferences(org_id, user_id, scope, value) values ($1, $2, 'overview', $3)`, [ids.B.org, ids.A.owner, LAYOUT]);
});

after(async () => pool.end());

test('RLS is on and client roles have no grant and no policy', async () => {
  const [{ relrowsecurity }] = await q(`select relrowsecurity from pg_class where oid = 'public.user_preferences'::regclass`);
  assert.equal(relrowsecurity, true);
  for (const role of ['anon', 'authenticated', 'resuto_tenant', 'resuto_platform']) {
    const [p] = await q(`select has_table_privilege($1, 'public.user_preferences', 'select') as s, has_table_privilege($1, 'public.user_preferences', 'insert') as i,
      has_table_privilege($1, 'public.user_preferences', 'update') as u, has_table_privilege($1, 'public.user_preferences', 'delete') as d`, [role]);
    assert.deepEqual(p, { s: false, i: false, u: false, d: false }, role);
  }
  const policies = await q(`select policyname, roles::text[] as roles from pg_policies where schemaname = 'public' and tablename = 'user_preferences'`);
  assert.deepEqual(policies.map((p) => p.policyname), ['user_preferences_self']);
  assert.deepEqual(policies[0].roles, ['resuto_member']);
});

test('a staff member sees only their own row in the current restaurant', async () => {
  const own = await rows('resuto_member', { user: ids.A.manager, org: ids.A.org });
  assert.equal(own.length, 1);
  assert.equal(own[0].user_id, ids.A.manager);
  // The owner does not see the manager's layout, nor the manager the owner's.
  const owner = await rows('resuto_member', { user: ids.A.owner, org: ids.A.org });
  assert.deepEqual(owner.map((r) => r.user_id), [ids.A.owner]);
  // The same person in another restaurant sees only that restaurant's row.
  const inB = await rows('resuto_member', { user: ids.A.owner, org: ids.B.org });
  assert.deepEqual(inB.map((r) => [r.org_id, r.user_id]), [[ids.B.org, ids.A.owner]]);
  assert.deepEqual(inB[0].value, LAYOUT);
});

test('a forged restaurant, a missing membership and an ended membership see nothing', async () => {
  assert.deepEqual(await rows('resuto_member', { user: ids.A.manager, org: ids.B.org }), []);
  assert.deepEqual(await rows('resuto_member', { user: ids.A.manager }), []);
  await q(`update memberships set status = 'suspended' where org_id = $1 and user_id = $2`, [ids.B.org, ids.B.manager]);
  try {
    assert.deepEqual(await rows('resuto_member', { user: ids.B.manager, org: ids.B.org }), []);
  } finally {
    await q(`update memberships set status = 'active' where org_id = $1 and user_id = $2`, [ids.B.org, ids.B.manager]);
  }
});

test('writes are limited to the caller\'s own row (with check), and other rows cannot be changed or deleted', async () => {
  const self = { user: ids.A.manager, org: ids.A.org };
  // Upsert of the own row works.
  const ok = await as('resuto_member', self, async (c) => {
    await c.query(`insert into user_preferences(org_id, user_id, scope, value) values ($1, $2, 'overview', $3)
      on conflict (org_id, user_id, scope) do update set value = excluded.value`, [ids.A.org, ids.A.manager, LAYOUT]);
    return (await c.query('select value from user_preferences')).rows;
  });
  assert.deepEqual(ok, [{ value: LAYOUT }]);
  // A row for a colleague, or for another restaurant, is refused by the policy.
  await assert.rejects(as('resuto_member', self, (c) => c.query(`insert into user_preferences(org_id, user_id, scope, value) values ($1, $2, 'overview', '{}')
    on conflict (org_id, user_id, scope) do update set value = excluded.value`, [ids.A.org, ids.A.owner])), /row-level security/);
  await assert.rejects(as('resuto_member', self, (c) => c.query(`insert into user_preferences(org_id, user_id, scope, value) values ($1, $2, 'overview', '{}')`,
    [ids.B.org, ids.A.manager])), /row-level security/);
  // Moving the own row to another user is refused; updates and deletes of others' rows touch nothing.
  await assert.rejects(as('resuto_member', self, (c) => c.query(`update user_preferences set user_id = $1`, [ids.A.owner])), /row-level security/);
  const touched = await as('resuto_member', self, async (c) => {
    const u = await c.query(`update user_preferences set value = '{}' where user_id = $1`, [ids.A.owner]);
    const d = await c.query(`delete from user_preferences where user_id <> $1`, [ids.A.manager]);
    return [u.rowCount, d.rowCount];
  });
  assert.deepEqual(touched, [0, 0]);
});

test('tenant and platform contexts cannot read or write preferences', async () => {
  for (const role of ['resuto_tenant', 'resuto_platform']) {
    assert.match(String(await rows(role, { org: ids.A.org })), /permission denied/, role);
  }
  await assert.rejects(as('resuto_tenant', { org: ids.A.org }, (c) => c.query(`insert into user_preferences(org_id, user_id, scope, value) values ($1, $2, 'overview', '{}')`,
    [ids.A.org, ids.A.owner])), /permission denied/);
  await assert.rejects(as('authenticated', { user: ids.A.owner }, (c) => c.query('select * from user_preferences')), /permission denied/);
});

test('values are small JSON objects of a known scope', async () => {
  await assert.rejects(q(`insert into user_preferences(org_id, user_id, scope, value) values ($1, $2, 'theme', '{}')`, [ids.A.org, ids.A.manager]), /check constraint/);
  await assert.rejects(q(`insert into user_preferences(org_id, user_id, scope, value) values ($1, $2, 'overview', '[]')
    on conflict (org_id, user_id, scope) do update set value = excluded.value`, [ids.A.org, ids.A.manager]), /check constraint/);
  const big = { sections: [], pad: randomBytes(10000).toString('hex') };
  await assert.rejects(q(`update user_preferences set value = $3 where org_id = $1 and user_id = $2`, [ids.A.org, ids.A.manager, big]), /check constraint/);
});

test('deleting the restaurant or the user removes their preferences', async () => {
  const [u] = await q(`insert into auth.users(email) values ('prefs-gone@example.test') returning id`);
  await q(`insert into memberships(org_id, user_id, role) values ($1, $2, 'manager')`, [ids.A.org, u.id]);
  await q(`insert into user_preferences(org_id, user_id, scope, value) values ($1, $2, 'overview', '{}')`, [ids.A.org, u.id]);
  await q(`delete from memberships where user_id = $1`, [u.id]);
  await q(`delete from auth.users where id = $1`, [u.id]);
  assert.equal((await q(`select count(*)::int as n from user_preferences where user_id = $1`, [u.id]))[0].n, 0);
});
