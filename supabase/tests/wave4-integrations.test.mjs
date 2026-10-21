// ws7b (wave 4) integration tables: tenant isolation, direct-client lockdown and the constraints the services rely
// on — outbound email/SMS queue and opt-outs (INT-28), driver push events (FT-22), ZATCA EGS units (INT-26),
// accounting push items (INT-25).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { migrate } from '../../scripts/db/migrate.mjs';
import { ensureDatabase } from '../../scripts/db/ensure-db.mjs';

const url = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:54329/resuto_test';
const pool = new pg.Pool({ connectionString: url, max: 4 });
const ids = {};
const q = (sql, params) => pool.query(sql, params).then((r) => r.rows);
const HASH = 'a'.repeat(64);

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
const outbound = (org, key, extra = {}) => q(
  `insert into outbound_messages(org_id, channel, purpose, provider, recipient_sealed, recipient_hint, address_hash, body_text, idempotency_key, status)
   values ($1, $2, 'marketing', $3, 'sealed', 'm***@x.example', $4, 'Hello', $5, $6) returning id`,
  [org, extra.channel ?? 'email', extra.provider ?? 'resend', extra.hash ?? HASH, key, extra.status ?? 'queued']);

before(async () => {
  await ensureDatabase(url);
  await migrate({ url, reset: true, log: () => {} });
  for (const k of ['A', 'B']) {
    const [u] = await q(`insert into auth.users(email) values ($1) returning id`, [`w4-owner${k}@example.test`]);
    const [o] = await q(`insert into organizations(slug, name) values ($1, $2) returning id`, [`w4-${k.toLowerCase()}`, `Wave4 ${k}`]);
    await q(`insert into memberships(org_id, user_id, role) values ($1, $2, 'owner')`, [o.id, u.id]);
    const [m] = await outbound(o.id, `campaign:test:${k}-0001`);
    ids[k] = { user: u.id, org: o.id, outbound: m.id };
  }
});
after(async () => pool.end());

test('row level security is on for every new table', async () => {
  for (const t of ['outbound_messages', 'channel_unsubscribes', 'messaging_policies', 'driver_push_events', 'zatca_egs_units', 'accounting_push_items']) {
    const [{ relrowsecurity }] = await q(`select relrowsecurity from pg_class where oid = $1::regclass`, [`public.${t}`]);
    assert.equal(relrowsecurity, true, `${t} must have RLS`);
  }
});

test('a tenant sees and writes only its own queue rows', async () => {
  const rows = await as('resuto_tenant', { org: ids.A.org }, (c) => c.query('select id, org_id from outbound_messages'));
  assert.deepEqual(rows.rows.map((r) => r.id), [ids.A.outbound]);
  await assert.rejects(as('resuto_tenant', { org: ids.A.org }, (c) => c.query(
    `insert into outbound_messages(org_id, channel, purpose, provider, recipient_sealed, recipient_hint, address_hash, body_text, idempotency_key)
     values ($1, 'sms', 'marketing', 'twilio_sms', 's', '+20••••01', $2, 'x', 'forged-0000001')`, [ids.B.org, HASH])), /row-level security/);
  const upd = await as('resuto_tenant', { org: ids.A.org }, (c) => c.query(`update outbound_messages set status = 'failed' where id = $1`, [ids.B.outbound]));
  assert.equal(upd.rowCount, 0);
});

test('direct Supabase clients (authenticated) cannot read the queue, opt-outs, EGS keys or push events', async () => {
  for (const t of ['outbound_messages', 'channel_unsubscribes', 'messaging_policies', 'driver_push_events', 'zatca_egs_units']) {
    await assert.rejects(as('authenticated', { user: ids.A.user }, (c) => c.query(`select * from ${t} limit 1`)), /permission denied/, t);
  }
});

test('queue constraints: idempotency per org, known statuses, hashed addresses', async () => {
  await assert.rejects(outbound(ids.A.org, 'campaign:test:A-0001'), /duplicate key/);
  await outbound(ids.B.org, 'campaign:test:A-0001'); // same key, other tenant: fine
  await assert.rejects(outbound(ids.A.org, 'campaign:test:A-0002', { status: 'sent_maybe' }), /check constraint/);
  await assert.rejects(outbound(ids.A.org, 'campaign:test:A-0003', { hash: 'not-a-hash' }), /check constraint/);
  await assert.rejects(outbound(ids.A.org, 'campaign:test:A-0004', { provider: 'mailchimp' }), /check constraint/);
  await q(`update outbound_messages set provider_message_id = 'em_1' where id = $1`, [ids.A.outbound]);
  const [other] = await outbound(ids.A.org, 'campaign:test:A-0005');
  await assert.rejects(q(`update outbound_messages set provider_message_id = 'em_1' where id = $1`, [other.id]), /duplicate key/);
});

