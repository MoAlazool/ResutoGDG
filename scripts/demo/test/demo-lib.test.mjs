// Unit tests for the pure parts of the demo loader (audits DF-10, DF-11): fixed monthly costs, target safety and the
// deterministic order plan. No database or network:  node --test scripts/demo/test/
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FIXED_COSTS, fixedCostSchedule } from '../lib/fixed-costs.mjs';
import { addDays, planDay, planRange } from '../lib/plan.mjs';
import { decideAction, decideTarget } from '../lib/safety.mjs';

const KINDS = FIXED_COSTS.map((c) => c.kind).sort();

describe('fixed monthly costs (DF-11)', () => {
  // The audit's example: today 2026-10-20, 56 days of history from 2026-08-25.
  const schedule = fixedCostSchedule({ from: '2026-08-25', to: '2026-10-20' });
  const byMonth = Object.groupBy(schedule, (e) => e.month);

  it('books every fixed cost once in every month that overlaps the period, partial months included', () => {
    assert.deepEqual(Object.keys(byMonth), ['2026-08', '2026-09', '2026-10']);
    for (const [month, rows] of Object.entries(byMonth)) assert.deepEqual(rows.map((r) => r.kind).sort(), KINDS, month);
  });

  it('never dates a cost outside the period, so nothing is in the future', () => {
    for (const e of schedule) {
      assert.ok(e.incurredOn >= '2026-08-25' && e.incurredOn <= '2026-10-20', `${e.externalRef} on ${e.incurredOn}`);
    }
    // The old loader kept only payroll on 08-25 for August and dropped October payroll (10-25 is after today).
    assert.equal(byMonth['2026-10'].find((e) => e.kind === 'labor').incurredOn, '2026-10-20');
  });

  it('prorates partial months to the covered days (payroll month to date) and books full months in full', () => {
    const aug = Object.fromEntries(byMonth['2026-08'].map((e) => [e.kind, e]));
    assert.equal(aug.rent.coveredDays, 7);
    assert.equal(aug.rent.amountMinor, Math.round((1_800_000 * 7) / 31 / 100) * 100);
    assert.equal(aug.labor.amountMinor, Math.round((2_400_000 * 7) / 31 / 100) * 100);
    const sep = Object.fromEntries(byMonth['2026-09'].map((e) => [e.kind, e]));
    for (const c of FIXED_COSTS) {
      assert.equal(sep[c.kind].amountMinor, c.amountMinor);
      assert.equal(sep[c.kind].prorated, false);
    }
    const octLabor = byMonth['2026-10'].find((e) => e.kind === 'labor');
    assert.equal(octLabor.coveredDays, 20);
    assert.match(octLabor.description, /month to date: 20 of 31 days/);
  });

  it('gives each entry a stable external reference so a reload upserts instead of duplicating', () => {
    const again = fixedCostSchedule({ from: '2026-08-25', to: '2026-10-20' });
    assert.deepEqual(again.map((e) => e.externalRef), schedule.map((e) => e.externalRef));
    assert.equal(new Set(schedule.map((e) => e.externalRef)).size, schedule.length);
    // A day later the current month's payroll grows; its reference does not change.
    const later = fixedCostSchedule({ from: '2026-08-25', to: '2026-10-21' }).find((e) => e.externalRef === 'demo-fixed:2026-10:labor');
    assert.ok(later.amountMinor > octLabor().amountMinor);
    function octLabor() { return schedule.find((e) => e.externalRef === 'demo-fixed:2026-10:labor'); }
  });

  it('handles a period inside one month and rejects a reversed or malformed period', () => {
    const one = fixedCostSchedule({ from: '2026-10-03', to: '2026-10-09' });
    assert.equal(one.length, FIXED_COSTS.length);
    assert.ok(one.every((e) => e.incurredOn >= '2026-10-03' && e.incurredOn <= '2026-10-09'));
    assert.throws(() => fixedCostSchedule({ from: '2026-10-09', to: '2026-10-03' }), /after/);
    assert.throws(() => fixedCostSchedule({ from: '20261003', to: '2026-10-09' }), /YYYY-MM-DD/);
  });
});

