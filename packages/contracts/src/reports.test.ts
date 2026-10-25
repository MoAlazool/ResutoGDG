import { describe, expect, it } from 'vitest';
import { analyticsPeriodQuery } from './analytics';
import { OVERVIEW_COMPARE } from './home-sections';
import {
  REPORT_COMPARE, REPORT_FILTER_KEYS, REPORT_PERIODS, REPORT_SECTIONS, reportViewInput, savedReportInput, savedReportListQuery, savedReportUpdate,
  unknownReportFilters, validReportFilter,
} from './reports';

const view = { period: '7d', compare: 'last_year' } as const;

describe('saved report contracts (21-INSIGHTS)', () => {
  it('uses the overview command centre\'s comparisons and a superset of its periods, so a drill-down keeps both', () => {
    expect([...REPORT_COMPARE]).toEqual([...OVERVIEW_COMPARE]);
    for (const p of ['today', '7d', '30d', 'custom']) expect(REPORT_PERIODS).toContain(p);
  });

  it('accepts a view with defaults and normalises it', () => {
    expect(reportViewInput.parse({ period: '30d' })).toEqual({ period: '30d', compare: 'previous_period', filters: {} });
    expect(reportViewInput.parse({ period: 'custom', from: '2026-09-01', to: '2026-09-30', compare: 'none' }))
      .toEqual({ period: 'custom', from: '2026-09-01', to: '2026-09-30', compare: 'none', filters: {} });
  });

  it('refuses inconsistent periods: dates without custom, custom without dates, reversed or longer than 400 days', () => {
    for (const bad of [
      { period: '7d', from: '2026-09-01', to: '2026-09-07' },
      { period: 'custom', from: '2026-09-01' },
      { period: 'custom', from: '2026-09-07', to: '2026-09-01' },
      { period: 'custom', from: '2025-01-01', to: '2026-09-01' },
      { period: 'custom', from: '2026-02-30', to: '2026-03-01' },
      { period: 'yesterday' },
      { period: '7d', compare: 'previous' },
      { period: '7d', extra: true },
    ]) expect(reportViewInput.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it('keeps only the filters a section offers, with valid values', () => {
    expect(validReportFilter('forecast', 'horizon', '14')).toBe(true);
    expect(validReportFilter('forecast', 'horizon', '30')).toBe(false);
    expect(validReportFilter('findings', 'status', 'dismissed')).toBe(true);
    expect(validReportFilter('sustainability', 'gramsPerSheet', '4.5')).toBe(true);
    expect(validReportFilter('sustainability', 'gramsPerSheet', '0')).toBe(false);
    expect(validReportFilter('sustainability', 'gramsPerSheet', '101')).toBe(false);
    expect(validReportFilter('sales', 'horizon', '14')).toBe(false);
    // Inherited object keys are never filters.
    expect(validReportFilter('sales', 'toString', 'x')).toBe(false);
    expect(validReportFilter('sales', '__proto__', 'x')).toBe(false);
    expect(unknownReportFilters('forecast', { horizon: '7', branch: 'x' })).toEqual(['branch']);
    expect(REPORT_FILTER_KEYS.forecast).toEqual(['horizon']);
    expect(REPORT_FILTER_KEYS.sales).toEqual([]);
  });

  it('validates a report: name, known section, the section\'s own filters, private by default', () => {
    const ok = savedReportInput.parse({ name: '  Weekend sales  ', section: 'sales', view });
    expect(ok).toMatchObject({ name: 'Weekend sales', section: 'sales', view: { ...view, filters: {} } });
    expect(ok.shared).toBeUndefined();
    expect(savedReportInput.parse({ name: 'F', section: 'forecast', view: { period: '30d', filters: { horizon: '7' } }, shared: true, branchId: null }).shared).toBe(true);
    for (const bad of [
      { name: '', section: 'sales', view },
      { name: 'x'.repeat(81), section: 'sales', view },
      { name: 'R', section: 'roi', view },
      { name: 'R', section: 'sales', view: { period: '7d', filters: { horizon: '7' } } },
      { name: 'R', section: 'forecast', view: { period: '7d', filters: { horizon: '30' } } },
      { name: 'R', section: 'sales', view, branchId: 'not-a-uuid' },
      { name: 'R', section: 'sales', view, owner: 'someone' },
    ]) expect(savedReportInput.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    expect(REPORT_SECTIONS).not.toContain('roi');
  });

  it('updates need at least one field; lists default to every visible report', () => {
    expect(savedReportUpdate.safeParse({}).success).toBe(false);
    expect(savedReportUpdate.safeParse({ section: 'menu' }).success).toBe(false);
    expect(savedReportUpdate.parse({ shared: false })).toEqual({ shared: false });
    expect(savedReportListQuery.parse({})).toEqual({ limit: 100, owner: 'all' });
    expect(savedReportListQuery.safeParse({ limit: 500 }).success).toBe(false);
  });

  it('the sales summary accepts the last-year comparison (drill-down from the overview)', () => {
    expect(analyticsPeriodQuery.parse({ from: '2026-09-01', to: '2026-09-07', compare: 'last_year' }).compare).toBe('last_year');
    expect(analyticsPeriodQuery.parse({ from: '2026-09-01', to: '2026-09-07' }).compare).toBe('previous');
  });
});
