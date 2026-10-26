// The busy inbox fixture (scripts/demo/seed-busy-inbox.mjs) is local only and deterministic. Pure checks, no database.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { refuseTarget, rng } from '../seed-busy-inbox.mjs';

describe('busy inbox fixture target', () => {
  it('runs only against a local database, never in production or staging', () => {
    assert.equal(refuseTarget({}, 'postgres://postgres@127.0.0.1:54329/resuto'), null);
    assert.equal(refuseTarget({}, 'postgres://postgres@localhost/resuto'), null);
    assert.match(refuseTarget({ NODE_ENV: 'production' }, 'postgres://postgres@127.0.0.1/resuto'), /production/);
    assert.match(refuseTarget({ DEMO_TARGET: 'staging' }, 'postgres://postgres@127.0.0.1/resuto'), /local only/);
    assert.match(refuseTarget({ NODE_ENV: 'staging' }, 'postgres://postgres@127.0.0.1/resuto'), /local only/);
    assert.match(refuseTarget({}, 'postgres://u@db.example.supabase.co:5432/postgres'), /non-local/);
    assert.match(refuseTarget({}, undefined), /required/);
    assert.match(refuseTarget({}, 'not a url'), /valid URL/);
  });

  it('builds the same inbox on every run (seeded random numbers)', () => {
    const a = rng(2210), b = rng(2210);
    const xs = Array.from({ length: 5 }, () => a());
    assert.deepEqual(xs, Array.from({ length: 5 }, () => b()));
    assert.ok(xs.every((x) => x >= 0 && x < 1));
  });
});