test('one opt-out per address and channel; quiet hours need both ends', async () => {
  await q(`insert into channel_unsubscribes(org_id, channel, address_hash, source) values ($1, 'email', $2, 'link')`, [ids.A.org, HASH]);
  await assert.rejects(q(`insert into channel_unsubscribes(org_id, channel, address_hash, source) values ($1, 'email', $2, 'one_click')`, [ids.A.org, HASH]), /duplicate key/);
  await q(`insert into channel_unsubscribes(org_id, channel, address_hash, source) values ($1, 'sms', $2, 'link')`, [ids.A.org, HASH]);
  await assert.rejects(q(`insert into messaging_policies(org_id, quiet_hours_start, quiet_hours_end) values ($1, '22:00', null)`, [ids.A.org]), /check constraint/);
  await q(`insert into messaging_policies(org_id, quiet_hours_start, quiet_hours_end) values ($1, null, null)`, [ids.A.org]);
});

test('widened delivery statuses: skipped_unsubscribed for campaigns, queued for staff email', async () => {
  const defs = await q(`select conname, pg_get_constraintdef(oid) as def from pg_constraint where conname in ('campaign_deliveries_status_check', 'notification_deliveries_status_check')`);
  const byName = Object.fromEntries(defs.map((d) => [d.conname, d.def]));
  assert.match(byName.campaign_deliveries_status_check, /skipped_unsubscribed/);
  assert.match(byName.notification_deliveries_status_check, /queued/);
});

test('one live ZATCA EGS unit per branch and environment (the branch chain it reports), with a well-formed serial', async () => {
  const branch = async (org, code) => (await q(`insert into branches(org_id, code, name) values ($1, $2, $2) returning id`, [org, code]))[0].id;
  const a1 = await branch(ids.A.org, 'egs-a1');
  const a2 = await branch(ids.A.org, 'egs-a2');
  const b1 = await branch(ids.B.org, 'egs-b1');
  const egs = (org, br, env, serial, status = 'key_generated', activatedAt = null) => q(
    `insert into zatca_egs_units(org_id, branch_id, environment, status, common_name, egs_serial, invoice_type, private_key_sealed, csr_pem, activated_at)
     values ($1, $2, $3, $4, 'EGS', $5, '0100', 'sealed', 'csr', $6) returning id`, [org, br, env, status, serial, activatedAt]);
  await egs(ids.A.org, a1, 'sandbox', '1-a|2-b|3-c');
  await assert.rejects(egs(ids.A.org, a1, 'sandbox', '1-a|2-b|3-d'), /duplicate key/);
  await egs(ids.A.org, a2, 'sandbox', '1-a|2-b|3-d'); // another branch: its own unit
  await egs(ids.A.org, a1, 'sandbox', '1-a|2-b|3-e', 'retired');
  await egs(ids.A.org, a1, 'production', '1-a|2-b|3-c');
  await assert.rejects(egs(ids.B.org, b1, 'sandbox', 'serial-only'), /check constraint/);
  // An active unit records when it was activated; a unit never points at another organisation's branch.
  await assert.rejects(egs(ids.B.org, b1, 'simulation', '1-a|2-b|3-f', 'active'), /zatca_egs_units_active_has_activation/);
  await egs(ids.B.org, b1, 'simulation', '1-a|2-b|3-f', 'active', new Date());
  await assert.rejects(egs(ids.B.org, a1, 'sandbox', '1-a|2-b|3-g'), /does not belong to organisation/);
  const rows = await as('resuto_tenant', { org: ids.B.org }, (c) => c.query('select branch_id from zatca_egs_units'));
  assert.deepEqual(rows.rows.map((r) => r.branch_id), [b1]);
});

test('a connection records when it was first connected in its current environment; changing the environment restarts it', async () => {
  const [c] = await q(
    `insert into integration_connections(org_id, provider, category, auth_type, environment, status) values ($1, 'eta_ereceipt', 'tax', 'oauth', 'sandbox', 'pending') returning id, environment_connected_at`,
    [ids.A.org]);
  assert.equal(c.environment_connected_at, null);
  const [first] = await q(`update integration_connections set status = 'connected' where id = $1 returning environment_connected_at`, [c.id]);
  assert.ok(first.environment_connected_at);
  const [again] = await q(`update integration_connections set status = 'error' where id = $1 returning environment_connected_at`, [c.id]);
  assert.deepEqual(again.environment_connected_at, first.environment_connected_at); // an outage does not move it
  const [reconnected] = await q(`update integration_connections set status = 'connected' where id = $1 returning environment_connected_at`, [c.id]);
  assert.deepEqual(reconnected.environment_connected_at, first.environment_connected_at);
  const [switched] = await q(`update integration_connections set environment = 'live', status = 'pending' where id = $1 returning environment_connected_at`, [c.id]);
  assert.equal(switched.environment_connected_at, null);
});
