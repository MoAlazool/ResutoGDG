import { describe, expect, it } from 'vitest';
import { activeFilters, datesValid, filtersFromParams, filtersToParams, NO_FILTERS, paymentsQuery } from './filters';
import { refundTone, statusTone } from './tone';

const params = (q: string) => new URLSearchParams(q);

describe('payments list filters', () => {
  it('reads known filters from the URL and drops anything else', () => {
    expect(filtersFromParams(params('status=refunded&method=cash&mode=test&from=2026-10-01&to=2026-10-25')))
      .toEqual({ status: 'refunded', method: 'cash', mode: 'test', from: '2026-10-01', to: '2026-10-25' });
    expect(filtersFromParams(params('status=hacked&method=bitcoin&mode=sandbox&from=2026-02-30&to=yesterday'))).toEqual(NO_FILTERS);
    expect(filtersFromParams(params(''))).toEqual(NO_FILTERS);
  });

  it('round-trips through the page URL in a stable order, leaving empty values out', () => {
    const f = { ...NO_FILTERS, mode: 'live' as const, status: 'succeeded' };
    expect(filtersToParams(f)).toBe('status=succeeded&mode=live');
    expect(filtersFromParams(params(filtersToParams(f)))).toEqual(f);
    expect(filtersToParams(NO_FILTERS)).toBe('');
  });

  it('builds the API query with the branch, page size and cursor', () => {
    expect(paymentsQuery(NO_FILTERS)).toBe('limit=50');
    expect(paymentsQuery({ status: 'pending', method: 'card', mode: 'test', from: '2026-10-01', to: '2026-10-02' }, { branchId: 'b-1', cursor: 'c-2', limit: 20 }))
      .toBe('limit=20&status=pending&method=card&mode=test&from=2026-10-01&to=2026-10-02&branchId=b-1&cursor=c-2');
    // "All branches" sends no branch.
    expect(paymentsQuery({ ...NO_FILTERS, mode: 'live' }, { branchId: '' })).toBe('limit=50&mode=live');
  });

  it('never sends a reversed date range', () => {
    const reversed = { ...NO_FILTERS, from: '2026-10-25', to: '2026-10-01' };
    expect(datesValid(reversed)).toBe(false);
    expect(paymentsQuery(reversed)).toBe('limit=50');
    expect(datesValid({ from: '2026-10-01', to: '' })).toBe(true);
    expect(datesValid({ from: '2026-10-01', to: '2026-10-01' })).toBe(true);
  });

  it('lists the active filters as chips in display order', () => {
    expect(activeFilters({ status: '', method: 'cash', mode: 'test', from: '', to: '2026-10-25' })).toEqual(['method', 'mode', 'to']);
    expect(activeFilters(NO_FILTERS)).toEqual([]);
  });
});

describe('refund honesty in the timeline', () => {
  it('an unconfirmed outcome is a warning even when the stored status reads succeeded', () => {
    expect(refundTone({ status: 'succeeded', outcomeUncertain: true })).toBe('warn');
    expect(refundTone({ status: 'succeeded' })).toBe('ok');
    expect(refundTone({ status: 'pending' })).toBe('warn');
    expect(refundTone({ status: 'manual_required' })).toBe('warn');
    expect(refundTone({ status: 'failed' })).toBe('danger');
    expect(statusTone('manual_required')).toBe('warn');
  });
});
