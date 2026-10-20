// Database-level security gate: tenant isolation, branch scoping, write
// lockdown for direct Supabase clients, immutability and core constraints.
// Runs against a freshly migrated local database (resuto_test).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { migrate } from '../../scripts/db/migrate.mjs';
import { ensureDatabase } from '../../scripts/db/ensure-db.mjs';

const url = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:54329/resuto_test';
const pool = new pg.Pool({ connectionString: url, max: 4 });
const ids = {};

// Runs fn inside a transaction as the given execution role, then rolls back.
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
    const [u] = await q(`insert into auth.users(email) values ($1) returning id`, [`owner${k}@example.test`]);
    const [o] = await q(`insert into organizations(slug, name) values ($1, $2) returning id`, [`rest-${k.toLowerCase()}`, `Restaurant ${k}`]);
    const [b1] = await q(`insert into branches(org_id, code, name) values ($1, 'main', 'Main') returning id`, [o.id]);
    const [b2] = await q(`insert into branches(org_id, code, name) values ($1, 'north', 'North') returning id`, [o.id]);
    await q(`insert into memberships(org_id, user_id, role) values ($1, $2, 'owner')`, [o.id, u.id]);
    const [t] = await q(`insert into dining_tables(org_id, branch_id, label, capacity, qr_token) values ($1, $2, 'T1', 4, $3) returning id`, [o.id, b1.id, `qr-token-${k}-0123456789`]);
    await q(`insert into orders(org_id, branch_id, number, channel, fulfillment, table_id, currency, subtotal_minor, total_minor)
             values ($1, $2, '1', 'qr', 'dine_in', $3, 'EGP', 10000, 10000)`, [o.id, b1.id, t.id]);
    await q(`insert into orders(org_id, branch_id, number, channel, fulfillment, currency, subtotal_minor, total_minor)
             values ($1, $2, '2', 'web', 'pickup', 'EGP', 5000, 5000)`, [o.id, b2.id]);
    ids[k] = { user: u.id, org: o.id, main: b1.id, north: b2.id, table: t.id };
  }
  // kitchen staff of A restricted to the main branch
  const [k] = await q(`insert into auth.users(email) values ('kitchenA@example.test') returning id`);
  await q(`insert into memberships(org_id, user_id, role, branch_ids) values ($1, $2, 'kitchen', array[$3::uuid])`, [ids.A.org, k.id, ids.A.main]);
  ids.kitchenA = k.id;
});

after(async () => pool.end());

test('member sees only their own tenant', async () => {
  const rows = await as('resuto_member', { user: ids.A.user, org: ids.A.org }, (c) => c.query('select org_id from orders'));
  assert.equal(rows.rowCount, 2);
  assert.ok(rows.rows.every((r) => r.org_id === ids.A.org));
});

test('member cannot read another tenant even when app.org_id is forged', async () => {
  const rows = await as('resuto_member', { user: ids.A.user, org: ids.B.org }, (c) => c.query('select * from orders'));
  assert.equal(rows.rowCount, 0);
  const orgs = await as('resuto_member', { user: ids.A.user, org: ids.B.org }, (c) => c.query('select * from organizations'));
  assert.equal(orgs.rowCount, 0);
});

test('member cannot insert rows into another tenant', async () => {
  await assert.rejects(
    as('resuto_member', { user: ids.A.user, org: ids.A.org }, (c) =>
      c.query(`insert into customers(org_id, display_name) values ($1, 'x')`, [ids.B.org])),
    /row-level security/);
});

test('branch-scoped staff see only their branch', async () => {
  const rows = await as('resuto_member', { user: ids.kitchenA, org: ids.A.org }, (c) => c.query('select branch_id from orders'));
  assert.equal(rows.rowCount, 1);
  assert.equal(rows.rows[0].branch_id, ids.A.main);
});

test('tenant system role is confined to app.org_id', async () => {
  const rows = await as('resuto_tenant', { org: ids.B.org }, (c) => c.query('select org_id from orders'));
  assert.equal(rows.rowCount, 2);
  assert.ok(rows.rows.every((r) => r.org_id === ids.B.org));
  const none = await as('resuto_tenant', {}, (c) => c.query('select * from orders'));
  assert.equal(none.rowCount, 0, 'no tenant context means no rows');
});

