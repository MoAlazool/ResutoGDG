// 21-CS migration 20261025100000: change_sets, change_ops, change_effects, change_decisions and change_policies are
// tenant-isolated (staff and tenant roles see and write only their restaurant, including with a forged org), staff
// sessions cannot write the effects outbox or edit decisions, anon and authenticated sessions see nothing, the platform
// role may only read sets and effects (job resolution), and the status/op checks refuse unknown values.
// Own disposable database (<TEST_DATABASE_URL>_changes).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { migrate } from '../../scripts/db/migrate.mjs';
import { ensureDatabase } from '../../scripts/db/ensure-db.mjs';

const base = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:54329/resuto_test';
const url = base.replace(/\/([^/?]+)(\?.*)?$/, (_m, db, q = '') => `/${db}_changes${q}`);
const pool = new pg.Pool({ connectionString: url, max: 4 });
const ids = {};
const TABLES = ['change_sets', 'change_ops', 'change_effects', 'change_decisions', 'change_policies'];

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

const count = (role, opts, table) => as(role, opts, (c) => c.query(`select count(*)::int as n from ${table}`)).then((r) => r.rows[0].n, (e) => e.message);

before(async () => {
  await ensureDatabase(url);
  await migrate({ url, reset: true, log: () => {} });
  const q = (sql, params) => pool.query(sql, params).then((r) => r.rows);
  for (const k of ['A', 'B']) {
    const [u] = await q(`insert into auth.users(email) values ($1) returning id`, [`cs-owner${k}@example.test`]);
    const [o] = await q(`insert into organizations(slug, name) values ($1, $2) returning id`, [`cs-${k.toLowerCase()}`, `Changes ${k}`]);
    await q(`insert into memberships(org_id, user_id, role) values ($1, $2, 'owner')`, [o.id, u.id]);
    const [cs] = await q(`insert into change_sets(org_id, origin, actor_type, actor_id, proposed_by, title, status) values ($1, 'staff', 'user', $2::text, $2::uuid, 'T', 'pending_approval') returning id`, [o.id, u.id]);
    const [op] = await q(`insert into change_ops(org_id, change_set_id, seq, op_type, op_group, kind, input) values ($1, $2, 0, 'payment_link.create', 'payments', 'effect', '{}') returning id`, [o.id, cs.id]);
    await q(`insert into change_effects(org_id, change_set_id, op_id, provider_key) values ($1, $2, $3, $4)`, [o.id, cs.id, op.id, `${cs.id}:${op.id}`]);
    await q(`insert into change_decisions(change_set_id, org_id, user_id, role, decision) values ($1, $2, $3, 'owner', 'approved')`, [cs.id, o.id, u.id]);
    await q(`insert into change_policies(org_id, op_group, mode) values ($1, 'prices', 'blocked')`, [o.id]);
    ids[k] = { user: u.id, org: o.id, cs: cs.id, op: op.id };
  }
});

after(async () => pool.end());

test('staff see only their own restaurant\'s change-set rows, and nothing with a forged org', async () => {
  for (const table of TABLES) {
    assert.equal(await count('resuto_member', { user: ids.A.user, org: ids.A.org }, table), 1, `${table} own`);
    assert.equal(await count('resuto_member', { user: ids.A.user, org: ids.B.org }, table), 0, `${table} forged`);
    assert.equal(await count('resuto_tenant', { org: ids.B.org }, table), 1, `${table} tenant`);
  }
  const forged = await as('resuto_member', { user: ids.A.user, org: ids.B.org }, (c) => c.query('select id from change_sets where id = $1', [ids.B.cs]));
  assert.equal(forged.rowCount, 0);
});

test('a session cannot write into another restaurant (RLS with check)', async () => {
  await assert.rejects(as('resuto_member', { user: ids.A.user, org: ids.A.org }, (c) => c.query(
    `insert into change_sets(org_id, origin, actor_type, actor_id, title) values ($1, 'staff', 'user', $2, 'x')`, [ids.B.org, ids.A.user])), /row-level security/);
  await assert.rejects(as('resuto_tenant', { org: ids.A.org }, (c) => c.query(
    `insert into change_ops(org_id, change_set_id, seq, op_type, op_group, kind, input) values ($1, $2, 1, 'website.publish', 'website_publish', 'local', '{}')`,
    [ids.B.org, ids.B.cs])), /row-level security/);
  const moved = await as('resuto_tenant', { org: ids.A.org }, (c) => c.query(`update change_sets set status = 'approved' where id = $1`, [ids.B.cs]));
  assert.equal(moved.rowCount, 0);
  const policy = await as('resuto_member', { user: ids.A.user, org: ids.A.org }, (c) => c.query(`update change_policies set mode = 'auto' where org_id = $1`, [ids.B.org]));
  assert.equal(policy.rowCount, 0);
  const [{ mode }] = (await pool.query(`select mode from change_policies where org_id = $1`, [ids.B.org])).rows;
  assert.equal(mode, 'blocked');
});

