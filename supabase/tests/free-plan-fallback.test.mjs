// Database gate for 21-ONB 20261025120001_module_enabled_free_fallback: a restaurant without a live subscription
// keeps the Free plan's modules (a lapsed trial keeps core) instead of losing everything.
// Uses its own database (<TEST_DATABASE_URL>_onbfree) so it can run beside the other DB tests.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { migrate } from '../../scripts/db/migrate.mjs';
import { ensureDatabase } from '../../scripts/db/ensure-db.mjs';

const base = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:54329/resuto_test';
const url = base.replace(/\/([^/?]+)(\?.*)?$/, (_m, db, q = '') => `/${db}_onbfree${q}`);
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

const enabled = async (orgId, module) => (await q(`select app.module_enabled($1, $2) as on`, [orgId, module]))[0].on;
const freeModules = async () => (await q(`select module::text from plan_modules where plan_id = 'free' order by module`)).map((r) => r.module);

before(async () => {
  await ensureDatabase(url);
  await migrate({ url, reset: true, log: () => {} });
  const past = new Date(Date.now() - 864e5);
  await org('trial', { plan: 'growth', status: 'trialing', trialEndsAt: new Date(Date.now() + 5 * 864e5) });
  // A growth trial that ended, went past_due and ran out of grace: the lifecycle job marks it unpaid.
  await org('lapsed', { plan: 'growth', status: 'unpaid', trialEndsAt: past });
  await org('graceover', { plan: 'growth', status: 'past_due', trialEndsAt: past, graceUntil: past });
  await org('grace', { plan: 'growth', status: 'past_due', trialEndsAt: past, graceUntil: new Date(Date.now() + 864e5) });
  await org('canceled', { plan: 'pro', status: 'canceled' });
  await org('paused', { plan: 'starter', status: 'paused' });
  await org('nosub');
  await org('closed', { plan: 'growth', status: 'unpaid' });
  await q(`update organizations set status = 'closed' where id = $1`, [ids.closed.org]);
  await org('A', { plan: 'free', status: 'active' });
  await org('B', { plan: 'free', status: 'active' });
});
after(async () => pool.end());

test('the seeded free plan includes core (the floor this migration falls back to)', async () => {
  assert.ok((await freeModules()).includes('core'));
});

test('a lapsed trial keeps core: no live subscription falls back to the free plan, never to nothing', async () => {
  const free = await freeModules();
  for (const key of ['lapsed', 'graceover', 'canceled', 'paused', 'nosub']) {
    assert.equal(await enabled(ids[key].org, 'core'), true, `${key}: core stays on`);
    for (const m of ['marketing', 'studio', 'connect', 'intelligence', 'mcp', 'pay']) {
      if (!free.includes(m)) assert.equal(await enabled(ids[key].org, m), false, `${key}: paid module ${m} is off`);
    }
  }
});

test('a live subscription is unchanged: trial and grace keep the paid plan, its modules only', async () => {
  for (const key of ['trial', 'grace']) {
    assert.equal(await enabled(ids[key].org, 'core'), true, key);
    assert.equal(await enabled(ids[key].org, 'marketing'), true, `${key}: growth includes marketing`);
    assert.equal(await enabled(ids[key].org, 'mcp'), false, `${key}: growth does not include mcp`);
  }
  assert.equal(await enabled(ids.A.org, 'core'), true);
  assert.equal(await enabled(ids.A.org, 'marketing'), false);
});

test('a closed restaurant and an unknown organization get nothing', async () => {
  assert.equal(await enabled(ids.closed.org, 'core'), false);
  assert.equal(await enabled('00000000-0000-4000-8000-000000000000', 'core'), false);
});

test('an override still wins over the free floor (a platform block keeps core off)', async () => {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query(`insert into entitlement_overrides(org_id, module, enabled, reason) values ($1, 'core', false, 'test block')`, [ids.lapsed.org]);
    assert.equal((await c.query(`select app.module_enabled($1, 'core') as on`, [ids.lapsed.org])).rows[0].on, false);
  } finally {
    await c.query('rollback');
    c.release();
  }
});

test('the floor is data: it follows the free plan\'s plan_modules rows, not a hard-coded list', async () => {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query(`insert into plan_modules(plan_id, module) values ('free', 'studio') on conflict do nothing`);
    assert.equal((await c.query(`select app.module_enabled($1, 'studio') as on`, [ids.lapsed.org])).rows[0].on, true);
  } finally {
    await c.query('rollback');
    c.release();
  }
  assert.equal(await enabled(ids.lapsed.org, 'studio'), false);
});

test('the runtime roles can call module_enabled; anon and authenticated cannot', async () => {
  for (const role of ['resuto_member', 'resuto_tenant', 'resuto_platform']) {
    const r = await as(role, { user: ids.lapsed.user, org: ids.lapsed.org }, (c) => c.query(`select app.module_enabled($1, 'core') as on`, [ids.lapsed.org]));
    assert.equal(r.rows[0].on, true, role);
  }
  for (const role of ['anon', 'authenticated']) {
    await assert.rejects(as(role, { user: ids.lapsed.user }, (c) => c.query(`select app.module_enabled($1, 'core')`, [ids.lapsed.org])), /permission denied/, role);
  }
});