// Audit PS-01/PCL-02: direct Supabase clients (Data API, Realtime) used to read every branch's orders, messages,
// reservations and QR tokens with any staff JWT. All tenant data is API-only now.
test('direct Supabase clients (authenticated) can neither read nor write tenant data', async () => {
  for (const table of ['orders', 'order_lines', 'messages', 'conversations', 'reservations', 'dining_tables', 'delivery_jobs',
    'service_requests', 'branches', 'organizations', 'memberships', 'profiles', 'payments', 'plans']) {
    await assert.rejects(as('authenticated', { user: ids.A.user }, (c) => c.query(`select * from ${table} limit 1`)),
      /permission denied/, `authenticated must not read ${table}`);
  }
  // the branch-scoped kitchen account (a driver/kitchen JWT in the audit) gets nothing either
  await assert.rejects(as('authenticated', { user: ids.kitchenA }, (c) => c.query('select count(*) from orders')), /permission denied/);
  await assert.rejects(
    as('authenticated', { user: ids.A.user }, (c) => c.query(`update orders set total_minor = 0, subtotal_minor = 0`)),
    /permission denied/);
  await assert.rejects(
    as('authenticated', { user: ids.A.user }, (c) => c.query(`update memberships set role = 'owner'`)),
    /permission denied/);
});

test('client roles hold no privilege on any public relation and no policy admits them', async () => {
  const grants = (await pool.query(`select c.relname, r.rolname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      cross join (values ('anon'), ('authenticated')) as r(rolname)
     where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'p', 'f')
       and (has_table_privilege(r.rolname, c.oid, 'select') or has_table_privilege(r.rolname, c.oid, 'insert')
         or has_table_privilege(r.rolname, c.oid, 'update') or has_table_privilege(r.rolname, c.oid, 'delete'))`)).rows;
  assert.deepEqual(grants, []);
  const policies = (await pool.query(`select tablename, policyname from pg_policies
     where schemaname = 'public' and roles && array['anon', 'authenticated', 'public']::name[]`)).rows;
  assert.deepEqual(policies, []);
  const usage = (await pool.query(`select r from unnest(array['anon', 'authenticated']) r where has_schema_privilege(r, 'app', 'usage')`)).rows;
  assert.deepEqual(usage, [], 'client roles cannot use the app schema');
});

test('enable_realtime_read can no longer open a table to clients; lockdown strips client reads from new tables', async () => {
  await assert.rejects(pool.query(`select app.enable_realtime_read('public.orders')`), /direct client reads are disabled/);
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query('create table public.ws_lockdown_probe (id int)');
    await c.query('grant select on public.ws_lockdown_probe to authenticated, anon');
    await c.query('select app.lockdown_public_grants()');
    const { rows } = await c.query(`select has_table_privilege('authenticated', 'public.ws_lockdown_probe', 'select') as a,
      has_table_privilege('anon', 'public.ws_lockdown_probe', 'select') as b`);
    assert.deepEqual(rows[0], { a: false, b: false });
  } finally {
    await c.query('rollback');
    c.release();
  }
});

test('anon has no access', async () => {
  await assert.rejects(as('anon', {}, (c) => c.query('select * from orders')), /permission denied/);
});

test('member sessions cannot read encrypted integration credentials or MCP key hashes', async () => {
  await assert.rejects(
    as('resuto_member', { user: ids.A.user, org: ids.A.org }, (c) => c.query('select credentials_encrypted from integration_connections')),
    /permission denied/);
  await assert.rejects(
    as('resuto_member', { user: ids.A.user, org: ids.A.org }, (c) => c.query('select key_hash from mcp_clients')),
    /permission denied/);
});

test('audit log is append-only for application roles', async () => {
  await as('resuto_member', { user: ids.A.user, org: ids.A.org }, async (c) => {
    await c.query(`insert into audit_logs(org_id, actor_type, actor_id, action) values ($1, 'user', $2, 'test')`, [ids.A.org, ids.A.user]);
    await assert.rejects(c.query(`update audit_logs set action = 'tampered'`), /append-only/);
  });
});

test('reservations cannot overlap on the same table (including buffer)', async () => {
  const insert = (start, end, until) => pool.query(
    `insert into reservations(org_id, branch_id, table_id, guest_name, party_size, starts_at, ends_at, blocked_until, status)
     values ($1, $2, $3, 'Guest', 2, $4, $5, $6, 'confirmed')`, [ids.A.org, ids.A.main, ids.A.table, start, end, until]);
  await insert('2030-01-01T18:00Z', '2030-01-01T19:30Z', '2030-01-01T19:45Z');
  await assert.rejects(insert('2030-01-01T19:40Z', '2030-01-01T21:00Z', '2030-01-01T21:15Z'), /reservations_no_overlap/);
  await insert('2030-01-01T19:45Z', '2030-01-01T21:00Z', '2030-01-01T21:15Z');
});

