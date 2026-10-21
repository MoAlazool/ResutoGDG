// Smash & Co storefront signals (gallery PAR-02). Pure:  node --test scripts/demo/test/*.test.mjs
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { medianPrep, SMASH_BRANCH, SMASH_PREP_MINUTES, smashBranchPatch } from '../lib/storefront-signals.mjs';

describe('Smash & Co storefront signals (PAR-02)', () => {
  it('publishes the legacy hours (11:00 to midnight every day) in Cairo time, and the district in both languages', () => {
    assert.equal(SMASH_BRANCH.openingHours.length, 7);
    assert.deepEqual([...new Set(SMASH_BRANCH.openingHours.map((h) => `${h.opens}-${h.closes}`))], ['11:00-00:00']);
    assert.equal(SMASH_BRANCH.timezone, 'Africa/Cairo');
    assert.equal(SMASH_BRANCH.district, 'Downtown');
    assert.match(SMASH_BRANCH.districtAr, /^[؀-ۿ\s]+$/);
  });

  it('gives the storefront legacy’s “≈ 12 min” pickup estimate', () => {
    assert.equal(medianPrep(Object.values(SMASH_PREP_MINUTES)), 12);
  });

  it('fills only what is missing, so an operator’s own settings survive and a second run changes nothing', () => {
    assert.deepEqual(Object.keys(smashBranchPatch({ district: null, districtAr: null, timezone: null, openingHours: [] })).sort(),
      ['district', 'districtAr', 'openingHours', 'timezone']);
    const own = { district: 'Garden City', districtAr: 'جاردن سيتي', timezone: 'Africa/Cairo', openingHours: [{ day: 1, opens: '12:00', closes: '22:00' }] };
    assert.deepEqual(smashBranchPatch(own), {});
    assert.deepEqual(smashBranchPatch({ ...SMASH_BRANCH }), {});
  });
});
