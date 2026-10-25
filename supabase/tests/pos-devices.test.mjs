// 21-POSAPI (20261024210001): POS pairing codes, device credentials, the per-branch event feed, order submissions and
// print jobs. Tenant isolation and branch scope under RLS, credential hashes unreadable by sessions, a feed no session
// can write, and the feed triggers (gap-free per-branch sequence, merged updates, no feed without a pairing). Runs
// against its own freshly migrated disposable database (<TEST_DATABASE_URL>_pos), so it can run beside rls.test.mjs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { migrate } from '../../scripts/db/migrate.mjs';
import { ensureDatabase } from '../../scripts/db/ensure-db.mjs';

const base = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:54329/resuto_test';
const url = base.replace(/\/([^/?]+)(\?.*)?$/, (_m, db, q = '') => `/${db}_pos${q}`);
const pool = new pg.Pool({ connectionString: url, max: 4 });
const sha = (s) => createHash('sha256').update(s).digest('hex');
const q = (sql, params) => pool.query(sql, params).then((r) => r.rows);
const ids = {};
const POS_TABLES = ['pos_device_pairings', 'pos_devices', 'pos_event_heads', 'pos_events', 'pos_order_submissions', 'pos_print_jobs'];

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

/** Places a minimal order with one line and its 'created' timeline event (what the kernel writes). */
async function order(k, branch, station = 'Grill') {
  const [o] = await q(`insert into orders(org_id, branch_id, number, channel, fulfillment, currency, subtotal_minor, total_minor)
    values ($1, $2, (floor(random() * 1e6))::int::text, 'pos', 'pickup', 'EGP', 1000, 1000) returning id`, [ids[k].org, branch]);
  await q(`insert into order_lines(org_id, order_id, name, unit_price_minor, quantity, line_total_minor, station) values ($1, $2, 'Tea', 1000, 1, 1000, $3)`,
    [ids[k].org, o.id, station]);
  await q(`insert into order_events(org_id, order_id, event_type, to_status, actor_type) values ($1, $2, 'created', 'placed', 'device')`, [ids[k].org, o.id]);
  return o.id;
}

before(async () => {
  await ensureDatabase(url);
  await migrate({ url, reset: true, log: () => {} });
  for (const k of ['A', 'B']) {
    const [u] = await q(`insert into auth.users(email) values ($1) returning id`, [`pos-owner${k}@example.test`]);
    const [o] = await q(`insert into organizations(slug, name) values ($1, $2) returning id`, [`pos-${k.toLowerCase()}`, `POS ${k}`]);
    const [main] = await q(`insert into branches(org_id, code, name) values ($1, 'main', 'Main') returning id`, [o.id]);
    const [north] = await q(`insert into branches(org_id, code, name) values ($1, 'north', 'North') returning id`, [o.id]);
    await q(`insert into memberships(org_id, user_id, role) values ($1, $2, 'owner')`, [o.id, u.id]);
    const [p] = await q(`insert into pos_device_pairings(org_id, branch_id, name, acting_role, code_hash, device_ttl_days, created_by, expires_at)
      values ($1, $2, 'iPad', 'waiter', $3, 365, $4, now() + interval '10 minutes') returning id`, [o.id, main.id, sha(`code-${k}`), u.id]);
    const [d] = await q(`insert into pos_devices(org_id, branch_id, name, acting_role, token_prefix, token_hash, pairing_id)
      values ($1, $2, 'iPad', 'waiter', $3, $4, $5) returning id`, [o.id, main.id, `rpos_${k}prefix`, sha(`token-${k}`), p.id]);
    ids[k] = { user: u.id, org: o.id, main: main.id, north: north.id, device: d.id };
    ids[k].order = await order(k, main.id);
    await q(`insert into pos_order_submissions(org_id, client_order_id, branch_id, device_id, order_id, request_hash) values ($1, gen_random_uuid(), $2, $3, $4, 'h')`,
      [o.id, main.id, d.id, ids[k].order]);
  }
  // A member of A limited to the north branch (which has no feed).
  const [n] = await q(`insert into auth.users(email) values ('pos-north@example.test') returning id`);
  await q(`insert into memberships(org_id, user_id, role, branch_ids) values ($1, $2, 'manager', array[$3::uuid])`, [ids.A.org, n.id, ids.A.north]);
  ids.northManager = n.id;
});