test('staff sessions cannot write the effects outbox or rewrite decisions', async () => {
  const own = { user: ids.A.user, org: ids.A.org };
  await assert.rejects(as('resuto_member', own, (c) => c.query(`update change_effects set status = 'succeeded'`)), /permission denied/);
  await assert.rejects(as('resuto_member', own, (c) => c.query(`delete from change_effects`)), /permission denied/);
  await assert.rejects(as('resuto_member', own, (c) => c.query(`update change_decisions set decision = 'rejected'`)), /permission denied/);
  await assert.rejects(as('resuto_member', own, (c) => c.query(`delete from change_decisions`)), /permission denied/);
  // The engine (tenant mode) settles effects of its own restaurant only.
  const settled = await as('resuto_tenant', { org: ids.A.org }, (c) => c.query(`update change_effects set status = 'succeeded' returning change_set_id`));
  assert.deepEqual(settled.rows.map((r) => r.change_set_id), [ids.A.cs]);
});

test('anon and signed-in sessions outside the API see nothing', async () => {
  for (const table of TABLES) {
    for (const [role, opts] of [['anon', {}], ['authenticated', { user: ids.A.user }]]) {
      const n = await count(role, opts, table);
      assert.ok(n === 0 || /permission denied/.test(String(n)), `${role} ${table}: ${n}`);
    }
    const [{ relrowsecurity }] = (await pool.query(`select relrowsecurity from pg_class where oid = $1::regclass`, [`public.${table}`])).rows;
    assert.equal(relrowsecurity, true, table);
  }
});

test('the platform role only reads change sets and effects (to find due work), and nothing else', async () => {
  assert.equal(await count('resuto_platform', {}, 'change_sets'), 2);
  assert.equal(await count('resuto_platform', {}, 'change_effects'), 2);
  for (const table of ['change_ops', 'change_decisions', 'change_policies']) {
    assert.match(String(await count('resuto_platform', {}, table)), /permission denied/, table);
  }
  await assert.rejects(as('resuto_platform', {}, (c) => c.query(`update change_sets set status = 'applied'`)), /permission denied/);
  await assert.rejects(as('resuto_platform', {}, (c) => c.query(`update change_effects set status = 'succeeded'`)), /permission denied/);
});

test('status, op type, group and policy checks refuse unknown values; approval_requested notifications are accepted', async () => {
  await assert.rejects(pool.query(`update change_sets set status = 'done' where id = $1`, [ids.A.cs]), /change_sets_status_check/);
  await assert.rejects(pool.query(`insert into change_ops(org_id, change_set_id, seq, op_type, op_group, kind, input) values ($1, $2, 5, 'sql.run', 'menu', 'local', '{}')`,
    [ids.A.org, ids.A.cs]), /change_ops_op_type_check/);
  await assert.rejects(pool.query(`insert into change_policies(org_id, op_group, mode) values ($1, 'everything', 'auto')`, [ids.A.org]), /change_policies_op_group_check/);
  await assert.rejects(pool.query(`insert into change_policies(org_id, op_group, mode, approvers) values ($1, 'menu', 'auto', 3)`, [ids.A.org]), /change_policies_approvers_check/);
  await assert.rejects(pool.query(`insert into change_effects(org_id, change_set_id, op_id, provider_key) values ($1, $2, $3, 'dup')`, [ids.A.org, ids.A.cs, ids.A.op]), /change_effects_op_id_key/);
  await pool.query(`insert into notifications(org_id, audience_permission, kind, template_key, dedupe_key) values ($1, 'changes:approve', 'approval_requested', 'approval_requested', 'cs-test')`, [ids.A.org]);
  await assert.rejects(pool.query(`insert into notifications(org_id, audience_permission, kind, template_key, dedupe_key) values ($1, 'x', 'bogus', 'x', 'cs-bogus')`, [ids.A.org]), /notifications_kind_check/);
});

test('mcp_approvals link to their change set; deleting the set keeps the approval readable', async () => {
  const [c] = (await pool.query(`insert into mcp_clients(org_id, name, key_prefix, key_hash, acting_role, allowed_tools, created_by) values ($1, 'C', 'rmcp_cs01', 'hash-cs', 'manager', '{}', $2) returning id`,
    [ids.A.org, ids.A.user])).rows;
  const [cs] = (await pool.query(`insert into change_sets(org_id, origin, actor_type, actor_id, mcp_client_id, title) values ($1, 'mcp', 'mcp_client', $2::text, $2::uuid, 'M') returning id`, [ids.A.org, c.id])).rows;
  const [a] = (await pool.query(`insert into mcp_approvals(org_id, client_id, tool, input, input_hash, summary, expires_at, change_set_id)
    values ($1, $2, 'create_payment_link', '{}', 'h', 's', now() + interval '1 hour', $3) returning id`, [ids.A.org, c.id, cs.id])).rows;
  await pool.query(`delete from change_sets where id = $1`, [cs.id]);
  const [row] = (await pool.query(`select change_set_id, summary from mcp_approvals where id = $1`, [a.id])).rows;
  assert.deepEqual(row, { change_set_id: null, summary: 's' });
});
