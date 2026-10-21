// Loyalty ledger (20261021020003) and notifications (20261021020002): tenant isolation, the append-only ledger (no
// UPDATE/DELETE for any API role, trigger refusal even for the owner), ledger shape checks, notifications written only
// by the worker, and the stock-alert trigger that resolves insight episodes (20261021020001).
// Runs against its own disposable database (<TEST_DATABASE_URL>_ws8) so it can run in parallel with rls.test.mjs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { migrate } from '../../scripts/db/migrate.mjs';
import { ensureDatabase } from '../../scripts/db/ensure-db.mjs';

const base = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:54329/resuto_test';
const url = base.replace(/\/([^/?]+)(\?.*)?$/, (_m, db, q = '') => `/${db}_ws8${q}`);
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
    const [u] = await q(`insert into auth.users(email) values ($1) returning id`, [`ws8-owner${k}@example.test`]);
    const [o] = await q(`insert into organizations(slug, name) values ($1, $2) returning id`, [`ws8-${k.toLowerCase()}`, `WS8 ${k}`]);
    const [b] = await q(`insert into branches(org_id, code, name) values ($1, 'main', 'Main') returning id`, [o.id]);
    await q(`insert into memberships(org_id, user_id, role) values ($1, $2, 'owner')`, [o.id, u.id]);
    const [c] = await q(`insert into customers(org_id, display_name) values ($1, 'Guest') returning id`, [o.id]);
    await q(`insert into loyalty_accounts(org_id, customer_id, balance) values ($1, $2, 10)`, [o.id, c.id]);
    await q(`insert into loyalty_ledger(org_id, customer_id, kind, points, balance_after, actor, idempotency_key) values ($1, $2, 'earn', 10, 10, 'test', 'seed')`, [o.id, c.id]);
    await q(`insert into notifications(org_id, audience_permission, kind, template_key, dedupe_key) values ($1, 'inventory:read', 'stock_low', 'stock_low', 'seed')`, [o.id]);
    ids[k] = { user: u.id, org: o.id, branch: b.id, customer: c.id };
  }
});

after(async () => pool.end());

test('staff read only their own restaurant\'s ledger and notifications, even with a forged org', async () => {
  const own = await as('resuto_member', { user: ids.A.user, org: ids.A.org }, (c) => c.query('select org_id from loyalty_ledger'));
  assert.equal(own.rowCount, 1);
  const forged = await as('resuto_member', { user: ids.A.user, org: ids.B.org }, (c) => c.query('select * from loyalty_ledger'));
  assert.equal(forged.rowCount, 0);
  const notes = await as('resuto_member', { user: ids.A.user, org: ids.B.org }, (c) => c.query('select * from notifications'));
  assert.equal(notes.rowCount, 0);
});

test('the ledger is append-only for every role, including the table owner', async () => {
  for (const role of ['resuto_member', 'resuto_tenant']) {
    await assert.rejects(as(role, { user: ids.A.user, org: ids.A.org }, (c) => c.query('update loyalty_ledger set points = 99')), /permission denied/);
    await assert.rejects(as(role, { user: ids.A.user, org: ids.A.org }, (c) => c.query('delete from loyalty_ledger')), /permission denied/);
  }
  await assert.rejects(q('update loyalty_ledger set points = 99 where org_id = $1', [ids.A.org]), /append-only/);
  await assert.rejects(q('delete from loyalty_ledger where org_id = $1', [ids.A.org]), /append-only/);
  // Inserting is how the API records movements; the shape checks still apply.
  await as('resuto_member', { user: ids.A.user, org: ids.A.org }, async (c) => {
    await c.query(`insert into loyalty_ledger(org_id, customer_id, kind, points, balance_after, actor, idempotency_key) values ($1, $2, 'redeem', -5, 5, 'test', 'r1')`, [ids.A.org, ids.A.customer]);
    await assert.rejects(c.query(`insert into loyalty_ledger(org_id, customer_id, kind, points, balance_after, actor, idempotency_key) values ($1, $2, 'redeem', 5, 15, 'test', 'r2')`, [ids.A.org, ids.A.customer]), /check/);
  });
  await assert.rejects(q(`insert into loyalty_ledger(org_id, customer_id, kind, points, balance_after, actor, idempotency_key) values ($1, $2, 'redeem', -50, -40, 'test', 'neg')`, [ids.A.org, ids.A.customer]), /check/);
  await assert.rejects(q(`insert into loyalty_ledger(org_id, customer_id, kind, points, balance_after, actor, idempotency_key) values ($1, $2, 'adjust', 1, 11, 'test', 'noreason')`, [ids.A.org, ids.A.customer]), /check/);
  await assert.rejects(q(`insert into loyalty_ledger(org_id, customer_id, kind, points, balance_after, actor, idempotency_key) values ($1, $2, 'earn', 1, 11, 'test', 'seed')`, [ids.A.org, ids.A.customer]), /duplicate key/);
});

