// 21-CRM migration 20261027210001: customers.first_touch and the funnel-beacon columns of attribution_events.
// - first_touch is set once at commit of the first identified interaction (deferred triggers), from the evidence then
//   known, and never overwritten by any role; app.backfill_first_touch is idempotent; the functions are not callable
//   by client or application roles.
// - attribution_events: tenant isolation (also with a forged org), branch scoping for branch-scoped staff (rows of
//   another branch hidden, rows without a branch visible), a branch of another restaurant can never be attached,
//   the kind / surface / weight checks hold.
// Own disposable database (<TEST_DATABASE_URL>_crm).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { migrate } from '../../scripts/db/migrate.mjs';
import { ensureDatabase } from '../../scripts/db/ensure-db.mjs';

const base = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:54329/resuto_test';
const url = base.replace(/\/([^/?]+)(\?.*)?$/, (_m, db, q = '') => `/${db}_crm${q}`);
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
const q = (sql, params) => pool.query(sql, params).then((r) => r.rows);
const touch = async (id) => (await q(`select first_touch from customers where id = $1`, [id]))[0].first_touch;
let n = 0;
const order = (k, customer, extra = {}) => q(`insert into orders(org_id, branch_id, number, channel, fulfillment, currency, subtotal_minor, total_minor, customer_id, attribution, placed_at)
  values ($1, $2, $3, $4, 'pickup', 'EGP', 100, 100, $5, $6, coalesce($7, now())) returning id`,
[ids[k].org, extra.branch ?? ids[k].main, String(++n), extra.channel ?? 'web', customer, extra.attribution ?? {}, extra.at ?? null]).then((r) => r[0].id);

before(async () => {
  await ensureDatabase(url);
  await migrate({ url, reset: true, log: () => {} });
  for (const k of ['A', 'B']) {
    const [u] = await q(`insert into auth.users(email) values ($1) returning id`, [`crm-owner${k}@example.test`]);
    const [o] = await q(`insert into organizations(slug, name) values ($1, $2) returning id`, [`crm-${k.toLowerCase()}`, `CRM ${k}`]);
    await q(`insert into memberships(org_id, user_id, role) values ($1, $2, 'owner')`, [o.id, u.id]);
    const [main] = await q(`insert into branches(org_id, code, name) values ($1, 'main', 'Main') returning id`, [o.id]);
    const [north] = await q(`insert into branches(org_id, code, name) values ($1, 'north', 'North') returning id`, [o.id]);
    for (const [kind, branch] of [['page_view', null], ['qr_scan', main.id], ['qr_scan', north.id]]) {
      await q(`insert into attribution_events(org_id, kind, branch_id, session_key, surface, weight) values ($1, $2, $3, 'h', 't', 1)`, [o.id, kind, branch]);
    }
    ids[k] = { user: u.id, org: o.id, main: main.id, north: north.id };
  }
  const [m] = await q(`insert into auth.users(email) values ('crm-managerA@example.test') returning id`);
  await q(`insert into memberships(org_id, user_id, role, branch_ids) values ($1, $2, 'manager', array[$3::uuid])`, [ids.A.org, m.id, ids.A.main]);
  ids.managerA = m.id;
});

after(async () => pool.end());

test('attribution_events: tenant isolation, branch scoping and no cross-restaurant branch', async () => {
  const count = (role, opts) => as(role, opts, (c) => c.query(`select kind, branch_id from attribution_events order by id`)).then((r) => r.rows);
  assert.equal((await count('resuto_member', { user: ids.A.user, org: ids.A.org })).length, 3);
  assert.equal((await count('resuto_member', { user: ids.A.user, org: ids.B.org })).length, 0, 'forged org');
  assert.equal((await count('resuto_tenant', { org: ids.B.org })).length, 3);
  // The main-branch manager sees main and branchless rows, not north.
  const mgr = await count('resuto_member', { user: ids.managerA, org: ids.A.org });
  assert.deepEqual(mgr.map((r) => r.branch_id).sort(), [ids.A.main, null].sort());
  await assert.rejects(as('resuto_member', { user: ids.managerA, org: ids.A.org }, (c) => c.query(
    `insert into attribution_events(org_id, kind, branch_id, session_key) values ($1, 'qr_scan', $2, 'x')`, [ids.A.org, ids.A.north])), /row-level security|does not belong/);
  // Another restaurant's branch is refused for every writer, the owner connection included.
  await assert.rejects(q(`insert into attribution_events(org_id, kind, branch_id, session_key) values ($1, 'qr_scan', $2, 'x')`, [ids.A.org, ids.B.main]), /does not belong/);
  await assert.rejects(as('resuto_tenant', { org: ids.A.org }, (c) => c.query(
    `insert into attribution_events(org_id, kind, branch_id, session_key) values ($1, 'qr_scan', $2, 'x')`, [ids.B.org, ids.B.main])), /row-level security|does not belong/);
  // Checks.
  await assert.rejects(q(`insert into attribution_events(org_id, kind) values ($1, 'scan')`, [ids.A.org]), /attribution_events_kind_check/);
  await assert.rejects(q(`insert into attribution_events(org_id, kind, surface) values ($1, 'page_view', 'admin')`, [ids.A.org]), /check/);
  await assert.rejects(q(`insert into attribution_events(org_id, kind, weight) values ($1, 'page_view', 0)`, [ids.A.org]), /check/);
  // Client roles have no access.
  for (const role of ['anon', 'authenticated']) {
    const [p] = await q(`select has_table_privilege($1, 'public.attribution_events', 'select') as s, has_table_privilege($1, 'public.attribution_events', 'insert') as i`, [role]);
    assert.deepEqual(p, { s: false, i: false }, role);
  }
});