test('order totals and line totals are arithmetically enforced', async () => {
  await assert.rejects(pool.query(
    `insert into orders(org_id, branch_id, number, channel, fulfillment, currency, subtotal_minor, total_minor)
     values ($1, $2, '99', 'web', 'pickup', 'EGP', 1000, 999)`, [ids.A.org, ids.A.main]), /check constraint/);
  await assert.rejects(pool.query(
    `insert into orders(org_id, branch_id, number, channel, fulfillment, currency, subtotal_minor, total_minor)
     values ($1, $2, '98', 'qr', 'dine_in', 'EGP', 1000, 1000)`, [ids.A.org, ids.A.main]), /check constraint/,
    'dine-in requires a table');
});

test('one open visit per table', async () => {
  const open = () => pool.query(`insert into visits(org_id, branch_id, table_id, guest_token_hash) values ($1, $2, $3, md5(random()::text))`,
    [ids.A.org, ids.A.main, ids.A.table]);
  await open();
  await assert.rejects(open(), /visits_one_open_per_table/);
});

test('issued fiscal documents are immutable', async () => {
  const [d] = (await pool.query(
    `insert into fiscal_documents(org_id, branch_id, kind, series, number, counter_value, document_hash, currency, subtotal_minor, tax_minor, total_minor, lines)
     values ($1, $2, 'simplified_invoice', 'INV', 'INV-1', 1, 'h1', 'EGP', 100, 14, 114, '[]') returning id`, [ids.A.org, ids.A.main])).rows;
  await assert.rejects(pool.query(`update fiscal_documents set total_minor = 1 where id = $1`, [d.id]), /immutable/);
  await assert.rejects(pool.query(`delete from fiscal_documents where id = $1`, [d.id]), /cannot be deleted/);
  await pool.query(`update fiscal_documents set status = 'reported' where id = $1`, [d.id]);
});

test('module entitlements follow plan, status, add-ons and overrides', async () => {
  const org = ids.A.org;
  const enabled = async (m) => (await pool.query(`select app.module_enabled($1, $2) as e`, [org, m])).rows[0].e;
  assert.equal(await enabled('core'), false, 'no subscription → nothing');
  const [s] = (await pool.query(`insert into subscriptions(org_id, plan_id, status, country, currency, current_period_end)
     values ($1, 'starter', 'active', 'EG', 'EGP', now() + interval '30 days') returning id`, [org])).rows;
  assert.equal(await enabled('pay'), true);
  assert.equal(await enabled('marketing'), false);
  await pool.query(`insert into subscription_modules(subscription_id, org_id, module) values ($1, $2, 'marketing')`, [s.id, org]);
  assert.equal(await enabled('marketing'), true, 'add-on');
  await pool.query(`update subscriptions set status = 'past_due', grace_until = now() - interval '1 day' where id = $1`, [s.id]);
  assert.equal(await enabled('pay'), false, 'past due beyond grace');
  await pool.query(`insert into entitlement_overrides(org_id, module, enabled, reason) values ($1, 'pay', true, 'support credit')`, [org]);
  assert.equal(await enabled('pay'), true, 'override');
});

// Audit PS-07: app functions were executable by PUBLIC. New app functions must `revoke execute ... from public`.
test('no app function is executable by PUBLIC or client roles; DDL helpers are owner-only', async () => {
  const open = (await pool.query(`select p.proname, r.rolname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      cross join (values ('anon'), ('authenticated')) as r(rolname)
     where n.nspname = 'app' and (has_function_privilege(r.rolname, p.oid, 'execute')
       or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'))`)).rows;
  assert.deepEqual(open, []);
  for (const fn of ['app.enable_tenant_rls(regclass, text)', 'app.enable_realtime_read(regclass)', 'app.lockdown_public_grants()']) {
    for (const role of ['resuto_member', 'resuto_tenant']) {
      assert.equal((await pool.query(`select has_function_privilege($1, $2, 'execute') as x`, [role, fn])).rows[0].x, false, `${role} on ${fn}`);
    }
  }
  for (const fn of ['app.is_member(uuid)', 'app.branch_scope()', 'app.member_org_ids()', 'app.current_org_id()', 'app.module_enabled(uuid, module_key, timestamptz)']) {
    assert.equal((await pool.query(`select has_function_privilege('resuto_member', $1, 'execute') as x`, [fn])).rows[0].x, true, fn);
  }
});

test('every function in the app schema runs with a fixed search_path', async () => {
  const rows = (await pool.query(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app' and p.prokind = 'f'
      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')`)).rows;
  assert.deepEqual(rows.map((r) => r.proname), []);
});
