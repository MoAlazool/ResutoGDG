import { describe, expect, it } from 'vitest';
import { addDays, addMonths, alignDays, compareRange, deltaPct, fillDays, isDate, periodDays, presetOf, presetRange, validPeriod } from './period';
import { feesProvenance, profitProvenance, revenueProvenance } from './provenance';

describe('finance period presets', () => {
  const today = '2026-10-25';
  it('ends today and starts where the preset says', () => {
    expect(presetRange('mtd', today)).toEqual({ from: '2026-10-01', to: today });
    expect(presetRange('last_month', today)).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(presetRange('last_30', today)).toEqual({ from: '2026-09-26', to: today });
    expect(presetRange('qtd', today)).toEqual({ from: '2026-10-01', to: today });
    expect(presetRange('qtd', '2026-08-15')).toEqual({ from: '2026-07-01', to: '2026-08-15' });
    expect(presetRange('ytd', today)).toEqual({ from: '2026-01-01', to: today });
    expect(presetRange('last_month', '2026-01-10')).toEqual({ from: '2025-12-01', to: '2025-12-31' });
    expect(periodDays(presetRange('last_30', today))).toBe(30);
  });

  it('recognises the preset of a range, otherwise custom', () => {
    expect(presetOf({ from: '2026-10-01', to: today }, today)).toBe('mtd');
    expect(presetOf({ from: '2026-09-01', to: '2026-09-30' }, today)).toBe('last_month');
    expect(presetOf({ from: '2026-10-03', to: '2026-10-09' }, today)).toBe('custom');
  });

  it('validates real dates, order and the one-year limit of the API', () => {
    expect(isDate('2026-02-28')).toBe(true);
    expect(isDate('2026-02-30')).toBe(false);
    expect(isDate('2026-2-3')).toBe(false);
    expect(validPeriod({ from: '2026-10-01', to: '2026-10-25' })).toBe(true);
    expect(validPeriod({ from: '2026-10-25', to: '2026-10-01' })).toBe(false);
    expect(validPeriod({ from: '2025-01-01', to: '2026-01-01' })).toBe(true); // 366 days
    expect(validPeriod({ from: '2025-01-01', to: '2026-01-02' })).toBe(false);
    expect(validPeriod({ from: '', to: '2026-01-02' })).toBe(false);
  });
});

