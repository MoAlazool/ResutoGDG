// Guest ratings (20261020060001): tenant isolation, staff read-only, immutability, one rating per paid thing, and
// score/shape constraints. Runs against its own freshly migrated disposable database (<TEST_DATABASE_URL>_ratings),
// so it can run in parallel with rls.test.mjs, which resets the base one.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { migrate } from '../../scripts/db/migrate.mjs';
import { ensureDatabase } from '../../scripts/db/ensure-db.mjs';

const base = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:54329/resuto_test';
const url = base.replace(/\/([^/?]+)(\?.*)?$/, (_m, db, q = '') => `/${db}_ratings${q}`);
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

before(async () => {
  await ensureDatabase(url);
  await migrate({ url, reset: true, log: () => {} });
  const q = (sql, params) => pool.query(sql, params).then((r) => r.rows);
  for (const k of ['A', 'B']) {
    const [u] = await q(`insert into auth.users(email) values ($1) returning id`, [`rating-owner${k}@example.test`]);
    const [o] = await q(`insert into organizations(slug, name) values ($1, $2) returning id`, [`rating-${k.toLowerCase()}`, `Rated ${k}`]);
    const [b] = await q(`insert into branches(org_id, code, name) values ($1, 'main', 'Main') returning id`, [o.id]);
    await q(`insert into memberships(org_id, user_id, role) values ($1, $2, 'owner')`, [o.id, u.id]);
    const [t] = await q(`insert into dining_tables(org_id, branch_id, label, capacity, qr_token) values ($1, $2, 'T1', 4, $3) returning id`, [o.id, b.id, `qr-rating-${k}-0123456789`]);
    const [v] = await q(`insert into visits(org_id, branch_id, table_id, guest_token_hash, opened_via) values ($1, $2, $3, $4, 'qr') returning id`, [o.id, b.id, t.id, `hash-${k}`]);
    const [order] = await q(`insert into orders(org_id, branch_id, number, channel, fulfillment, currency, subtotal_minor, total_minor)
             values ($1, $2, '9', 'web', 'pickup', 'EGP', 5000, 5000) returning id`, [o.id, b.id]);
    await q(`insert into guest_ratings(org_id, branch_id, source, visit_id, overall, food, comment) values ($1, $2, 'table', $3, 5, 4, 'Lovely')`, [o.id, b.id, v.id]);
    ids[k] = { user: u.id, org: o.id, branch: b.id, visit: v.id, order: order.id };
  }
});

after(async () => pool.end());

test('staff read only their own restaurant\'s ratings, even with a forged org', async () => {
  const own = await as('resuto_member', { user: ids.A.user, org: ids.A.org }, (c) => c.query('select org_id, overall from guest_ratings'));
  assert.equal(own.rowCount, 1);
  assert.equal(own.rows[0].org_id, ids.A.org);
  const forged = await as('resuto_member', { user: ids.A.user, org: ids.B.org }, (c) => c.query('select * from guest_ratings'));
  assert.equal(forged.rowCount, 0);
});

test('staff sessions cannot write or edit ratings; the guest path (tenant role) cannot edit either', async () => {
  await assert.rejects(as('resuto_member', { user: ids.A.user, org: ids.A.org }, (c) =>
    c.query(`insert into guest_ratings(org_id, branch_id, source, order_id, overall) values ($1, $2, 'web', $3, 1)`, [ids.A.org, ids.A.branch, ids.A.order])), /permission denied/);
  await assert.rejects(as('resuto_member', { user: ids.A.user, org: ids.A.org }, (c) => c.query(`update guest_ratings set overall = 1`)), /permission denied/);
  await assert.rejects(as('resuto_member', { user: ids.A.user, org: ids.A.org }, (c) => c.query(`delete from guest_ratings`)), /permission denied/);
  await assert.rejects(as('resuto_tenant', { org: ids.A.org }, (c) => c.query(`update guest_ratings set overall = 1`)), /permission denied/);
  // The tenant role inserts only into its own organisation.
  await assert.rejects(as('resuto_tenant', { org: ids.A.org }, (c) =>
    c.query(`insert into guest_ratings(org_id, branch_id, source, order_id, overall) values ($1, $2, 'web', $3, 4)`, [ids.B.org, ids.B.branch, ids.B.order])), /row-level security/);
  const ok = await as('resuto_tenant', { org: ids.A.org }, (c) =>
    c.query(`insert into guest_ratings(org_id, branch_id, source, order_id, overall) values ($1, $2, 'web', $3, 4) returning id`, [ids.A.org, ids.A.branch, ids.A.order]));
  assert.equal(ok.rowCount, 1);
});

test('one rating per visit, scores 1-5, and the source matches what was paid for', async () => {
  const insert = (sql, params) => pool.query(sql, params);
  await assert.rejects(insert(`insert into guest_ratings(org_id, branch_id, source, visit_id, overall) values ($1, $2, 'table', $3, 3)`, [ids.A.org, ids.A.branch, ids.A.visit]), /guest_ratings_one_per_visit/);
  for (const bad of [0, 6]) {
    await assert.rejects(insert(`insert into guest_ratings(org_id, branch_id, source, order_id, overall) values ($1, $2, 'web', $3, $4)`, [ids.B.org, ids.B.branch, ids.B.order, bad]), /check constraint/);
  }
  await assert.rejects(insert(`insert into guest_ratings(org_id, branch_id, source, order_id, overall, service) values ($1, $2, 'web', $3, 4, 9)`, [ids.B.org, ids.B.branch, ids.B.order]), /check constraint/);
  // A web rating must point at an order (and only an order); a table rating at a visit.
  await assert.rejects(insert(`insert into guest_ratings(org_id, branch_id, source, visit_id, overall) values ($1, $2, 'web', $3, 4)`, [ids.B.org, ids.B.branch, ids.B.visit]), /check constraint/);
  await assert.rejects(insert(`insert into guest_ratings(org_id, branch_id, source, overall) values ($1, $2, 'table', 4)`, [ids.B.org, ids.B.branch]), /check constraint/);
  await assert.rejects(insert(`insert into guest_ratings(org_id, branch_id, source, order_id, overall, comment) values ($1, $2, 'web', $3, 4, $4)`, [ids.B.org, ids.B.branch, ids.B.order, 'x'.repeat(1001)]), /check constraint/);
});

test('direct Supabase clients have no access to ratings', async () => {
  await assert.rejects(as('authenticated', { user: ids.A.user }, (c) => c.query('select * from guest_ratings')), /permission denied/);
  await assert.rejects(as('anon', {}, (c) => c.query('select * from guest_ratings')), /permission denied/);
});
