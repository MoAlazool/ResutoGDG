// Delivery zones (20261021020005) and finance policy/payouts (20261021020004): tenant isolation (a forged org sees
// and writes nothing), branch-scoped access for branch-limited staff, and the zone geometry checks.
// Runs against its own disposable database (<TEST_DATABASE_URL>_ws8z) so it can run in parallel with other files.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { migrate } from '../../scripts/db/migrate.mjs';
import { ensureDatabase } from '../../scripts/db/ensure-db.mjs';

const base = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:54329/resuto_test';
const url = base.replace(/\/([^/?]+)(\?.*)?$/, (_m, db, q = '') => `/${db}_ws8z${q}`);
const pool = new pg.Pool({ connectionString: url, max: 4 });
const ids = {};
const q = (sql, params) => pool.query(sql, params).then((r) => r.rows);

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
    const [u] = await q(`insert into auth.users(email) values ($1) returning id`, [`ws8z-owner${k}@example.test`]);
    const [o] = await q(`insert into organizations(slug, name) values ($1, $2) returning id`, [`ws8z-${k.toLowerCase()}`, `WS8Z ${k}`]);
    const [b] = await q(`insert into branches(org_id, code, name) values ($1, 'main', 'Main') returning id`, [o.id]);
    const [b2] = await q(`insert into branches(org_id, code, name) values ($1, 'second', 'Second') returning id`, [o.id]);
    await q(`insert into memberships(org_id, user_id, role) values ($1, $2, 'owner')`, [o.id, u.id]);
    await q(`insert into delivery_zones(org_id, branch_id, name, kind, fee_minor) values ($1, $2, 'Area', 'area', 1000), ($1, $3, 'Other branch', 'area', 2000)`, [o.id, b.id, b2.id]);
    await q(`insert into finance_settings(org_id, cogs_method) values ($1, 'purchases')`, [o.id]);
    await q(`insert into finance_payouts(org_id, provider, paid_on, amount_minor, currency) values ($1, 'paymob', current_date, 5000, 'EGP')`, [o.id]);
    ids[k] = { user: u.id, org: o.id, branch: b.id, branch2: b2.id };
  }
  const [m] = await q(`insert into auth.users(email) values ('ws8z-branch-manager@example.test') returning id`);
  await q(`insert into memberships(org_id, user_id, role, branch_ids) values ($1, $2, 'manager', $3)`, [ids.A.org, m.id, [ids.A.branch]]);
  ids.branchManager = m.id;
});

after(async () => pool.end());

test('a forged org reads and writes no zones, finance settings or payouts', async () => {
  for (const table of ['delivery_zones', 'finance_settings', 'finance_payouts']) {
    const own = await as('resuto_member', { user: ids.A.user, org: ids.A.org }, (c) => c.query(`select org_id from ${table}`));
    assert.ok(own.rowCount >= 1, table);
    assert.ok(own.rows.every((r) => r.org_id === ids.A.org), table);
    const forged = await as('resuto_member', { user: ids.A.user, org: ids.B.org }, (c) => c.query(`select * from ${table}`));
    assert.equal(forged.rowCount, 0, table);
  }
  await assert.rejects(as('resuto_member', { user: ids.A.user, org: ids.A.org }, (c) =>
    c.query(`insert into delivery_zones(org_id, branch_id, name, kind) values ($1, $2, 'Stolen', 'area')`, [ids.B.org, ids.B.branch])), /row-level security/);
  await assert.rejects(as('resuto_member', { user: ids.A.user, org: ids.A.org }, (c) =>
    c.query(`insert into finance_payouts(org_id, provider, paid_on, amount_minor, currency) values ($1, 'x', current_date, 1, 'EGP')`, [ids.B.org])), /row-level security/);
});

test('branch-limited staff see only their branches\' zones', async () => {
  const rows = await as('resuto_member', { user: ids.branchManager, org: ids.A.org }, (c) => c.query('select branch_id from delivery_zones'));
  assert.deepEqual(rows.rows.map((r) => r.branch_id), [ids.A.branch]);
});

test('zone geometry and money checks hold', async () => {
  const ins = (kind, radius, polygon, fee = 0) => q(`insert into delivery_zones(org_id, branch_id, name, kind, radius_m, polygon, fee_minor) values ($1, $2, 'z', $3, $4, $5, $6)`,
    [ids.A.org, ids.A.branch, kind, radius, polygon === null ? null : JSON.stringify(polygon), fee]);
  await assert.rejects(ins('radius', null, null), /check/);
  await assert.rejects(ins('radius', 50, null), /check/);
  await assert.rejects(ins('polygon', null, [[30, 31], [30, 31.1]]), /check/);
  await assert.rejects(ins('area', 1000, null), /check/);
  await assert.rejects(ins('area', null, null, -1), /check/);
  await ins('radius', 2000, null);
  await ins('polygon', null, [[30, 31], [30, 31.1], [30.1, 31.1]]);
  await assert.rejects(q(`insert into finance_settings(org_id, cogs_method) values ($1, 'fifo') on conflict (org_id) do update set cogs_method = excluded.cogs_method`, [ids.A.org]), /check/);
  await assert.rejects(q(`insert into finance_payouts(org_id, provider, paid_on, amount_minor, currency) values ($1, 'x', current_date, 0, 'EGP')`, [ids.A.org]), /check/);
});
