// Database gate for 21-ONB increment 2 (20261026100001_onboarding_wizard): onboarding_progress is personal (only its
// owner reads or writes it; it can only point at a restaurant the owner belongs to), theme_presets are read-only
// reference data, and both shapes are enforced by constraints.
// Uses its own database (<TEST_DATABASE_URL>_onbwizard) so it can run beside the other DB tests.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { migrate } from '../../scripts/db/migrate.mjs';
import { ensureDatabase } from '../../scripts/db/ensure-db.mjs';

const base = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:54329/resuto_test';
const url = base.replace(/\/([^/?]+)(\?.*)?$/, (_m, db, q = '') => `/${db}_onbwizard${q}`);
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

async function org(key) {
  const [u] = await q(`insert into auth.users(email) values ($1) returning id`, [`owner-wiz-${key}@example.test`]);
  const [o] = await q(`insert into organizations(slug, name) values ($1, $2) returning id`, [`wiz-${key}`, `Wiz ${key}`]);
  await q(`insert into memberships(org_id, user_id, role) values ($1, $2, 'owner')`, [o.id, u.id]);
  ids[key] = { org: o.id, user: u.id };
}

before(async () => {
  await ensureDatabase(url);
  await migrate({ url, reset: true, log: () => {} });
  await org('A');
  await org('B');
  await q(`insert into onboarding_progress(user_id, org_id, step, completed) values ($1, $2, 'menu', array['account', 'restaurant', 'address', 'brand'])`, [ids.A.user, ids.A.org]);
});
after(async () => pool.end());

test('onboarding_progress has RLS and only its owner reads or changes it', async () => {
  const [{ relrowsecurity }] = await q(`select relrowsecurity from pg_class where oid = 'public.onboarding_progress'::regclass`);
  assert.equal(relrowsecurity, true);
  // The owner, acting as themselves with no tenant set (DbService.withUser), sees their row.
  const own = await as('resuto_member', { user: ids.A.user }, (c) => c.query('select user_id, step from onboarding_progress'));
  assert.deepEqual(own.rows, [{ user_id: ids.A.user, step: 'menu' }]);
  // B sees nothing of A's, even with app.org_id forged to A's restaurant, and cannot change or delete it.
  const forged = await as('resuto_member', { user: ids.B.user, org: ids.A.org }, (c) => c.query('select * from onboarding_progress'));
  assert.equal(forged.rowCount, 0);
  const write = await as('resuto_member', { user: ids.B.user, org: ids.A.org }, (c) => c.query(`update onboarding_progress set step = 'qr' where user_id = $1`, [ids.A.user]));
  assert.equal(write.rowCount, 0);
  const del = await as('resuto_member', { user: ids.B.user }, (c) => c.query('delete from onboarding_progress where user_id = $1', [ids.A.user]));
  assert.equal(del.rowCount, 0);
  // B cannot create a row in A's name.
  await assert.rejects(as('resuto_member', { user: ids.B.user }, (c) => c.query(`insert into onboarding_progress(user_id) values ($1)`, [ids.A.user])), /row-level security/);
  assert.deepEqual((await q('select step from onboarding_progress where user_id = $1', [ids.A.user]))[0], { step: 'menu' });
});

test('a progress row can only point at a restaurant its owner is an active member of', async () => {
  // B's own row linked to A's restaurant: refused on insert and on update.
  await assert.rejects(as('resuto_member', { user: ids.B.user }, (c) =>
    c.query(`insert into onboarding_progress(user_id, org_id, step) values ($1, $2, 'brand')`, [ids.B.user, ids.A.org])), /row-level security/);
  await as('resuto_member', { user: ids.B.user }, async (c) => {
    await c.query(`insert into onboarding_progress(user_id, org_id, step) values ($1, $2, 'brand')`, [ids.B.user, ids.B.org]);
    await assert.rejects(c.query(`update onboarding_progress set org_id = $2 where user_id = $1`, [ids.B.user, ids.A.org]), /row-level security/);
  });
  // A suspended membership no longer counts.
  await q(`update memberships set status = 'suspended' where user_id = $1`, [ids.B.user]);
  try {
    await assert.rejects(as('resuto_member', { user: ids.B.user }, (c) =>
      c.query(`insert into onboarding_progress(user_id, org_id, step) values ($1, $2, 'brand')`, [ids.B.user, ids.B.org])), /row-level security/);
  } finally {
    await q(`update memberships set status = 'active' where user_id = $1`, [ids.B.user]);
  }
});

test('other roles cannot reach onboarding_progress at all', async () => {
  await assert.rejects(as('resuto_tenant', { org: ids.A.org }, (c) => c.query('select * from onboarding_progress')), /permission denied/);
  await assert.rejects(as('authenticated', { user: ids.A.user }, (c) => c.query('select * from onboarding_progress')), /permission denied/);
  await assert.rejects(as('anon', {}, (c) => c.query('select * from onboarding_progress')), /permission denied/);
  await assert.rejects(as('resuto_platform', {}, (c) => c.query('select * from onboarding_progress')), /permission denied/);
});

test('onboarding_progress keeps a valid shape', async () => {
  const [u] = await q(`insert into auth.users(email) values ('shape-wiz@example.test') returning id`);
  await assert.rejects(q(`insert into onboarding_progress(user_id, step) values ($1, 'ordering')`, [u.id]), /check/);
  await assert.rejects(q(`insert into onboarding_progress(user_id, completed) values ($1, array['account', 'payments'])`, [u.id]), /check/);
  await assert.rejects(q(`insert into onboarding_progress(user_id, draft) values ($1, '[]')`, [u.id]), /check/);
  await assert.rejects(q(`insert into onboarding_progress(user_id, draft) values ($1, $2)`, [u.id, JSON.stringify({ name: 'x'.repeat(2100) })]), /check/);
  await assert.rejects(q(`insert into onboarding_progress(user_id, completed_at) values ($1, now())`, [u.id]), /check/);
  // A restaurant step without a restaurant is moved back to the address step.
  await q(`insert into onboarding_progress(user_id, step) values ($1, 'menu')`, [u.id]);
  assert.equal((await q('select step from onboarding_progress where user_id = $1', [u.id]))[0].step, 'address');
});