describe('loader target safety (shared staging database)', () => {
  const local = 'postgres://postgres@127.0.0.1:54329/resuto_demo';
  const remote = 'postgres://user@db.example.supabase.co:5432/postgres';

  it('runs a local disposable database in the default mode', () => {
    assert.equal(decideTarget({ env: {}, argv: [], dbUrl: local }).mode, 'disposable');
  });

  it('refuses production, a missing URL and unknown arguments', () => {
    assert.match(decideTarget({ env: { NODE_ENV: 'production' }, argv: ['--demo-tenant-only'], dbUrl: local }).refuse, /production/);
    assert.match(decideTarget({ env: {}, argv: [], dbUrl: undefined }).refuse, /DATABASE_URL/);
    assert.match(decideTarget({ env: {}, argv: ['--reset'], dbUrl: local }).refuse, /unknown argument/);
  });

  it('refuses anything that looks like staging unless --demo-tenant-only is given', () => {
    assert.match(decideTarget({ env: {}, argv: [], dbUrl: remote }).refuse, /DEMO_TARGET=staging/);
    assert.match(decideTarget({ env: { DEMO_TARGET: 'staging' }, argv: [], dbUrl: remote }).refuse, /--demo-tenant-only/);
    assert.match(decideTarget({ env: { NODE_ENV: 'staging' }, argv: [], dbUrl: local }).refuse, /--demo-tenant-only/);
    assert.match(decideTarget({ env: { DEMO_TARGET: 'staging' }, argv: [], dbUrl: local }).refuse, /--demo-tenant-only/);
    const ok = decideTarget({ env: { DEMO_TARGET: 'staging' }, argv: ['--demo-tenant-only'], dbUrl: remote });
    assert.equal(ok.mode, 'demo-tenant-only');
    assert.equal(ok.stagingLike, true);
  });

  it('refuses a database with other organizations unless only the demo tenant is touched', () => {
    const disposable = decideTarget({ env: {}, argv: [], dbUrl: local });
    const shared = decideTarget({ env: { DEMO_TARGET: 'staging' }, argv: ['--demo-tenant-only'], dbUrl: remote });
    assert.match(decideAction({ target: disposable, org: undefined, foreign: 2 }).refuse, /non-demo organization/);
    assert.equal(decideAction({ target: shared, org: undefined, foreign: 2 }).action, 'load');
    assert.equal(decideAction({ target: shared, org: { id: 'x', demo: true, state: 'complete' }, foreign: 2 }).action, 'refresh');
  });

  it('never adopts a non-demo organization that owns the slug, and never resets an interrupted tenant', () => {
    const t = decideTarget({ env: {}, argv: [], dbUrl: local });
    assert.match(decideAction({ target: t, org: { id: 'x', demo: false, state: null }, foreign: 0 }).refuse, /not marked as demo/);
    const r = decideAction({ target: t, org: { id: 'x', demo: true, state: 'started' }, foreign: 0 });
    assert.match(r.refuse, /interrupted/);
    assert.match(r.refuse, /never deletes/);
  });
});

describe('deterministic order plan', () => {
  const menus = { main: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], smash: [{ id: 'x' }, { id: 'y' }] };

  it('plans the same orders for a date whatever the start of the run (so a top-up matches a first load)', () => {
    const full = planRange({ from: '2026-09-01', to: '2026-09-10', historyFrom: '2026-09-01', menus });
    const tail = planRange({ from: '2026-09-06', to: '2026-09-10', historyFrom: '2026-09-01', menus });
    assert.deepEqual(full.filter((o) => o.date >= '2026-09-06'), tail);
    assert.deepEqual(planDay('2026-09-03', { menus, ramp: 0.2 }), planDay('2026-09-03', { menus, ramp: 0.2 }));
  });

  it('only uses dishes of the branch that serves them', () => {
    for (const o of planRange({ from: '2026-09-01', to: addDays('2026-09-01', 20), menus })) {
      for (const l of o.lines) assert.ok(menus[o.branch].some((p) => p.id === l.productId));
    }
  });
});
