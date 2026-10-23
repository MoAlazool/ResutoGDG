// Counter sessions (20261023040001, FT-07): a visit is either a table visit (table required) or a counter visit (no
// table), the branch venue credential is a sha256 hash with its nonce (both or neither, one branch per hash), and
// counter visits stay inside their restaurant under RLS. Runs against its own freshly migrated disposable database
// (<TEST_DATABASE_URL>_counter), so it can run in parallel with rls.test.mjs, which resets the base one.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrate } from '../../scripts/db/migrate.mjs';
import { ensureDatabase } from '../../scripts/db/ensure-db.mjs';

const base = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:54329/resuto_test';
const url = base.replace(/\/([^/?]+)(\?.*)?$/, (_m, db, q = '') => `/${db}_counter${q}`);
const pool = new pg.Pool({ connectionString: url, max: 4 });
const sha = (s) => createHash('sha256').update(s).digest('hex');
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
    const [u] = await q(`insert into auth.users(email) values ($1) returning id`, [`counter-owner${k}@example.test`]);
    const [o] = await q(`insert into organizations(slug, name) values ($1, $2) returning id`, [`counter-${k.toLowerCase()}`, `Counter ${k}`]);
    const [b] = await q(`insert into branches(org_id, code, name, service_mode, accepts_dine_in) values ($1, 'main', 'Main', 'counter', false) returning id`, [o.id]);
    await q(`insert into memberships(org_id, user_id, role) values ($1, $2, 'owner')`, [o.id, u.id]);
    const [t] = await q(`insert into dining_tables(org_id, branch_id, label, capacity, qr_token) values ($1, $2, 'T1', 4, $3) returning id`, [o.id, b.id, `qr-counter-${k}-0123456789`]);
    const [v] = await q(`insert into visits(org_id, branch_id, table_id, kind, guest_token_hash, opened_via) values ($1, $2, null, 'counter', $3, 'qr') returning id`,
      [o.id, b.id, sha(`counter-visit-${k}`)]);
    ids[k] = { user: u.id, org: o.id, branch: b.id, table: t.id, visit: v.id };
  }
});

after(async () => pool.end());

test('a visit has a table exactly when it is a table visit', async () => {
  const insert = (kind, table) => q(`insert into visits(org_id, branch_id, table_id, kind, guest_token_hash) values ($1, $2, $3, $4, $5)`,
    [ids.A.org, ids.A.branch, table, kind, sha(randomUUID())]);
  await assert.rejects(insert('table', null), /visits_kind_table/);
  await assert.rejects(insert('counter', ids.A.table), /visits_kind_table/);
  await assert.rejects(insert('takeaway', null), /check constraint/);
  // Existing rows and inserts that do not name a kind stay table visits.
  await assert.rejects(q(`insert into visits(org_id, branch_id, guest_token_hash) values ($1, $2, $3)`, [ids.A.org, ids.A.branch, sha(randomUUID())]), /visits_kind_table/);
  const [ok] = await q(`insert into visits(org_id, branch_id, table_id, guest_token_hash) values ($1, $2, $3, $4) returning kind`, [ids.A.org, ids.A.branch, ids.A.table, sha(randomUUID())]);
  assert.equal(ok.kind, 'table');
  // Many counter visits may be open at once in one branch (the one-open-visit rule is per table).
  await insert('counter', null);
  await insert('counter', null);
});

test('the venue credential is a sha256 hash with its nonce, never one without the other, and unique across branches', async () => {
  const hash = sha('venue-token-A');
  await assert.rejects(q(`update branches set venue_qr_hash = $2 where id = $1`, [ids.A.branch, hash]), /branches_venue_qr_pair/);
  await assert.rejects(q(`update branches set venue_qr_nonce = $2 where id = $1`, [ids.A.branch, randomUUID()]), /branches_venue_qr_pair/);
  await assert.rejects(q(`update branches set venue_qr_nonce = $2, venue_qr_hash = 'plain-token-not-a-hash' where id = $1`, [ids.A.branch, randomUUID()]), /check constraint/);
  await q(`update branches set venue_qr_nonce = $2, venue_qr_hash = $3 where id = $1`, [ids.A.branch, randomUUID(), hash]);
  await assert.rejects(q(`update branches set venue_qr_nonce = $2, venue_qr_hash = $3 where id = $1`, [ids.B.branch, randomUUID(), hash]), /branches_venue_qr_hash_key/);
});

test('counter visits stay inside their restaurant: staff and the guest path see only their own', async () => {
  const own = await as('resuto_member', { user: ids.A.user, org: ids.A.org }, (c) => c.query(`select id from visits where kind = 'counter'`));
  assert.ok(own.rows.length >= 1);
  assert.ok(own.rows.every((r) => r.id !== ids.B.visit));
  const forged = await as('resuto_member', { user: ids.A.user, org: ids.B.org }, (c) => c.query(`select id from visits where id = $1`, [ids.B.visit]));
  assert.equal(forged.rowCount, 0);
  const guest = await as('resuto_tenant', { org: ids.A.org }, (c) => c.query(`select id from visits where id = $1`, [ids.B.visit]));
  assert.equal(guest.rowCount, 0);
  await assert.rejects(as('resuto_tenant', { org: ids.A.org }, (c) =>
    c.query(`insert into visits(org_id, branch_id, table_id, kind, guest_token_hash) values ($1, $2, null, 'counter', $3)`, [ids.B.org, ids.B.branch, sha(randomUUID())])), /row-level security/);
});

test('client roles get nothing on the new columns', async () => {
  const roles = await q(`select rolname from pg_roles where rolname in ('anon', 'authenticated')`);
  for (const { rolname } of roles) {
    const [r] = await q(`select has_column_privilege($1, 'public.branches', 'venue_qr_hash', 'select') as hash, has_column_privilege($1, 'public.visits', 'kind', 'select') as kind,
                                has_column_privilege($1, 'public.branches', 'venue_qr_legacy_revoked_at', 'update') as revoke`, [rolname]);
    assert.deepEqual(r, { hash: false, kind: false, revoke: false });
  }
});