describe('finance period comparison', () => {
  it('month to date compares with the same days of the previous month (clamped to its end)', () => {
    expect(compareRange({ from: '2026-10-01', to: '2026-10-25' }, 'previous_period')).toEqual({ from: '2026-09-01', to: '2026-09-25' });
    expect(compareRange({ from: '2026-03-01', to: '2026-03-31' }, 'previous_period')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(compareRange({ from: '2026-03-01', to: '2026-03-30' }, 'previous_period')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
  });

  it('whole months and quarters compare with the same number of months before', () => {
    expect(compareRange({ from: '2026-09-01', to: '2026-09-30' }, 'previous_period')).toEqual({ from: '2026-08-01', to: '2026-08-31' });
    expect(compareRange({ from: '2026-07-01', to: '2026-09-30' }, 'previous_period')).toEqual({ from: '2026-04-01', to: '2026-06-30' });
    expect(compareRange({ from: '2026-01-01', to: '2026-01-31' }, 'previous_period')).toEqual({ from: '2025-12-01', to: '2025-12-31' });
    // Quarter to date: the same days of the previous quarter.
    expect(compareRange({ from: '2026-07-01', to: '2026-08-15' }, 'previous_period')).toEqual({ from: '2026-04-01', to: '2026-05-15' });
  });

  it('any other range compares with the same number of days just before it', () => {
    expect(compareRange({ from: '2026-09-26', to: '2026-10-25' }, 'previous_period')).toEqual({ from: '2026-08-27', to: '2026-09-25' });
    expect(compareRange({ from: '2026-10-25', to: '2026-10-25' }, 'previous_period')).toEqual({ from: '2026-10-24', to: '2026-10-24' });
    const r = { from: '2026-10-03', to: '2026-10-09' };
    expect(periodDays(compareRange(r, 'previous_period')!)).toBe(periodDays(r));
  });

  it('last year shifts both dates a year back; 29 February becomes 28 February', () => {
    expect(compareRange({ from: '2026-10-01', to: '2026-10-25' }, 'last_year')).toEqual({ from: '2025-10-01', to: '2025-10-25' });
    expect(compareRange({ from: '2028-02-01', to: '2028-02-29' }, 'last_year')).toEqual({ from: '2027-02-01', to: '2027-02-28' });
  });

  it('no comparison, or an invalid period, gives none', () => {
    expect(compareRange({ from: '2026-10-01', to: '2026-10-25' }, 'none')).toBeNull();
    expect(compareRange({ from: '2026-10-25', to: '2026-10-01' }, 'previous_period')).toBeNull();
  });

  it('change in percent is null without a base and rounded to 0.1', () => {
    expect(deltaPct(1200, 1000)).toBe(20);
    expect(deltaPct(900, 1000)).toBe(-10);
    expect(deltaPct(1, 3)).toBe(-66.7);
    expect(deltaPct(500, 0)).toBeNull();
    expect(deltaPct(500, null)).toBeNull();
    expect(deltaPct(undefined, 10)).toBeNull();
    expect(deltaPct(-50, -100)).toBe(50);
  });

  it('aligns the comparison days with the current days and fills missing days with 0', () => {
    const cur = { from: '2026-10-01', to: '2026-10-03' };
    const prev = { from: '2026-09-01', to: '2026-09-02' };
    expect(alignDays(cur, prev, [{ date: '2026-09-02', value: 7 }])).toEqual([0, 7, 0]);
    expect(fillDays(cur, [{ date: '2026-10-02', value: 5 }])).toEqual([{ date: '2026-10-01', value: 0 }, { date: '2026-10-02', value: 5 }, { date: '2026-10-03', value: 0 }]);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-01-15', -13)).toBe('2024-12-15');
  });
});

describe('finance provenance', () => {
  const pnl = (over: Partial<{ isSyntheticData: boolean; linesWithoutCost: number; unknownFee: number; cogs: 'item_cost' | 'purchases'; source: 'saved' | 'default' | 'derived' }> = {}) => ({
    isSyntheticData: over.isSyntheticData ?? false,
    coverage: { linesWithoutCost: over.linesWithoutCost ?? 0, salesWithoutCostMinor: 0, unpaidOrders: 0, paymentsWithUnknownFee: over.unknownFee ?? 0, testPayments: 0, costedSalesBp: null },
    policy: { cogsMethod: over.cogs ?? 'item_cost', feesMethod: 'provider_reports' as const, updatedAt: null, source: over.source ?? 'saved' },
  });
  it('recorded totals are from the ledger; demo history is sandbox; missing data is unavailable', () => {
    expect(revenueProvenance(true)).toBe('live');
    expect(revenueProvenance(true, true)).toBe('sandbox');
    expect(revenueProvenance(false)).toBe('unavailable');
  });
  it('profit is estimated when costs or fees are incomplete or the policy is derived', () => {
    expect(profitProvenance(pnl())).toBe('live');
    expect(profitProvenance(pnl({ linesWithoutCost: 2 }))).toBe('estimated');
    expect(profitProvenance(pnl({ linesWithoutCost: 2, cogs: 'purchases' }))).toBe('live');
    expect(profitProvenance(pnl({ source: 'derived' }))).toBe('estimated');
    expect(profitProvenance(pnl({ unknownFee: 1 }))).toBe('estimated');
    expect(profitProvenance(pnl({ isSyntheticData: true }))).toBe('sandbox');
    expect(profitProvenance(null)).toBe('unavailable');
  });
  it('fees are estimated while provider payments have no fee yet', () => {
    expect(feesProvenance({ paymentsWithUnknownFee: 0 })).toBe('live');
    expect(feesProvenance({ paymentsWithUnknownFee: 3 })).toBe('estimated');
    expect(feesProvenance(undefined)).toBe('unavailable');
  });
});
