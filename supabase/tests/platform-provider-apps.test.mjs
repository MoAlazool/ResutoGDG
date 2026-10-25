// Database gate for 21-INT (migrations 20261025410001 platform_provider_apps, 20261025410002 channel routing):
// Resuto's provider apps are platform-only — no member, tenant or Supabase client role can read or write them, the
// platform role reaches them only through its policies, and a plaintext secret cannot be stored; a channel's staff
// routing is tenant data under the channel's RLS with a closed set of modes. Uses its own database
// (<TEST_DATABASE_URL>_providerapps) so it can run beside the other DB tests.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { migrate } from '../../scripts/db/migrate.mjs';
import { ensureDatabase } from '../../scripts/db/ensure-db.mjs';

const base = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:54329/resuto_test';
const url = base.replace(/\/([^/?]+)(\?.*)?$/, (_m, db, q = '') => `/${db}_providerapps${q}`);
const pool = new pg.Pool({ connectionString: url, max: 4 });
const q = (sql, params) => pool.query(sql, params).then((r) => r.rows);
const ids = {};
const SEALED = 'v1:k1:aXY=:dGFn:Y2lwaGVy';

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
    const [u] = await q(`insert into auth.users(email) values ($1) returning id`, [`owner-apps-${k}@example.test`]);
    const [o] = await q(`insert into organizations(slug, name) values ($1, $2) returning id`, [`apps-${k.toLowerCase()}`, `Apps ${k}`]);
    const [b] = await q(`insert into branches(org_id, code, name) values ($1, 'main', 'Main') returning id`, [o.id]);
    await q(`insert into memberships(org_id, user_id, role) values ($1, $2, 'owner')`, [o.id, u.id]);
    const [ch] = await q(`insert into messaging_channels(org_id, branch_id, kind, transport, display_name) values ($1, $2, 'whatsapp', 'sandbox', 'Sandbox') returning id`, [o.id, b.id]);
    ids[k] = { org: o.id, user: u.id, branch: b.id, channel: ch.id };
  }
  await q(`insert into platform_provider_apps(provider, environment, app_id, config_ids, secrets_sealed, secrets_hint, review_status)
    values ('meta', 'live', '1234567890', '{"whatsappSignupConfigId":"998877"}', $1, '{"appSecret":"…f00d"}', 'in_review')`, [SEALED]);
});
after(async () => pool.end());

test('platform provider apps: no member, tenant or client role can read or write them', async () => {
  const roles = [['resuto_member', { user: ids.A.user, org: ids.A.org }], ['resuto_tenant', { org: ids.A.org }], ['authenticated', { user: ids.A.user }], ['anon', {}]];
  for (const [role, ctx] of roles) {
    await assert.rejects(as(role, ctx, (c) => c.query('select provider from platform_provider_apps')), /permission denied/, `${role} read`);
    await assert.rejects(as(role, ctx, (c) => c.query('select secrets_sealed from platform_provider_apps')), /permission denied/, `${role} read secrets`);
    await assert.rejects(as(role, ctx, (c) => c.query(`insert into platform_provider_apps(provider) values ('foodics')`)), /permission denied/, `${role} insert`);
    await assert.rejects(as(role, ctx, (c) => c.query(`update platform_provider_apps set review_status = 'approved'`)), /permission denied/, `${role} update`);
    await assert.rejects(as(role, ctx, (c) => c.query(`delete from platform_provider_apps`)), /permission denied/, `${role} delete`);
  }
  const [{ relrowsecurity }] = await q(`select relrowsecurity from pg_class where oid = 'public.platform_provider_apps'::regclass`);
  assert.equal(relrowsecurity, true);
  const policies = await q(`select policyname, roles::text[] as roles from pg_policies where tablename = 'platform_provider_apps' order by policyname`);
  assert.deepEqual(policies.map((p) => p.policyname), ['platform_delete', 'platform_insert', 'platform_select', 'platform_update']);
  for (const p of policies) assert.deepEqual(p.roles, ['resuto_platform'], `${p.policyname} is for the platform role only`);
});

test('the platform role reads and writes provider apps through its policies', async () => {
  const rows = await as('resuto_platform', {}, async (c) => {
    await c.query(`insert into platform_provider_apps(provider, environment, app_id) values ('foodics', 'sandbox', 'foodics-client-1')`);
    await c.query(`update platform_provider_apps set review_status = 'approved' where provider = 'foodics'`);
    const r = (await c.query(`select provider, environment, review_status from platform_provider_apps order by provider`)).rows;
    await c.query(`delete from platform_provider_apps where provider = 'foodics'`);
    return r;
  });
  assert.deepEqual(rows, [
    { provider: 'foodics', environment: 'sandbox', review_status: 'approved' },
    { provider: 'meta', environment: 'live', review_status: 'in_review' },
  ]);
});

test('provider app constraints: known providers only, sealed envelopes only, closed review states', async () => {
  await assert.rejects(q(`insert into platform_provider_apps(provider) values ('stripe')`), /check/);
  await assert.rejects(q(`insert into platform_provider_apps(provider, secrets_sealed) values ('tiktok_ads', 'plain-app-secret')`), /check/, 'plaintext secret refused');
  await assert.rejects(q(`insert into platform_provider_apps(provider, review_status) values ('tiktok_ads', 'verified')`), /check/);
  await assert.rejects(q(`insert into platform_provider_apps(provider, environment) values ('tiktok_ads', 'staging')`), /check/);
  await assert.rejects(q(`insert into platform_provider_apps(provider, app_id) values ('tiktok_ads', 'id with spaces')`), /check/);
  await assert.rejects(q(`insert into platform_provider_apps(provider) values ('meta')`), /duplicate key/, 'one app per provider');
});

test('channel routing: default manual, closed set of modes, tenant-isolated under the channel RLS', async () => {
  const [{ routing }] = await q(`select routing from messaging_channels where id = $1`, [ids.A.channel]);
  assert.equal(routing, 'manual');
  await assert.rejects(q(`update messaging_channels set routing = 'random' where id = $1`, [ids.A.channel]), /check/);
  const own = await as('resuto_member', { user: ids.A.user, org: ids.A.org }, async (c) => {
    const r = await c.query(`update messaging_channels set routing = 'round_robin' where id = $1 returning routing`, [ids.A.channel]);
    return r.rows;
  });
  assert.deepEqual(own, [{ routing: 'round_robin' }]);
  const cross = await as('resuto_member', { user: ids.A.user, org: ids.A.org }, (c) =>
    c.query(`update messaging_channels set routing = 'by_branch' where id = $1 returning id`, [ids.B.channel]));
  assert.equal(cross.rowCount, 0, 'a member of A cannot change B\'s channel');
  const forged = await as('resuto_member', { user: ids.A.user, org: ids.B.org }, (c) => c.query(`select routing from messaging_channels`));
  assert.equal(forged.rowCount, 0, 'forging app.org_id to B shows nothing');
});