test('first_touch is set at commit from the evidence of the first interaction', async () => {
  const [c] = await q(`insert into customers(org_id, display_name) values ($1, 'Link') returning id`, [ids.A.org]);
  await q(`insert into attribution_events(org_id, kind, session_key, utm, occurred_at) values ($1, 'link_click', 'sess-1', '{"source":"instagram","medium":"bio"}', now() - interval '1 day')`, [ids.A.org]);
  // Inside one transaction nothing is set until commit; then the click of the order's session (camelCase key from the website) wins.
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`insert into orders(org_id, branch_id, number, channel, fulfillment, currency, subtotal_minor, total_minor, customer_id, attribution)
      values ($1, $2, 'tx-1', 'web', 'pickup', 'EGP', 100, 100, $3, '{"sessionKey":"sess-1","utm_source":"newsletter"}')`, [ids.A.org, ids.A.main, c.id]);
    assert.equal((await client.query(`select first_touch from customers where id = $1`, [c.id])).rows[0].first_touch, null);
    await client.query('commit');
  } catch (e) { await client.query('rollback'); throw e; } finally { client.release(); }
  const ft = await touch(c.id);
  assert.equal(ft.basis, 'tracked_link_click');
  assert.equal(ft.inferred, false);
  assert.deepEqual(ft.utm, { source: 'instagram', medium: 'bio', campaign: null, content: null, term: null });
  assert.equal(ft.branchId, ids.A.main);
  assert.equal(ft.setBy, 'live');

  // An order without attribution: inferred first order channel. A recorded event up to a minute later still wins.
  const [d] = await q(`insert into customers(org_id, display_name) values ($1, 'Walk-in') returning id`, [ids.A.org]);
  const c2 = await pool.connect();
  try {
    await c2.query('begin');
    const [{ id: oid }] = (await c2.query(`insert into orders(org_id, branch_id, number, channel, fulfillment, currency, subtotal_minor, total_minor, customer_id)
      values ($1, $2, 'tx-2', 'qr', 'pickup', 'EGP', 100, 100, $3) returning id`, [ids.A.org, ids.A.north, d.id])).rows;
    await c2.query(`insert into attribution_events(org_id, kind, customer_id, order_id, utm, occurred_at) values ($1, 'order_placed', $2, $3, '{"utm_source":"tiktok"}', now() + interval '30 seconds')`,
      [ids.A.org, d.id, oid]);
    await c2.query('commit');
  } catch (e) { await c2.query('rollback'); throw e; } finally { c2.release(); }
  assert.equal((await touch(d.id)).basis, 'attribution_event');

  const [w] = await q(`insert into customers(org_id, display_name) values ($1, 'Plain') returning id`, [ids.A.org]);
  await order('A', w.id, { channel: 'qr', branch: ids.A.north });
  assert.equal((await touch(w.id)).basis, 'first_order_channel');
  assert.equal((await touch(w.id)).channel, 'qr');
  assert.equal((await touch(w.id)).branchId, ids.A.north);
  // A conversation-first customer.
  const [ch] = await q(`insert into messaging_channels(org_id, branch_id, kind, transport, display_name) values ($1, null, 'instagram', 'sandbox', 'IG') returning id`, [ids.A.org]);
  const [x] = await q(`insert into customers(org_id, display_name) values ($1, 'DM') returning id`, [ids.A.org]);
  await q(`insert into conversations(org_id, channel_id, external_contact, status, customer_id) values ($1, $2, 'igsid-1', 'open', $3)`, [ids.A.org, ch.id, x.id]);
  assert.equal((await touch(x.id)).basis, 'first_conversation_channel');
  assert.equal((await touch(x.id)).channel, 'instagram');
});