after(async () => pool.end());

test('every POS table is tenant-isolated for the tenant and member roles, even with a forged app.org_id', async () => {
  for (const table of POS_TABLES) {
    const col = table === 'pos_devices' || table === 'pos_device_pairings' ? 'org_id' : '*';
    const tenantRows = await as('resuto_tenant', { org: ids.A.org }, (c) => c.query(`select ${col === '*' ? 'org_id' : col} from ${table}`));
    assert.ok(tenantRows.rowCount > 0, `${table}: tenant A sees its rows`);
    assert.ok(tenantRows.rows.every((r) => r.org_id === ids.A.org), `${table}: tenant A sees only its rows`);
    const forged = await as('resuto_member', { user: ids.A.user, org: ids.B.org }, (c) => c.query(`select org_id from ${table}`));
    assert.equal(forged.rowCount, 0, `${table}: a member of A sees nothing of B`);
    const none = await as('resuto_tenant', {}, (c) => c.query(`select org_id from ${table}`));
    assert.equal(none.rowCount, 0, `${table}: no tenant context, no rows`);
  }
});

test('a member cannot write POS rows into another tenant', async () => {
  await assert.rejects(as('resuto_member', { user: ids.A.user, org: ids.A.org }, (c) => c.query(
    `insert into pos_device_pairings(org_id, branch_id, name, acting_role, code_hash, device_ttl_days, expires_at)
     values ($1, $2, 'x', 'waiter', $3, 1, now() + interval '1 minute')`, [ids.B.org, ids.B.main, sha('forged')])), /row-level security|violates/);
  await assert.rejects(as('resuto_tenant', { org: ids.A.org }, (c) => c.query(
    `insert into pos_print_jobs(org_id, branch_id, kind, order_id) values ($1, $2, 'receipt', $3)`, [ids.B.org, ids.B.main, ids.B.order])), /row-level security/);
  const revoked = await as('resuto_member', { user: ids.A.user, org: ids.A.org }, (c) =>
    c.query(`update pos_devices set status = 'revoked', revoked_at = now() where id = $1`, [ids.B.device]));
  assert.equal(revoked.rowCount, 0, 'A cannot revoke a device of B');
});

test('branch-scoped staff see only their branches', async () => {
  for (const table of ['pos_devices', 'pos_events', 'pos_print_jobs', 'pos_order_submissions']) {
    const rows = await as('resuto_member', { user: ids.northManager, org: ids.A.org }, (c) => c.query(`select branch_id from ${table}`));
    assert.equal(rows.rowCount, 0, `${table}: the north manager sees nothing of the main branch`);
    const owner = await as('resuto_member', { user: ids.A.user, org: ids.A.org }, (c) => c.query(`select branch_id from ${table}`));
    assert.ok(owner.rowCount > 0, `${table}: the owner sees the main branch`);
  }
});

test('credential hashes are never readable by sessions', async () => {
  for (const role of ['resuto_member', 'resuto_tenant']) {
    const who = role === 'resuto_member' ? { user: ids.A.user, org: ids.A.org } : { org: ids.A.org };
    await assert.rejects(as(role, who, (c) => c.query('select token_hash from pos_devices')), /permission denied/);
    await assert.rejects(as(role, who, (c) => c.query('select * from pos_devices')), /permission denied/);
    await assert.rejects(as(role, who, (c) => c.query('select code_hash from pos_device_pairings')), /permission denied/);
    const ok = await as(role, who, (c) => c.query('select id, token_prefix, status, last_seen_at from pos_devices'));
    assert.equal(ok.rowCount, 1);
  }
  // The platform role (the access guard) resolves a token by its hash.
  const found = await as('resuto_platform', {}, (c) => c.query('select id from pos_devices where token_hash = $1', [sha('token-B')]));
  assert.deepEqual(found.rows, [{ id: ids.B.device }]);
});

