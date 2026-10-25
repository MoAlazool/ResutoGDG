import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PERIOD_PRESETS, COMPARES } from '../app/dashboard/[orgId]/_home/model';
import { REPORT_SECTIONS } from './contracts-reports';
import {
  addDays, apiCompare, branchParam, drillDownHref, INSIGHTS_PATHS, insightsHref, insightsRedirects, LEGACY_ANALYTICS_TABS, legacyAnalyticsTarget,
  localToday, periodRange, readView, reportHref, validRange, viewParams,
} from './insights';
import { activeSection, INSIGHTS_SECTIONS } from './sections';

// 21-INSIGHTS: one URL format for an Insights view (section route + period/compare/branch/filters), the drill-down from
// the overview command centre, saved reports and the redirects of the routes that merged.

const NOW = Date.parse('2026-10-25T10:00:00Z');
const TZ = 'Africa/Cairo';
const B = '0f0e0d0c-0b0a-4908-8706-050403020100';
const ORG_DIR = join(__dirname, '..', 'app', 'dashboard', '[orgId]');

describe('Insights views', () => {
  it('every view has a real route, and the SectionNav lists every route', () => {
    for (const path of Object.values(INSIGHTS_PATHS)) expect(existsSync(join(ORG_DIR, path, 'page.tsx')), path).toBe(true);
    expect(INSIGHTS_SECTIONS.map((s) => s.href).sort()).toEqual(Object.values(INSIGHTS_PATHS).sort());
    // The section a route belongs to is the longest prefix (sales, not the overview).
    expect(activeSection(INSIGHTS_SECTIONS, '/analytics/sales')?.href).toBe('/analytics/sales');
    expect(activeSection(INSIGHTS_SECTIONS, '/analytics')?.href).toBe('/analytics');
    expect(activeSection(INSIGHTS_SECTIONS, '/intelligence/forecast')?.href).toBe('/intelligence/forecast');
    // Analytics first, then the intelligence group (one divider).
    const groups = INSIGHTS_SECTIONS.map((s) => s.group ?? 'analytics');
    expect(groups.indexOf('intelligence')).toBe(groups.lastIndexOf('analytics') + 1);
    // Copilot belongs to AI & Apps, the old intelligence customers screen merged into Customers.
    expect(INSIGHTS_SECTIONS.some((s) => s.href === '/intelligence/assistant' || s.href === '/intelligence/customers')).toBe(false);
    expect(existsSync(join(ORG_DIR, 'intelligence', 'customers', 'page.tsx'))).toBe(false);
  });

  it('periods: presets in the restaurant\'s local dates, custom ranges validated (else the last 7 days)', () => {
    expect(localToday(TZ, NOW)).toBe('2026-10-25');
    expect(periodRange('today', TZ, undefined, NOW)).toEqual({ from: '2026-10-25', to: '2026-10-25' });
    expect(periodRange('7d', TZ, undefined, NOW)).toEqual({ from: '2026-10-19', to: '2026-10-25' });
    expect(periodRange('30d', TZ, undefined, NOW)).toEqual({ from: '2026-09-26', to: '2026-10-25' });
    expect(periodRange('90d', TZ, undefined, NOW)).toEqual({ from: addDays('2026-10-25', -89), to: '2026-10-25' });
    expect(periodRange('month', TZ, undefined, NOW)).toEqual({ from: '2026-10-01', to: '2026-10-25' });
    expect(periodRange('lastMonth', TZ, undefined, NOW)).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(periodRange('custom', TZ, { from: '2026-09-01', to: '2026-09-15' }, NOW)).toEqual({ from: '2026-09-01', to: '2026-09-15' });
    expect(periodRange('custom', TZ, { from: '2026-09-15', to: '2026-09-01' }, NOW)).toEqual({ from: '2026-10-19', to: '2026-10-25' });
    expect(validRange('2026-02-29', '2026-03-01')).toBe(false);
    expect(validRange('2025-01-01', '2026-01-01')).toBe(true);
    expect(validRange('2024-01-01', '2026-01-01')).toBe(false);
  });

  it('reads a view from the URL: unknown values fall back, only the section\'s own filters are kept', () => {
    expect(readView('sales', new URLSearchParams())).toEqual({ period: '30d', compare: 'previous_period', filters: {} });
    expect(readView('sales', new URLSearchParams('period=7d&compare=last_year&horizon=7'))).toEqual({ period: '7d', compare: 'last_year', filters: {} });
    expect(readView('forecast', new URLSearchParams('horizon=7'))).toMatchObject({ filters: { horizon: '7' } });
    expect(readView('forecast', new URLSearchParams('horizon=99'))).toMatchObject({ filters: {} });
    expect(readView('sales', new URLSearchParams('period=yesterday&compare=previous'))).toEqual({ period: '30d', compare: 'previous_period', filters: {} });
    expect(readView('sales', new URLSearchParams('period=custom&from=2026-09-01&to=2026-09-07')))
      .toEqual({ period: 'custom', from: '2026-09-01', to: '2026-09-07', compare: 'previous_period', filters: {} });
    expect(readView('sales', new URLSearchParams('period=custom&from=2026-09-07&to=2026-09-01'))).toEqual({ period: 'custom', compare: 'previous_period', filters: {} });
    // Non-savable views still read their period.
    expect(readView('roi', new URLSearchParams('period=7d'))).toMatchObject({ period: '7d', filters: {} });
  });

  it('writes a view back: defaults left out, custom dates only with custom, branch and filters kept', () => {
    expect(viewParams({ period: '30d', compare: 'previous_period' }).toString()).toBe('');
    expect(viewParams({ period: 'custom', from: '2026-09-01', to: '2026-09-07', compare: 'none', filters: { status: 'all' } }, 'all').toString())
      .toBe('period=custom&from=2026-09-01&to=2026-09-07&compare=none&branch=all&status=all');
    expect(viewParams({ period: '7d', from: '2026-09-01', to: '2026-09-07', compare: 'previous_period' }).toString()).toBe('period=7d');
    expect(insightsHref('sales', { period: '7d', compare: 'last_year' })).toBe('/analytics/sales?period=7d&compare=last_year');
    expect(insightsHref('overview', { period: '30d', compare: 'previous_period' })).toBe('/analytics');
    // Round trip.
    const v = { period: 'custom' as const, from: '2026-01-02', to: '2026-01-09', compare: 'last_year' as const, filters: { horizon: '7' } };
    expect(readView('forecast', viewParams(v))).toEqual(v);
  });

  it('a saved report reopens its section with its view and branch (all branches written out)', () => {
    const r = { id: 'r1', section: 'forecast' as const, view: { period: '7d' as const, compare: 'previous_period' as const, filters: { horizon: '7' } }, branchId: B };
    expect(reportHref(r)).toBe(`/intelligence/forecast?period=7d&branch=${B}&horizon=7&report=r1`);
    expect(reportHref({ ...r, section: 'sales', view: { ...r.view, filters: {} }, branchId: null })).toBe('/analytics/sales?period=7d&branch=all&report=r1');
    for (const section of REPORT_SECTIONS) expect(INSIGHTS_PATHS[section]).toBeTruthy();
  });

  it('drill-down from the overview keeps its period, comparison and branch, written out', () => {
    // Every period and comparison the overview offers is an Insights one too.
    for (const p of PERIOD_PRESETS) for (const c of COMPARES) {
      const href = drillDownHref('sales', { preset: p, compare: c, from: '2026-10-01', to: '2026-10-07', branchId: '' });
      const q = new URL(href, 'http://x').searchParams;
      expect(readView('sales', q)).toMatchObject({ period: p, compare: c });
      expect(q.get('branch')).toBe('all');
    }
    expect(drillDownHref('sales', { preset: 'today', compare: 'previous_period', from: '2026-10-25', to: '2026-10-25', branchId: '' }))
      .toBe('/analytics/sales?period=today&compare=previous_period&branch=all');
    expect(drillDownHref('ratings', { preset: 'custom', compare: 'last_year', from: '2026-10-01', to: '2026-10-07', branchId: B }))
      .toBe(`/analytics/ratings?period=custom&from=2026-10-01&to=2026-10-07&compare=last_year&branch=${B}`);
  });

  it('branch links name a branch id or all branches, nothing else', () => {
    expect(branchParam('all')).toBe('all');
    expect(branchParam(B.toUpperCase())).toBe(B);
    expect(branchParam('north')).toBeNull();
    expect(branchParam(null)).toBeNull();
    expect(apiCompare('previous_period')).toBe('previous');
    expect(apiCompare('last_year')).toBe('last_year');
    expect(apiCompare('none')).toBe('none');
  });

  it('old Analytics tabs and the intelligence customers screen keep working (redirects)', () => {
    expect(legacyAnalyticsTarget('?tab=guests')).toBe('/analytics/ratings');
    expect(legacyAnalyticsTarget('tab=products&period=7d')).toBe('/analytics/menu?period=7d');
    expect(legacyAnalyticsTarget('tab=nope')).toBeNull();
    expect(legacyAnalyticsTarget('')).toBeNull();
    const redirects = insightsRedirects();
    expect(redirects).toContainEqual({ source: '/dashboard/:orgId/intelligence/customers', destination: '/dashboard/:orgId/analytics/customers', permanent: false });
    for (const [tab, section] of Object.entries(LEGACY_ANALYTICS_TABS)) {
      expect(redirects).toContainEqual({ source: '/dashboard/:orgId/analytics', has: [{ type: 'query', key: 'tab', value: tab }],
        destination: `/dashboard/:orgId${INSIGHTS_PATHS[section]}`, permanent: false });
    }
    // Every former tab (as the attention list and 21-HOME link them) is covered.
    expect(Object.keys(LEGACY_ANALYTICS_TABS).sort()).toEqual(['customers', 'guests', 'marketing', 'operations', 'products', 'roi', 'sales', 'sustainability']);
  });
});
