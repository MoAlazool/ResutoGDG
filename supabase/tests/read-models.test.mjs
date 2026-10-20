// Tenant isolation of the performance read models (PCL-17 customer stats, PCL-26 analytics rollups): members read only
// their tenant (and branch-scoped staff only their branches), nobody but the maintenance functions writes them, and
// the triggers keep them right even when the order writer is a branch-scoped member (security-definer maintenance).
// Uses its own database (<TEST_DATABASE_URL name>_read_models) so it can run next to rls.test.mjs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { migrate } from '../../scripts/db/migrate.mjs';

const base = new URL(process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:54329/resuto_test');
const name = `${base.pathname.slice(1)}_read_models`;
const url = new URL(base); url.pathname = `/${name}`;
const admin = new URL(base); admin.pathname = '/postgres';
let pool;
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
  if (!['127.0.0.1', 'localhost', '::1'].includes(base.hostname)) throw new Error('local databases only');
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`unsupported database name ${name}`);
  const c = new pg.Client({ connectionString: admin.toString() });
  await c.connect();
  try {
    await c.query(`drop database if exists ${name} with (force)`);
    await c.query(`create database ${name}`);
  } finally { await c.end(); }
  pool = new pg.Pool({ connectionString: url.toString(), max: 3 });
  await migrate({ url: url.toString(), log: () => {} });
  const q = (sql, params) => pool.query(sql, params).then((r) => r.rows);
  for (const k of ['A', 'B']) {
    const [u] = await q(`insert into auth.users(email) values ($1) returning id`, [`owner${k}@example.test`]);
    const [o] = await q(`insert into organizations(slug, name) values ($1, $2) returning id`, [`rm-${k.toLowerCase()}`, `Read models ${k}`]);
    const [main] = await q(`insert into branches(org_id, code, name) values ($1, 'main', 'Main') returning id`, [o.id]);
    const [north] = await q(`insert into branches(org_id, code, name) values ($1, 'north', 'North') returning id`, [o.id]);
    await q(`insert into memberships(org_id, user_id, role) values ($1, $2, 'owner')`, [o.id, u.id]);
    const [cust] = await q(`insert into customers(org_id, display_name) values ($1, 'Guest') returning id`, [o.id]);
    // One order per branch, placed 10 days ago, so both read models have rows.
    for (const [i, b] of [main.id, north.id].entries()) {
      await q(`insert into orders(org_id, branch_id, number, channel, fulfillment, status, currency, subtotal_minor, total_minor, customer_id, placed_at)
               values ($1, $2, $3, 'web', 'pickup', 'picked_up', 'EGP', 5000, 5000, $4, now() - interval '10 days')`, [o.id, b, `${k}${i}`, cust.id]);
    }
    await q(`select app.rebuild_analytics_rollups($1)`, [o.id]);
    ids[k] = { user: u.id, org: o.id, main: main.id, north: north.id, customer: cust.id };
  }
  const [kitchen] = await q(`insert into auth.users(email) values ('rm-kitchen@example.test') returning id`);
  await q(`insert into memberships(org_id, user_id, role, branch_ids) values ($1, $2, 'cashier', array[$3::uuid])`, [ids.A.org, kitchen.id, ids.A.main]);
  ids.branchStaff = kitchen.id;
});

after(async () => {
  await pool?.end();
  const c = new pg.Client({ connectionString: admin.toString() });
  await c.connect();
  try { await c.query(`drop database if exists ${name} with (force)`); } finally { await c.end(); }
});

const READ_MODELS = ['customer_stats', 'customer_branch_stats', 'analytics_days', 'analytics_order_rollups', 'analytics_payment_rollups', 'analytics_product_rollups'];

test('members read only their own tenant from every read model, even with a forged org id', async () => {
  for (const table of READ_MODELS) {
    const own = await as('resuto_member', { user: ids.A.user, org: ids.A.org }, (c) => c.query(`select org_id from ${table}`));
    // (orders in this fixture have no lines or payments, so those two rollups are empty)
    assert.ok(own.rowCount > 0 || ['analytics_payment_rollups', 'analytics_product_rollups'].includes(table), `${table} has rows for A`);
    assert.ok(own.rows.every((r) => r.org_id === ids.A.org), `${table} leaks another tenant`);
    const forged = await as('resuto_member', { user: ids.A.user, org: ids.B.org }, (c) => c.query(`select 1 from ${table}`));
    assert.equal(forged.rowCount, 0, `${table} readable with a forged org id`);
  }
});

test('branch-scoped staff see only their branch in the branch-level read models', async () => {
  for (const table of ['customer_branch_stats', 'analytics_days', 'analytics_order_rollups']) {
    const rows = await as('resuto_member', { user: ids.branchStaff, org: ids.A.org }, (c) => c.query(`select branch_id from ${table}`));
    assert.ok(rows.rowCount > 0, `${table} visible to branch staff`);
    assert.ok(rows.rows.every((r) => r.branch_id === ids.A.main), `${table} shows another branch`);
  }
});

test('API roles and clients cannot write the read models', async () => {
  for (const table of READ_MODELS) {
    for (const role of ['resuto_member', 'resuto_tenant']) {
      await assert.rejects(as(role, { user: ids.A.user, org: ids.A.org }, (c) => c.query(`delete from ${table}`)), /permission denied/,
        `${role} must not delete from ${table}`);
    }
  }
  await assert.rejects(as('resuto_member', { user: ids.A.user, org: ids.A.org }, (c) => c.query(`select app.rebuild_customer_stats(null)`)), /permission denied/);
  await assert.rejects(as('resuto_member', { user: ids.A.user, org: ids.A.org }, (c) => c.query(`select app.rebuild_analytics_rollups(null)`)), /permission denied/);
});

test('an order change by a branch-scoped member keeps tenant-wide totals and marks old days stale', async () => {
  await as('resuto_member', { user: ids.branchStaff, org: ids.A.org }, async (c) => {
    await c.query(`update orders set refunded_minor = 1000 where org_id = $1 and branch_id = $2`, [ids.A.org, ids.A.main]);
    // The organization-wide row is recomputed across both branches even though this member cannot see the north branch.
    const stats = await c.query(`select spend_minor::int as spend, order_count from customer_stats where customer_id = $1`, [ids.A.customer]);
    assert.deepEqual(stats.rows[0], { spend: 9000, order_count: 2 });
    const stale = await c.query(
      `select d.local_date, d.stale from analytics_days d where d.branch_id = $1 order by d.local_date`, [ids.A.main]);
    const orderDay = await c.query(`select (placed_at at time zone 'Africa/Cairo')::date as d from orders where branch_id = $1`, [ids.A.main]);
    const day = orderDay.rows[0].d.getTime();
    assert.ok(stale.rows.find((r) => r.local_date.getTime() === day)?.stale, 'the changed day is stale');
    assert.ok(stale.rows.filter((r) => r.local_date.getTime() !== day).every((r) => !r.stale), 'other days stay fresh');
  });
});
