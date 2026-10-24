// Database gate for 21-ONB 20261025120002_organization_social_links: organizations.social_links takes known networks
// with https URLs only, is isolated by the organizations RLS policies, and changes the public menu version.
// Uses its own database (<TEST_DATABASE_URL>_onbsocial) so it can run beside the other DB tests.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { migrate } from '../../scripts/db/migrate.mjs';
import { ensureDatabase } from '../../scripts/db/ensure-db.mjs';

const base = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:54329/resuto_test';
const url = base.replace(/\/([^/?]+)(\?.*)?$/, (_m, db, q = '') => `/${db}_onbsocial${q}`);
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

/** An organization with an owner and (optionally) one subscription row. */
async function org(key, sub) {
  const [u] = await q(`insert into auth.users(email) values ($1) returning id`, [`owner-onb-${key}@example.test`]);
  const [o] = await q(`insert into organizations(slug, name) values ($1, $2) returning id`, [`onb-${key}`, `Onb ${key}`]);
  await q(`insert into memberships(org_id, user_id, role) values ($1, $2, 'owner')`, [o.id, u.id]);
  if (sub) {
    const [s] = await q(
      `insert into subscriptions(org_id, plan_id, status, country, currency, current_period_end, trial_ends_at, grace_until)
       values ($1, $2, $3, 'EG', 'EGP', now() + interval '20 days', $4, $5) returning id`,
      [o.id, sub.plan, sub.status, sub.trialEndsAt ?? null, sub.graceUntil ?? null]);
    ids[`${key}Sub`] = s.id;
  }
  ids[key] = { org: o.id, user: u.id };
  return o.id;
}


before(async () => {
  await ensureDatabase(url);
  await migrate({ url, reset: true, log: () => {} });
  await org('A', { plan: 'free', status: 'active' });
  await org('B', { plan: 'free', status: 'active' });
});
after(async () => pool.end());

test('social_links accepts known networks with https URLs only', async () => {
  const set = (links) => q(`update organizations set social_links = $2 where id = $1`, [ids.A.org, JSON.stringify(links)]);
  await set({ instagram: 'https://www.instagram.com/onb', website: 'https://onb.example', google_maps: 'https://maps.app.goo.gl/abc' });
  assert.deepEqual((await q(`select social_links from organizations where id = $1`, [ids.A.org]))[0].social_links,
    { instagram: 'https://www.instagram.com/onb', website: 'https://onb.example', google_maps: 'https://maps.app.goo.gl/abc' });
  await set({});
  for (const bad of [
    { myspace: 'https://myspace.com/onb' },
    { instagram: 'http://instagram.com/onb' },
    { website: 'javascript:alert(1)' },
    { website: 'JAVASCRIPT:alert(1)' },
    { website: 'https://evil.example/a b' },
    { facebook: 42 },
    { x: null },
  ]) {
    await assert.rejects(set(bad), /organizations_social_links_valid/, JSON.stringify(bad));
  }
  await assert.rejects(q(`update organizations set social_links = '[]' where id = $1`, [ids.A.org]), /organizations_social_links_valid/);
  await assert.rejects(q(`update organizations set social_links = $2 where id = $1`, [ids.A.org, JSON.stringify({ website: `https://a.example/${'x'.repeat(4100)}` })]), /organizations_social_links_valid/);
});

test('social_links are tenant-isolated: another restaurant cannot read or change them', async () => {
  await q(`update organizations set social_links = $2 where id = $1`, [ids.A.org, JSON.stringify({ instagram: 'https://instagram.com/onb_a' })]);
  // A member of A reads and updates A.
  const own = await as('resuto_member', { user: ids.A.user, org: ids.A.org }, (c) => c.query('select id, social_links from organizations'));
  assert.deepEqual(own.rows.map((r) => r.id), [ids.A.org]);
  // B's owner, even with app.org_id forged to A, sees and changes nothing of A.
  const forgedRead = await as('resuto_member', { user: ids.B.user, org: ids.A.org }, (c) => c.query('select social_links from organizations where id = $1', [ids.A.org]));
  assert.equal(forgedRead.rowCount, 0);
  const forgedWrite = await as('resuto_member', { user: ids.B.user, org: ids.A.org }, (c) =>
    c.query(`update organizations set social_links = '{"website":"https://evil.example"}' where id = $1`, [ids.A.org]));
  assert.equal(forgedWrite.rowCount, 0);
  const crossWrite = await as('resuto_member', { user: ids.B.user, org: ids.B.org }, (c) =>
    c.query(`update organizations set social_links = '{"website":"https://evil.example"}' where id = $1`, [ids.A.org]));
  assert.equal(crossWrite.rowCount, 0);
  // The tenant (system) role reads only its own row; it cannot write organizations at all.
  const tenant = await as('resuto_tenant', { org: ids.B.org }, (c) => c.query('select id from organizations'));
  assert.deepEqual(tenant.rows.map((r) => r.id), [ids.B.org]);
  await assert.rejects(as('resuto_tenant', { org: ids.A.org }, (c) => c.query(`update organizations set social_links = '{}' where id = $1`, [ids.A.org])), /permission denied/);
  // Direct client roles (supabase-js with a user or anon key) cannot read organizations at all.
  await assert.rejects(as('authenticated', { user: ids.B.user }, (c) => c.query('select social_links from organizations where id = $1', [ids.A.org])), /permission denied/);
  await assert.rejects(as('anon', {}, (c) => c.query('select social_links from organizations')), /permission denied/);
  assert.deepEqual((await q(`select social_links from organizations where id = $1`, [ids.A.org]))[0].social_links, { instagram: 'https://instagram.com/onb_a' });
});

test('changing social_links bumps the public menu version (the menu ETag changes)', async () => {
  const version = async () => Number((await q(`select version from menu_versions where org_id = $1`, [ids.B.org]))[0]?.version ?? 0);
  const v0 = await version();
  await q(`update organizations set social_links = '{"tiktok":"https://www.tiktok.com/@onb"}' where id = $1`, [ids.B.org]);
  const v1 = await version();
  assert.ok(v1 > v0, `version ${v0} -> ${v1}`);
  // Writing the same value again does not.
  await q(`update organizations set social_links = '{"tiktok":"https://www.tiktok.com/@onb"}' where id = $1`, [ids.B.org]);
  assert.equal(await version(), v1);
});
