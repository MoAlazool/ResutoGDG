// ws9 migrations: menu extraction jobs (20261021030001) are tenant-isolated; MCP OAuth state (20261021030003) is
// platform-only (no staff, tenant, authenticated or anon access, including codes and token hashes); the member column
// grant on mcp_clients covers the new non-secret columns but still not key_hash; approval binding (20261021030002)
// accepts the 'invalidated' status. Own disposable database (<TEST_DATABASE_URL>_ws9).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { migrate } from '../../scripts/db/migrate.mjs';
import { ensureDatabase } from '../../scripts/db/ensure-db.mjs';

const base = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:54329/resuto_test';
const url = base.replace(/\/([^/?]+)(\?.*)?$/, (_m, db, q = '') => `/${db}_ws9${q}`);
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
    const [u] = await q(`insert into auth.users(email) values ($1) returning id`, [`ws9-owner${k}@example.test`]);
    const [o] = await q(`insert into organizations(slug, name) values ($1, $2) returning id`, [`ws9-${k.toLowerCase()}`, `Studio ${k}`]);
    await q(`insert into memberships(org_id, user_id, role) values ($1, $2, 'owner')`, [o.id, u.id]);
    const [j] = await q(`insert into menu_extraction_jobs(org_id, status, mode, source_kind, provider, rows) values ($1, 'review', 'heuristic_text', 'text', 'resuto_parser', '[]') returning id`, [o.id]);
    const [c] = await q(`insert into mcp_clients(org_id, name, key_prefix, key_hash, acting_role, allowed_tools, created_by) values ($1, 'C', $2, $3, 'manager', '{list_menu}', $4) returning id`,
      [o.id, `rmcp_ws9${k}`, `hash-${k}`, u.id]);
    const [m] = await q(`insert into media_assets(org_id, path, content_type, byte_size) values ($1, $2, 'image/jpeg', 10) returning id`, [o.id, `${o.id}/photo-originals/x.jpg`]);
    const [p] = await q(`insert into studio_photo_jobs(org_id, source_media_id) values ($1, $2) returning id`, [o.id, m.id]);
    const [cr] = await q(`insert into creative_assets(org_id, kind, prompt, output, provider) values ($1, 'caption', 'brief', '{"variants":[]}', 'template_rules') returning id`, [o.id]);
    ids[k] = { user: u.id, org: o.id, job: j.id, client: c.id, photo: p.id, creative: cr.id };
  }
  await q(`insert into mcp_oauth_clients(client_id, kind, client_name, redirect_uris) values ('rmoc_ws9_test_client', 'dynamic', 'T', '{https://app.example/cb}')`);
  await q(`insert into mcp_oauth_tokens(token_hash, kind, family_id, client_id, mcp_client_id, org_id, resource, scopes, expires_at)
           values ('secret-hash', 'access', gen_random_uuid(), 'rmoc_ws9_test_client', $1, $2, 'https://mcp.example/mcp', '{mcp:read}', now() + interval '1 hour')`, [ids.A.client, ids.A.org]);
});

after(async () => pool.end());

test('menu extraction jobs: staff see only their own restaurant, even with a forged org', async () => {
  const own = await as('resuto_member', { user: ids.A.user, org: ids.A.org }, (c) => c.query('select id from menu_extraction_jobs'));
  assert.deepEqual(own.rows.map((r) => r.id), [ids.A.job]);
  const forged = await as('resuto_member', { user: ids.A.user, org: ids.B.org }, (c) => c.query('select id from menu_extraction_jobs'));
  assert.equal(forged.rowCount, 0);
  const tenant = await as('resuto_tenant', { org: ids.B.org }, (c) => c.query('select id from menu_extraction_jobs'));
  assert.deepEqual(tenant.rows.map((r) => r.id), [ids.B.job]);
});

test('food-photo jobs: staff and tenant roles see only their own restaurant', async () => {
  const own = await as('resuto_member', { user: ids.A.user, org: ids.A.org }, (c) => c.query('select id from studio_photo_jobs'));
  assert.deepEqual(own.rows.map((r) => r.id), [ids.A.photo]);
  const forged = await as('resuto_member', { user: ids.A.user, org: ids.B.org }, (c) => c.query('select id from studio_photo_jobs'));
  assert.equal(forged.rowCount, 0);
  const tenant = await as('resuto_tenant', { org: ids.B.org }, (c) => c.query('select id from studio_photo_jobs'));
  assert.deepEqual(tenant.rows.map((r) => r.id), [ids.B.photo]);
  const anon = await as('anon', {}, (c) => c.query('select count(*)::int as n from studio_photo_jobs')).then((r) => r.rows[0].n).catch((e) => String(e.message));
  assert.ok(anon === 0 || /permission denied/.test(String(anon)), `anon: ${anon}`);
});

test('creative applications: tenant-scoped, and only arrays are stored', async () => {
  const forged = await as('resuto_member', { user: ids.A.user, org: ids.B.org }, (c) => c.query('select id from creative_assets'));
  assert.equal(forged.rowCount, 0);
  await assert.rejects(pool.query(`update creative_assets set applications = '{"x":1}' where id = $1`, [ids.A.creative]), /creative_assets_applications_array/);
  await assert.rejects(pool.query(`update creative_assets set key_source = 'someone' where id = $1`, [ids.A.creative]), /check constraint/);
  const ok = await pool.query(`update creative_assets set applications = applications || '[{"target":"campaign_draft"}]'::jsonb returning jsonb_array_length(applications) as n`);
  assert.ok(ok.rows.every((r) => r.n === 1));
});

test('OAuth state is platform-only: no staff, tenant, authenticated or anon access', async () => {
  for (const table of ['mcp_oauth_clients', 'mcp_oauth_requests', 'mcp_oauth_codes', 'mcp_oauth_tokens']) {
    for (const [role, opts] of [['resuto_member', { user: ids.A.user, org: ids.A.org }], ['resuto_tenant', { org: ids.A.org }], ['authenticated', { user: ids.A.user }], ['anon', {}]]) {
      const res = await as(role, opts, (c) => c.query(`select * from ${table}`).then((r) => r.rowCount, (e) => e.message));
      assert.ok(res === 0 || /permission denied/.test(String(res)), `${role} read ${table}: ${res}`);
    }
  }
  const [{ relrowsecurity }] = (await pool.query(`select relrowsecurity from pg_class where oid = 'public.mcp_oauth_tokens'::regclass`)).rows;
  assert.equal(relrowsecurity, true);
});

test('members read the new mcp_clients columns but never key_hash', async () => {
  const ok = await as('resuto_member', { user: ids.A.user, org: ids.A.org }, (c) => c.query('select auth_kind, oauth_client_id from mcp_clients'));
  assert.deepEqual(ok.rows, [{ auth_kind: 'key', oauth_client_id: null }]);
  await assert.rejects(as('resuto_member', { user: ids.A.user, org: ids.A.org }, (c) => c.query('select key_hash from mcp_clients')), /permission denied/);
});

test('approvals accept the invalidated status and nothing else new', async () => {
  const ins = (status) => pool.query(`insert into mcp_approvals(org_id, client_id, tool, input, input_hash, summary, status, expires_at)
    values ($1, $2, 'update_product_availability', '{}', $3, 's', $4, now() + interval '1 hour')`, [ids.A.org, ids.A.client, `h-${status}`, status]);
  await ins('invalidated');
  await assert.rejects(ins('bogus'), /mcp_approvals_status_check/);
});
