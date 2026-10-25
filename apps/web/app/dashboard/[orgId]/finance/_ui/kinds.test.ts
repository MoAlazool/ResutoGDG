import { describe, expect, it } from 'vitest';
import * as contracts from '../../../../../../../packages/contracts/src/finance';
import { EXPENSE_KINDS, EXPORT_KINDS } from './kinds';

describe('finance option lists', () => {
  it('match the contracts exactly (same values, same order)', () => {
    expect([...EXPORT_KINDS]).toEqual([...contracts.EXPORT_KINDS]);
    expect([...EXPENSE_KINDS]).toEqual([...contracts.EXPENSE_KINDS]);
  });
});