test('no session can write, rewrite or delete the event feed', async () => {
  for (const role of ['resuto_member', 'resuto_tenant']) {
    const who = role === 'resuto_member' ? { user: ids.A.user, org: ids.A.org } : { org: ids.A.org };
    await assert.rejects(as(role, who, (c) => c.query(
      `insert into pos_events(org_id, branch_id, seq, kind, entity_type, entity_id) values ($1, $2, 999, 'order.created', 'order', 'x')`,
      [ids.A.org, ids.A.main])), /permission denied/);
    await assert.rejects(as(role, who, (c) => c.query(`update pos_events set payload = '{}'`)), /permission denied/);
    await assert.rejects(as(role, who, (c) => c.query(`delete from pos_events`)), /permission denied/);
    await assert.rejects(as(role, who, (c) => c.query(`update pos_event_heads set last_seq = 0`)), /permission denied/);
    await assert.rejects(as(role, who, (c) => c.query(`select app.pos_emit($1, 'order.created', 'order', 'x', '{}', null)`, [ids.A.main])), /permission denied/);
    await assert.rejects(as(role, who, (c) => c.query(`select app.pos_events_purge('1 day', 10)`)), /permission denied/);
  }
  await assert.rejects(as('resuto_platform', {}, (c) => c.query(
    `insert into pos_events(org_id, branch_id, seq, kind, entity_type, entity_id) values ($1, $2, 999, 'order.created', 'order', 'x')`, [ids.A.org, ids.A.main])),
  /permission denied/);
  await as('resuto_platform', {}, (c) => c.query(`select app.pos_events_purge('7 days', 10)`));
  for (const role of ['anon', 'authenticated']) {
    for (const table of POS_TABLES) await assert.rejects(as(role, {}, (c) => c.query(`select 1 from ${table} limit 1`)), /permission denied/);
  }
});

test('the feed: one per branch from the first pairing, gap-free sequence, merged updates, kitchen print jobs', async () => {
  // A pairing opened the main branch feed; the north branch has none, so its changes write nothing.
  assert.equal((await q('select count(*)::int as n from pos_event_heads where branch_id = $1', [ids.A.north]))[0].n, 0);
  await order('A', ids.A.north);
  assert.equal((await q('select count(*)::int as n from pos_events where branch_id = $1', [ids.A.north]))[0].n, 0);

  const second = await order('A', ids.A.main, 'Bar');
  // Two timeline entries in one transaction: one order.updated with the final state.
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query(`update orders set status = 'accepted', version = version + 1 where id = $1`, [second]);
    await c.query(`insert into order_events(org_id, order_id, event_type, from_status, to_status, actor_type) values ($1, $2, 'status_changed', 'placed', 'accepted', 'user')`, [ids.A.org, second]);
    await c.query(`update orders set status = 'preparing', version = version + 1 where id = $1`, [second]);
    await c.query(`insert into order_events(org_id, order_id, event_type, from_status, to_status, actor_type) values ($1, $2, 'status_changed', 'accepted', 'preparing', 'user')`, [ids.A.org, second]);
    await c.query('commit');
  } finally { c.release(); }
  const rows = await q(`select seq, kind, entity_id, payload from pos_events where branch_id = $1 order by seq`, [ids.A.main]);
  assert.deepEqual(rows.map((r) => Number(r.seq)), rows.map((_, i) => i + 1), 'seq starts at 1 without gaps');
  const head = await q('select last_seq from pos_event_heads where branch_id = $1', [ids.A.main]);
  assert.equal(Number(head[0].last_seq), rows.length);
  const mine = rows.filter((r) => r.entity_id === second || r.payload.orderId === second);
  assert.deepEqual(mine.map((r) => r.kind), ['order.created', 'print_job.created', 'order.updated', 'ticket.status_changed', 'ticket.status_changed']);
  assert.equal(mine.find((r) => r.kind === 'order.updated').payload.status, 'preparing');
  const jobs = await q(`select kind, station from pos_print_jobs where order_id = $1`, [second]);
  assert.deepEqual(jobs, [{ kind: 'kitchen_ticket', station: 'Bar' }]);

  // A menu change reaches every branch feed of the organization once per transaction, and no other tenant.
  const before = Number((await q('select last_seq from pos_event_heads where branch_id = $1', [ids.B.main]))[0].last_seq);
  await q(`insert into menu_versions(org_id) values ($1) on conflict (org_id) do update set version = menu_versions.version + 1`, [ids.A.org]);
  const menu = await q(`select count(*)::int as n from pos_events where branch_id = $1 and kind = 'menu.changed'`, [ids.A.main]);
  assert.equal(menu[0].n, 1);
  assert.equal(Number((await q('select last_seq from pos_event_heads where branch_id = $1', [ids.B.main]))[0].last_seq), before);
});