test('first_touch is never overwritten, by any role', async () => {
  const [c] = await q(`select id, first_touch from customers where display_name = 'Plain' and org_id = $1`, [ids.A.org]);
  // A later attributed order changes nothing.
  await order('A', c.id, { attribution: { utm_source: 'google' } });
  assert.deepEqual(await touch(c.id), c.first_touch);
  for (const [role, opts] of [['resuto_member', { user: ids.A.user, org: ids.A.org }], ['resuto_tenant', { org: ids.A.org }]]) {
    await as(role, opts, async (cl) => {
      await cl.query(`update customers set first_touch = '{"basis":"attribution_event","occurredAt":"2020-01-01"}' where id = $1`, [c.id]);
      assert.deepEqual((await cl.query(`select first_touch from customers where id = $1`, [c.id])).rows[0].first_touch, c.first_touch, role);
      await cl.query(`update customers set first_touch = null where id = $1`, [c.id]);
      assert.deepEqual((await cl.query(`select first_touch from customers where id = $1`, [c.id])).rows[0].first_touch, c.first_touch, role);
    });
  }
  await q(`update customers set first_touch = null where id = $1`, [c.id]);
  assert.deepEqual(await touch(c.id), c.first_touch);
  // Another restaurant cannot read it at all.
  const other = await as('resuto_member', { user: ids.B.user, org: ids.B.org }, (cl) => cl.query(`select first_touch from customers where id = $1`, [c.id]));
  assert.equal(other.rowCount, 0);
  const forged = await as('resuto_member', { user: ids.B.user, org: ids.A.org }, (cl) => cl.query(`select first_touch from customers where id = $1`, [c.id]));
  assert.equal(forged.rowCount, 0);
  // The shape is checked.
  const [y] = await q(`insert into customers(org_id) values ($1) returning id`, [ids.A.org]);
  await assert.rejects(q(`update customers set first_touch = '"x"' where id = $1`, [y.id]), /check/);
});

test('the backfill fills customers loaded without triggers, once, and the functions are not callable by app roles', async () => {
  const [c] = await q(`insert into customers(org_id, display_name) values ($1, 'Imported') returning id`, [ids.B.org]);
  const client = await pool.connect();
  try {
    await client.query(`set session_replication_role = replica`);
    await client.query(`insert into orders(org_id, branch_id, number, channel, fulfillment, currency, subtotal_minor, total_minor, customer_id, campaign_id, placed_at)
      values ($1, $2, 'imp', 'staff', 'pickup', 'EGP', 100, 100, $3, null, '2026-01-01T10:00:00Z')`, [ids.B.org, ids.B.main, c.id]);
  } finally {
    await client.query(`set session_replication_role = origin`);
    client.release();
  }
  assert.equal(await touch(c.id), null);
  const [{ n: first }] = await q(`select app.backfill_first_touch($1) as n`, [ids.B.org]);
  assert.equal(first, 1);
  const ft = await touch(c.id);
  assert.equal(ft.basis, 'first_order_channel');
  assert.equal(ft.setBy, 'backfill');
  assert.equal(ft.occurredAt, '2026-01-01T10:00:00.000Z');
  const [{ n: second }] = await q(`select app.backfill_first_touch($1) as n`, [ids.B.org]);
  assert.equal(second, 0);
  assert.deepEqual(await touch(c.id), ft);
  // Organization A is untouched by B's backfill (it only reads B).
  for (const role of ['anon', 'authenticated', 'resuto_member', 'resuto_tenant']) {
    for (const fn of ['app.backfill_first_touch(uuid)', 'app.ensure_first_touch(uuid, text)', 'app.derive_first_touch(uuid, text)']) {
      const [{ ok }] = await q(`select has_function_privilege($1, $2, 'execute') as ok`, [role, fn]);
      assert.equal(ok, false, `${role} ${fn}`);
    }
  }
  await assert.rejects(as('resuto_tenant', { org: ids.B.org }, (cl) => cl.query(`select app.backfill_first_touch($1)`, [ids.B.org])), /permission denied/);
});