test('deleting the restaurant restarts the wizard at the address step; deleting the person removes the row', async () => {
  const [u] = await q(`insert into auth.users(email) values ('gone-wiz@example.test') returning id`);
  const [o] = await q(`insert into organizations(slug, name) values ('wiz-gone', 'Gone') returning id`);
  await q(`insert into memberships(org_id, user_id, role) values ($1, $2, 'owner')`, [o.id, u.id]);
  await q(`insert into onboarding_progress(user_id, org_id, step, completed_at) values ($1, $2, 'qr', now())`, [u.id, o.id]);
  await q('delete from memberships where org_id = $1', [o.id]);
  await q('delete from organizations where id = $1', [o.id]);
  assert.deepEqual((await q('select step, org_id, completed_at from onboarding_progress where user_id = $1', [u.id]))[0], { step: 'address', org_id: null, completed_at: null });
  await q('delete from auth.users where id = $1', [u.id]);
  assert.deepEqual(await q('select 1 from onboarding_progress where user_id = $1', [u.id]), []);
});

test('theme_presets are read-only reference data with complete themes', async () => {
  const [{ relrowsecurity }] = await q(`select relrowsecurity from pg_class where oid = 'public.theme_presets'::regclass`);
  assert.equal(relrowsecurity, true);
  const read = await as('resuto_member', { user: ids.A.user, org: ids.A.org }, (c) => c.query('select id from theme_presets order by sort_order'));
  assert.deepEqual(read.rows.map((r) => r.id), ['cafe', 'bakery', 'fine_dining', 'qsr', 'cloud_kitchen', 'family']);
  assert.equal((await as('resuto_tenant', { org: ids.A.org }, (c) => c.query('select id from theme_presets'))).rowCount, 6);
  for (const role of ['resuto_member', 'resuto_tenant']) {
    const who = role === 'resuto_member' ? { user: ids.A.user, org: ids.A.org } : { org: ids.A.org };
    await assert.rejects(as(role, who, (c) => c.query(`update theme_presets set name_en = 'Hacked'`)), /permission denied/);
    await assert.rejects(as(role, who, (c) => c.query(`insert into theme_presets(id, name_en, name_ar, template, website_theme, storefront_theme) select 'x1', 'X', 'X', template, website_theme, storefront_theme from theme_presets limit 1`)), /permission denied/);
    await assert.rejects(as(role, who, (c) => c.query(`delete from theme_presets`)), /permission denied/);
  }
  await assert.rejects(as('anon', {}, (c) => c.query('select * from theme_presets')), /permission denied/);
  await assert.rejects(as('authenticated', { user: ids.A.user }, (c) => c.query('select * from theme_presets')), /permission denied/);
  // An inactive preset is not offered.
  await q(`update theme_presets set is_active = false where id = 'bakery'`);
  try {
    const active = await as('resuto_member', { user: ids.A.user, org: ids.A.org }, (c) => c.query(`select id from theme_presets where id = 'bakery'`));
    assert.equal(active.rowCount, 0);
  } finally {
    await q(`update theme_presets set is_active = true where id = 'bakery'`);
  }
  // Shape: every key, #rrggbb colours, a known font and template.
  const bad = [
    [`'{"primaryColor":"#000000","accentColor":"#000000","backgroundColor":"#ffffff"}'`, `'{"primaryColor":"#000000","accentColor":"#000000","inkColor":"#000000","paperColor":"#ffffff"}'`],
    [`'{"primaryColor":"red","accentColor":"#000000","backgroundColor":"#ffffff","font":"manrope"}'`, `'{"primaryColor":"#000000","accentColor":"#000000","inkColor":"#000000","paperColor":"#ffffff"}'`],
    [`'{"primaryColor":"#000000","accentColor":"#000000","backgroundColor":"#ffffff","font":"comic"}'`, `'{"primaryColor":"#000000","accentColor":"#000000","inkColor":"#000000","paperColor":"#ffffff"}'`],
    [`'{"primaryColor":"#000000","accentColor":"#000000","backgroundColor":"#ffffff","font":"manrope","logo":"x"}'`, `'{"primaryColor":"#000000","accentColor":"#000000","inkColor":"#000000","paperColor":"#ffffff"}'`],
    [`'{"primaryColor":"#000000","accentColor":"#000000","backgroundColor":"#ffffff","font":"manrope"}'`, `'{"primaryColor":"#000000","accentColor":"#000000","inkColor":"black","paperColor":"#ffffff"}'`],
  ];
  for (const [w, s] of bad) {
    await assert.rejects(q(`insert into theme_presets(id, name_en, name_ar, template, website_theme, storefront_theme) values ('bad_one', 'Bad', 'Bad', 'olive', ${w}, ${s})`), /check/);
  }
});

test('websites.theme_preset_id refers to a preset', async () => {
  const [w] = await q(`insert into websites(org_id) values ($1) returning id`, [ids.A.org]);
  await q(`update websites set theme_preset_id = 'cafe' where id = $1`, [w.id]);
  await assert.rejects(q(`update websites set theme_preset_id = 'nightclub' where id = $1`, [w.id]), /foreign key/);
});