test('erasing a customer still works (foreign-key cascades pass the append-only trigger)', async () => {
  const [c] = await q(`insert into customers(org_id, display_name) values ($1, 'Erase me') returning id`, [ids.B.org]);
  await q(`insert into loyalty_ledger(org_id, customer_id, kind, points, balance_after, actor, idempotency_key) values ($1, $2, 'earn', 3, 3, 'test', 'erase')`, [ids.B.org, c.id]);
  await q('delete from customers where id = $1', [c.id]);
  assert.equal((await q('select 1 from loyalty_ledger where customer_id = $1', [c.id])).length, 0);
});

test('notifications are written by the worker only; members record their own reads', async () => {
  await assert.rejects(as('resuto_member', { user: ids.A.user, org: ids.A.org }, (c) =>
    c.query(`insert into notifications(org_id, audience_permission, kind, template_key, dedupe_key) values ($1, 'inventory:read', 'stock_low', 'x', 'forged')`, [ids.A.org])), /permission denied/);
  await assert.rejects(as('resuto_member', { user: ids.A.user, org: ids.A.org }, (c) => c.query(`update notifications set severity = 'critical'`)), /permission denied/);
  const [n] = await q('select id from notifications where org_id = $1', [ids.A.org]);
  await as('resuto_member', { user: ids.A.user, org: ids.A.org }, (c) =>
    c.query('insert into notification_reads(notification_id, org_id, user_id) values ($1, $2, $3)', [n.id, ids.A.org, ids.A.user]));
  await assert.rejects(q(`insert into notifications(org_id, audience_permission, kind, template_key, dedupe_key, link) values ($1, 'x', 'stock_low', 'x', 'badlink', 'https://evil.example')`, [ids.A.org]), /check/);
});

test('resolving a stock alert closes the matching insight episode in the same transaction', async () => {
  const [item] = await q(`insert into inventory_items(org_id, name, unit, reorder_level) values ($1, 'Rice', 'kg', 5) returning id`, [ids.A.org]);
  const [alert] = await q(`insert into stock_alerts(org_id, branch_id, item_id, quantity_at_open, reorder_level) values ($1, $2, $3, 1, 5) returning id`, [ids.A.org, ids.A.branch, item.id]);
  const episode = `low_stock:${ids.A.branch}:${item.id}`;
  await q(`insert into ai_insights(org_id, branch_id, kind, title, body, method, episode_key, evidence) values ($1, $2, 'inventory', 't', 'b', 'deterministic', $3, '{"rule":"inventory_below_reorder_level"}')`, [ids.A.org, ids.A.branch, episode]);
  await assert.rejects(q(`insert into ai_insights(org_id, branch_id, kind, title, body, method, episode_key) values ($1, $2, 'inventory', 't', 'b', 'deterministic', $3)`, [ids.A.org, ids.A.branch, episode]), /duplicate key/);
  await q(`update stock_alerts set status = 'resolved', resolved_at = now() where id = $1`, [alert.id]);
  const [row] = await q('select status, episode_ended_at from ai_insights where episode_key = $1', [episode]);
  assert.equal(row.status, 'resolved');
  assert.ok(row.episode_ended_at);
  // A new episode may open after the old one ended.
  await q(`insert into ai_insights(org_id, branch_id, kind, title, body, method, episode_key) values ($1, $2, 'inventory', 't', 'b', 'deterministic', $3)`, [ids.A.org, ids.A.branch, episode]);
});
