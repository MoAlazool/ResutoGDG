// The demo loader's single-runner lease (scripts/demo/lib/lease.mjs): staging starts the loader on every boot, so two
// runs must never refresh the demo tenant at once. Needs a local Postgres (job_leases comes from the migrations).
//
//   DEMO_TEST_DATABASE_URL (this file uses <that name>_lease, so it never shares a database with integrity.test.mjs)
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';
import { ensureDatabase } from '../../db/ensure-db.mjs';
import { migrate } from '../../db/migrate.mjs';
import { claimLease, leaseName, releaseLease, renewLease } from '../lib/lease.mjs';

const base = new URL(process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:54329/resuto_test');
const integrity = process.env.DEMO_TEST_DATABASE_URL ?? (() => { const u = new URL(base); u.pathname = `${base.pathname}_demo_integrity`; return u.toString(); })();
const url = (() => { const u = new URL(integrity); u.pathname = `${u.pathname}_lease`; return u.toString(); })();
let pool;
const q = async (text, params = []) => (await pool.query(text, params)).rows;
const SLUG = `lease-test-${process.pid}`;

before(async () => {
  if (!['127.0.0.1', 'localhost', '::1'].includes(new URL(url).hostname)) throw new Error('local databases only');
  await ensureDatabase(url);
  await migrate({ url, log: () => {} });
  pool = new pg.Pool({ connectionString: url, max: 2 });
});
after(async () => {
  await q(`delete from job_leases where job = $1`, [leaseName(SLUG)]).catch(() => undefined);
  await pool?.end();
});

describe('demo loader lease', () => {
  it('lets one run in and turns a concurrent second run away until the first releases', async () => {
    const first = await claimLease(q, SLUG, { owner: 'boot-a' });
    assert.equal(first.owner, 'boot-a');
    const second = await claimLease(q, SLUG, { owner: 'boot-b' });
    assert.equal(second.owner, undefined);
    assert.equal(second.heldBy, 'boot-a');
    assert.ok(new Date(second.until) > new Date());
    assert.equal(await renewLease(q, SLUG, 'boot-a'), true);
    assert.equal(await renewLease(q, SLUG, 'boot-b'), false, 'a run that does not hold the lease cannot renew it');
    await releaseLease(q, SLUG, 'boot-a', 'succeeded');
    const [row] = await q(`select last_status, last_finished_at from job_leases where job = $1`, [leaseName(SLUG)]);
    assert.equal(row.last_status, 'succeeded');
    assert.equal((await claimLease(q, SLUG, { owner: 'boot-b' })).owner, 'boot-b');
    await releaseLease(q, SLUG, 'boot-b', 'failed');
  });

  it('a run that died without releasing frees the lease once it expires; the dead run cannot renew it back', async () => {
    assert.equal((await claimLease(q, SLUG, { owner: 'crashed', seconds: 1 })).owner, 'crashed');
    assert.equal((await claimLease(q, SLUG, { owner: 'next' })).owner, undefined);
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal((await claimLease(q, SLUG, { owner: 'next' })).owner, 'next');
    assert.equal(await renewLease(q, SLUG, 'crashed'), false);
    await releaseLease(q, SLUG, 'crashed', 'failed');   // a late release by the dead run changes nothing
    assert.equal((await claimLease(q, SLUG, { owner: 'third' })).owner, undefined);
    await releaseLease(q, SLUG, 'next', 'succeeded');
  });
});
