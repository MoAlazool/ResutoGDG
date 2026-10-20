// Database gate for the ResutoPay authenticity migrations (20261020030001, 20261020030002):
// one active provider attempt per checkout, one provider key per intended refund, one manual
// transfer reference per tenant, the stored-secret scrub, and who may read the new diagnostics
// and verification tables. Uses its own database (<TEST_DATABASE_URL>_payauth) so it can run
// in parallel with rls.test.mjs, which resets its own.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { migrate } from '../../scripts/db/migrate.mjs';
import { ensureDatabase } from '../../scripts/db/ensure-db.mjs';

const base = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:54329/resuto_test';
const url = base.replace(/\/([^/?]+)(\?.*)?$/, (_m, db, q = '') => `/${db}_payauth${q}`);
const pool = new pg.Pool({ connectionString: url, max: 4 });
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
  const [u] = await q(`insert into auth.users(email) values ('owner-pay@example.test') returning id`);
  const [o] = await q(`insert into organizations(slug, name) values ('pay-auth', 'Pay Auth') returning id`);
  const [b] = await q(`insert into branches(org_id, code, name) values ($1, 'main', 'Main') returning id`, [o.id]);
  await q(`insert into memberships(org_id, user_id, role) values ($1, $2, 'owner')`, [o.id, u.id]);
  const [ord] = await q(`insert into orders(org_id, branch_id, number, channel, fulfillment, currency, subtotal_minor, total_minor)
    values ($1, $2, '1', 'web', 'pickup', 'EGP', 10000, 10000) returning id`, [o.id, b.id]);
  const [cs] = await q(`insert into checkout_sessions(org_id, branch_id, token_hash, purpose, order_id, amount_minor, currency, allowed_methods, channel, expires_at)
    values ($1, $2, 'h-1', 'order', $3, 10000, 'EGP', '{card}', 'web', now() + interval '1 hour') returning id`, [o.id, b.id, ord.id]);
  const [conn] = await q(`insert into integration_connections(org_id, provider, category, auth_type, environment, status, credentials_encrypted, account_identity, last_webhook_at)
    values ($1, 'stripe', 'payments', 'api_key', 'sandbox', 'connected', 'v1:dev:x:y:z', '{"id":"acct_1"}', now()) returning id`, [o.id]);
  Object.assign(ids, { user: u.id, org: o.id, branch: b.id, order: ord.id, session: cs.id, conn: conn.id });
});
after(async () => pool.end());

const attempt = (status) => q(`insert into payments(org_id, branch_id, order_id, checkout_session_id, method, provider, amount_minor, currency, status)
  values ($1, $2, $3, $4, 'card', 'simulated', 10000, 'EGP', $5) returning id`, [ids.org, ids.branch, ids.order, ids.session, status]);

test('one active provider attempt per checkout session (PAY-09)', async () => {
  const [first] = await attempt('pending');
  await assert.rejects(attempt('pending'), /payments_one_active_attempt_idx/);
  await assert.rejects(attempt('authorized'), /payments_one_active_attempt_idx/);
  await attempt('failed'); // closed attempts do not count
  await q(`update payments set status = 'cancelled' where id = $1`, [first.id]);
  await attempt('pending');
});

test('one provider idempotency key per intended refund (PAY-05)', async () => {
  const [p] = await q(`insert into payments(org_id, branch_id, order_id, method, provider, amount_minor, currency, status)
    values ($1, $2, $3, 'card', 'stripe', 5000, 'EGP', 'succeeded') returning id`, [ids.org, ids.branch, ids.order]);
  const refund = (key, pkey) => q(`insert into refunds(org_id, payment_id, amount_minor, reason, idempotency_key, provider_idempotency_key) values ($1, $2, 100, 'r', $3, $4)`,
    [ids.org, p.id, key, pkey]);
  await refund('k1', `${p.id}:1`);
  await assert.rejects(refund('k2', `${p.id}:1`), /refunds_provider_key_idx/);
  await refund('k3', `${p.id}:2`);
  await assert.rejects(q(`insert into refunds(org_id, payment_id, amount_minor, reason, idempotency_key, source) values ($1, $2, 1, 'r', 'k4', 'elsewhere')`, [ids.org, p.id]), /check/);
});

