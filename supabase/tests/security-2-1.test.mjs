// 1D threat model (docs/security/THREAT_MODEL_2.1.md): database invariants behind tenant isolation.
//   - every table in the public schema has row-level security on (a new table cannot ship without it);
//   - mcp_sessions (migration 20261025200000), the one 2.1 table without its own negative test until now: staff and
//     tenant roles see only their restaurant's sessions (nothing with a forged org), staff sessions cannot write them,
//     anon and authenticated sessions see nothing, the platform role only reads and deletes (expiry cleanup).
// Own disposable database (<TEST_DATABASE_URL>_sec).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { migrate } from '../../scripts/db/migrate.mjs';
import { ensureDatabase } from '../../scripts/db/ensure-db.mjs';

const base = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:54329/resuto_test';
const url = base.replace(/\/([^/?]+)(\?.*)?$/, (_m, db, q = '') => `/${db}_sec${q}`);
const pool = new pg.Pool({ connectionString: url, max: 4 });
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
const count = (role, opts, sql = 'select count(*)::int as n from mcp_sessions') =>
  as(role, opts, (c) => c.query(sql)).then((r) => r.rows[0].n, (e) => e.message);

before(async () => {
  await ensureDatabase(url);
  await migrate({ url, reset: true, log: () => {} });
  const q = (sql, params) => pool.query(sql, params).then((r) => r.rows);
  for (const k of ['A', 'B']) {
    const [u] = await q(`insert into auth.users(email) values ($1) returning id`, [`sec-owner${k}@example.test`]);
    const [o] = await q(`insert into organizations(slug, name) values ($1, $2) returning id`, [`sec-${k.toLowerCase()}`, `Security ${k}`]);
    await q(`insert into memberships(org_id, user_id, role) values ($1, $2, 'owner')`, [o.id, u.id]);
    const [c] = await q(`insert into mcp_clients(org_id, name, key_prefix, key_hash, acting_role, allowed_tools, created_by)
                         values ($1, 'Assistant', $2, $3, 'manager', '{get_restaurant_profile}', $4) returning id`, [o.id, `rmcp_sec${k}`, `hash-sec-${k}`, u.id]);
    const [s] = await q(`insert into mcp_sessions(org_id, client_id, auth_kind, expires_at) values ($1, $2, 'key', now() + interval '1 hour') returning id`, [o.id, c.id]);
    ids[k] = { user: u.id, org: o.id, client: c.id, session: s.id };
  }
});

after(async () => pool.end());

test('every table in the public schema has row-level security enabled', async () => {
  const { rows } = await pool.query(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity order by 1`);
  assert.deepEqual(rows.map((r) => r.relname), []);
});

test('mcp_sessions: staff and tenant roles see only their restaurant, nothing with a forged org', async () => {
  assert.equal(await count('resuto_member', { user: ids.A.user, org: ids.A.org }), 1);
  assert.equal(await count('resuto_member', { user: ids.A.user, org: ids.B.org }), 0);
  assert.equal(await count('resuto_tenant', { org: ids.A.org }), 1);
  const forged = await as('resuto_tenant', { org: ids.A.org }, (c) => c.query('select id from mcp_sessions where id = $1', [ids.B.session]));
  assert.equal(forged.rowCount, 0);
  // The tenant role (MCP runtime) cannot open a session in another restaurant, nor move one there.
  await assert.rejects(as('resuto_tenant', { org: ids.A.org }, (c) => c.query(
    `insert into mcp_sessions(org_id, client_id, auth_kind, expires_at) values ($1, $2, 'key', now() + interval '1 hour')`, [ids.B.org, ids.B.client])),
  /row-level security/);
  const moved = await as('resuto_tenant', { org: ids.A.org }, (c) => c.query('update mcp_sessions set closed_at = now() where id = $1', [ids.B.session]));
  assert.equal(moved.rowCount, 0);
});

test('mcp_sessions: staff sessions only read; anon and authenticated see nothing; platform reads and deletes only', async () => {
  for (const sql of [`update mcp_sessions set closed_at = now()`, `delete from mcp_sessions`]) {
    await assert.rejects(as('resuto_member', { user: ids.A.user, org: ids.A.org }, (c) => c.query(sql)), /permission denied/);
  }
  for (const [role, opts] of [['anon', {}], ['authenticated', { user: ids.A.user }]]) {
    const n = await count(role, opts);
    assert.ok(n === 0 || /permission denied/.test(String(n)), `${role}: ${n}`);
  }
  assert.equal(await count('resuto_platform', {}), 2);
  await assert.rejects(as('resuto_platform', {}, (c) => c.query(`update mcp_sessions set closed_at = now()`)), /permission denied/);
});