test('pairing codes and credentials keep their shape and scope', async () => {
  await assert.rejects(q(`insert into pos_devices(org_id, branch_id, name, acting_role, token_prefix, token_hash) values ($1, $2, 'x', 'manager', 'p1', $3)`,
    [ids.A.org, ids.A.main, sha('m')]), /check/);
  await assert.rejects(q(`insert into pos_devices(org_id, branch_id, name, acting_role, token_prefix, token_hash) values ($1, $2, 'x', 'waiter', 'p2', 'plain')`,
    [ids.A.org, ids.A.main]), /check/);
  // A branch of another organization is refused by the composite key.
  await assert.rejects(q(`insert into pos_devices(org_id, branch_id, name, acting_role, token_prefix, token_hash) values ($1, $2, 'x', 'waiter', 'p3', $3)`,
    [ids.A.org, ids.B.main, sha('cross')]), /foreign key/);
  await assert.rejects(q(`update pos_devices set status = 'revoked' where id = $1`, [ids.A.device]), /check/);
  const [f] = await q(`select prosecdef, proconfig from pg_proc where oid = 'app.pos_emit(uuid, text, text, text, jsonb, text[])'::regprocedure`);
  assert.equal(f.prosecdef, true);
  assert.ok((f.proconfig ?? []).some((c) => /^search_path=public, ?pg_temp$/.test(c)));
});

test('requireStaff (contract 0.2.0): defaults to false and is readable by sessions; hashes stay unreadable', async () => {
  const [d] = await q('select require_staff from pos_devices where id = $1', [ids.A.device]);
  assert.equal(d.require_staff, false, 'existing and new devices default to the 0.1.0 behaviour');
  const [p] = await q('select require_staff from pos_device_pairings where org_id = $1 limit 1', [ids.A.org]);
  assert.equal(p.require_staff, false);
  for (const role of ['resuto_member', 'resuto_tenant']) {
    const who = role === 'resuto_member' ? { user: ids.A.user, org: ids.A.org } : { org: ids.A.org };
    const devices = await as(role, who, (c) => c.query('select id, require_staff from pos_devices'));
    assert.deepEqual(devices.rows, [{ id: ids.A.device, require_staff: false }], `${role} reads require_staff of its own devices only`);
    const pairings = await as(role, who, (c) => c.query('select require_staff from pos_device_pairings'));
    assert.ok(pairings.rowCount > 0);
    // The new column grant does not widen the table: whole-row reads and the hashes stay denied.
    await assert.rejects(as(role, who, (c) => c.query('select * from pos_devices')), /permission denied/);
    await assert.rejects(as(role, who, (c) => c.query('select token_hash from pos_devices')), /permission denied/);
    await assert.rejects(as(role, who, (c) => c.query('select code_hash from pos_device_pairings')), /permission denied/);
    // Another tenant's flag is invisible, like every other column.
    const forged = await as(role, role === 'resuto_member' ? { user: ids.A.user, org: ids.B.org } : { org: ids.B.org },
      (c) => c.query('select require_staff from pos_devices where id = $1', [ids.A.device]));
    assert.equal(forged.rowCount, 0);
  }
  // The platform role (the access guard) reads it with the credential lookup.
  const found = await as('resuto_platform', {}, (c) => c.query('select id, require_staff from pos_devices where token_hash = $1', [sha('token-A')]));
  assert.deepEqual(found.rows, [{ id: ids.A.device, require_staff: false }]);
  await assert.rejects(q('update pos_devices set require_staff = null where id = $1', [ids.A.device]), /null/);
});