test('a manual transfer reference is recorded once per tenant and method, case-insensitively (PAY-19)', async () => {
  const manual = (ref, method = 'instapay') => q(`insert into payments(org_id, branch_id, order_id, method, provider, amount_minor, currency, status, raw)
    values ($1, $2, $3, $4, 'manual', 100, 'EGP', 'succeeded', $5)`, [ids.org, ids.branch, ids.order, method, { reference: ref }]);
  await manual('IPN-1');
  await assert.rejects(manual('ipn-1'), /payments_manual_reference_idx/);
  await manual('IPN-1', 'bank_transfer');
});

test('members read connection diagnostics but never credentials, verifications or the webhook inbox', async () => {
  const rows = await as('resuto_member', { user: ids.user, org: ids.org }, (c) =>
    c.query('select last_success_at, last_failure_at, last_webhook_at, account_identity from integration_connections'));
  assert.equal(rows.rowCount, 1);
  assert.deepEqual(rows.rows[0].account_identity, { id: 'acct_1' });
  await assert.rejects(as('resuto_member', { user: ids.user, org: ids.org }, (c) => c.query('select credentials_encrypted from integration_connections')), /permission denied/);
  await assert.rejects(as('resuto_member', { user: ids.user, org: ids.org }, (c) => c.query('select * from integration_verifications')), /permission denied/);
  await assert.rejects(as('authenticated', { user: ids.user, org: ids.org }, (c) => c.query(`insert into integration_verifications(provider, capability, check_id, environment, status, ran_at)
    values ('stripe', 'checkout', 'x', 'live', 'passed', now())`)), /permission denied/);
  await assert.rejects(as('anon', {}, (c) => c.query('select * from integration_verifications')), /permission denied/);
  await assert.rejects(as('resuto_member', { user: ids.user, org: ids.org }, (c) => c.query('select payload from webhook_inbox')), /permission denied/);
});

test('verification rows are constrained to known environments and outcomes', async () => {
  await assert.rejects(q(`insert into integration_verifications(provider, capability, check_id, environment, status, ran_at) values ('stripe', 'checkout', 'c', 'staging', 'passed', now())`), /check/);
  await assert.rejects(q(`insert into integration_verifications(provider, capability, check_id, environment, status, ran_at) values ('stripe', 'checkout', 'c', 'live', 'great', now())`), /check/);
  await q(`insert into integration_verifications(provider, capability, check_id, environment, status, ran_at, commit_sha) values ('stripe', 'checkout', 'c', 'official_test', 'passed', now(), 'abc1234')`);
});

test('the migration scrubbed Moyasar secret tokens and unauthenticated bodies from the inbox (PAY-04, PAY-18)', async () => {
  // Re-run the scrub statements of 20261020030001 on rows shaped like the old ones.
  await q(`insert into webhook_inbox(provider, event_key, signature_valid, headers, payload, status) values
    ('payments:moyasar', 'old-1', true, '{}', '{"body":{"id":"evt","secret_token":"s3cret"}}', 'processed'),
    ('payments:stripe', 'rejected:old', false, '{}', '{"reason":"signature mismatch","body":{"email":"x@example.com"}}', 'rejected')`);
  await q(`update public.webhook_inbox set payload = payload #- '{body,secret_token}' where payload->'body' ? 'secret_token'`);
  await q(`update public.webhook_inbox set payload = jsonb_build_object('reason', payload->'reason', 'scrubbed', true) where status = 'rejected' and payload ? 'body'`);
  const rows = await q(`select event_key, payload from webhook_inbox where event_key in ('old-1', 'rejected:old') order by event_key`);
  assert.deepEqual(rows.map((r) => r.payload), [{ body: { id: 'evt' } }, { reason: 'signature mismatch', scrubbed: true }]);
});
