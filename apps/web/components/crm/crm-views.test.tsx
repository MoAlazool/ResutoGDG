// @vitest-environment jsdom
import type { FunnelReport, RetentionReport } from '@resuto/contracts';
import type { ReactNode } from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { $, $$, click, EASTERN_DIGITS, mount } from '../../../../packages/ui/test/dom';
import { LocaleProvider } from '@/lib/i18n/client';
import { messagesFor } from '@/lib/i18n/messages';
import { OrgProvider, type OrgInfo } from '@/lib/org-context';
import { cohortLevel as level } from '@resuto/ui';
import { FunnelPanel, RetentionPanel } from './FunnelPanels';
import { SegmentsView } from './SegmentBuilder';

// 21-CRM views: the funnel labels every step with its source and completeness, the retention view draws the cohort
// grid and the repeat curve with the chart kit, the segment builder counts and saves through the rule engine's API.
// EN/AR with Western digits.

const data = vi.hoisted(() => ({ byPath: new Map<string, unknown>(), calls: [] as Array<{ path: string; body: unknown }> }));
vi.mock('@/lib/use-api', () => ({
  useApi: (path: string | null) => {
    const key = path ? [...data.byPath.keys()].find((k) => path.includes(k)) : undefined;
    const value = key ? data.byPath.get(key) : undefined;
    return { data: value, error: null, loading: !!path && !value, refreshing: false, pending: false, updatedAt: 1, reload: async () => {}, setData() {} };
  },
}));
// One session object, as the app's provider keeps it stable across renders.
const session = vi.hoisted(() => ({
  call: async (path: string, opts?: { body?: unknown }) => {
    data.calls.push({ path, body: opts?.body });
    if (path.endsWith('/segments/preview')) return { count: 12, consentedCount: 5 };
    if (path.endsWith('/segments')) return { id: 's9', name: (opts?.body as { name: string }).name, memberCount: 12 };
    return {};
  },
}));
vi.mock('@/lib/session', () => ({ useSession: () => session }));

const org: OrgInfo = {
  id: 'o1', slug: 'olive', name: 'The Olive Room', nameAr: 'غرفة الزيتون', country: 'EG', currency: 'EGP', timezone: 'Africa/Cairo', role: 'owner', status: 'active',
  branches: [{ id: '0b5a3c7e-1f2d-4c3b-9a8e-7d6c5b4a3f21', name: 'Zamalek', nameAr: 'الزمالك', code: 'main', isActive: true }],
};
const wrap = (locale: 'en' | 'ar', node: ReactNode, modules: Record<string, boolean> | null = null) => (
  <LocaleProvider locale={locale} messages={{ ...messagesFor(locale, 'guest'), ...messagesFor(locale, 'staff') }}>
    <OrgProvider value={{ org, modules: modules as never, reload: async () => {} }}>{node}</OrgProvider>
  </LocaleProvider>
);
const meta = { method: 'm', assumptions: [], dataCoverage: {}, kind: 'mixed' as const, timezone: 'Africa/Cairo', generatedAt: '2026-10-25T10:00:00Z' };
const step = (key: string, value: number | null, completeness: string, unit = 'sessions', notes: string[] = ['not_same_people']) =>
  ({ key, value, unit, source: `source of ${key}`, completeness, notes, measured: value }) as FunnelReport['steps'][number];
const funnel: FunnelReport = {
  from: '2026-08-01', to: '2026-08-31', branchId: null, beaconsSince: '2026-07-01T10:00:00.000Z',
  steps: [{ ...step('visits', 1600, 'estimate', 'sessions', ['sampled', 'needs_script', 'not_same_people']), measured: 400 }, step('qr_scans', 320, 'partial'),
    step('messages', null, 'unavailable', 'conversations', ['connect_not_entitled', 'not_same_people']), step('leads', 90, 'complete', 'customers'),
    step('orders', 240, 'complete', 'orders'), step('repeat', 40, 'complete', 'customers')],
  cart: [step('add_to_cart', 150, 'partial'), step('checkout_started', 80, 'partial')],
  meta,
};
const retention: RetentionReport = {
  from: '2026-08-01', to: '2026-10-31', branchId: null,
  cohorts: [{ cohort: '2026-08', size: 20, active: [20, 8, 4], retentionPct: [100, 40, 20] }, { cohort: '2026-09', size: 10, active: [10, 3], retentionPct: [100, 30] }],
  repeatCurve: { asOf: '2026-10-25', newCustomers: 30, points: Array.from({ length: 91 }, (_, day) => ({ day, eligible: day < 60 ? 30 : 0, repeated: Math.min(15, day), pct: day < 60 ? Math.round((Math.min(15, day) / 30) * 10000) / 100 : null })) },
  meta,
};
const period = { from: '2026-08-01', to: '2026-08-31', preset: 'custom' };
/** Runs the debounce, then lets the preview request's promise chain settle. */
async function settle() {
  await act(async () => { vi.advanceTimersByTime(400); });
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  data.byPath = new Map<string, unknown>([['/analytics/funnel', funnel], ['/analytics/retention', retention], ['/marketing/segments', { items: [
    { id: 's1', name: 'Lapsed regulars', description: null, memberCount: 31, source: 'manual', lastComputedAt: '2026-10-20T10:00:00Z' }] }]]);
  data.calls = [];
});
afterEach(() => { document.body.innerHTML = ''; vi.useRealTimers(); });

describe('funnel view', () => {
  it('shows every step with its source and completeness, and leaves unmeasured steps out of the chart', () => {
    const v = mount(wrap('en', <FunnelPanel period={period} branchId="" />));
    const chart = $$(v.host, '.rui-funnel-step').map((li) => li.textContent);
    expect(chart).toHaveLength(5);
    expect(chart[0]).toContain('Visits');
    expect(chart.join(' ')).not.toContain('Messages');
    const rows = $$(v.host, 'table tbody tr');
    expect(rows).toHaveLength(6);
    const visits = rows[0]!.textContent!;
    expect(visits).toContain('source of visits');
    expect(visits).toContain('Estimate');
    expect(visits).toContain('400 sampled sessions');
    expect(visits).toContain('One in four guest sessions');
    expect(rows[2]!.textContent).toContain('Not measured');
    expect(rows[2]!.textContent).toContain('—');
    expect(rows[1]!.querySelector('[data-completeness="partial"]')).not.toBeNull();
    // A rate above 100 % (orders > leads) is not shown.
    expect(v.host.textContent).not.toMatch(/2\d\d(\.\d)?%/);
    expect(v.host.textContent).toContain('counted since');
    expect(v.host.textContent).toContain('Added to cart');
    v.unmount();
  });

  it('is localised in Arabic with Western digits', () => {
    const v = mount(wrap('ar', <FunnelPanel period={period} branchId="" />), 'ar');
    expect(v.host.textContent).toContain('الزيارات');
    expect(v.host.textContent).toContain('تقدير');
    expect(v.host.textContent).toContain('1,600');
    expect(v.host.textContent).not.toMatch(EASTERN_DIGITS);
    v.unmount();
  });
});

describe('retention view', () => {
  it('draws the cohort grid on the sequential scale and the repeat-purchase curve', () => {
    const v = mount(wrap('en', <RetentionPanel period={period} branchId="" />));
    const cells = $$(v.host, '.rui-cohort-cell');
    expect(cells.map((c) => c.getAttribute('data-level'))).toEqual(['10', '4', '2', '10', '3', 'none']);
    expect(cells[1]!.getAttribute('title')).toBe('2026-08, month 1: 40% (8 of 20)');
    expect($(v.host, '.rui-cohort-table caption').textContent).toContain('first counted order');
    // The chart kit's line chart, with its table fallback; only days every counted customer has had.
    expect(v.host.querySelector('.rui-chart svg')).not.toBeNull();
    expect(v.host.textContent).toContain('30 new customers');
    v.unmount();
    expect([level(null), level(0), level(1), level(10), level(10.1), level(100)]).toEqual([0, 0, 1, 1, 2, 10]);
  });

  it('reads in Arabic with Western digits', () => {
    const v = mount(wrap('ar', <RetentionPanel period={period} branchId="" />), 'ar');
    expect(v.host.textContent).toContain('الاحتفاظ حسب شهر أول طلب');
    expect(v.host.textContent).not.toMatch(EASTERN_DIGITS);
    v.unmount();
  });
});

describe('segment builder', () => {
  it('counts matching customers, builds nested groups and saves through the segments API', async () => {
    vi.useFakeTimers();
    const v = mount(wrap('en', <SegmentsView />));
    await settle();
    expect(data.calls.at(-1)).toEqual({ path: '/o/o1/marketing/segments/preview',
      body: { definition: { op: 'and', rules: [{ type: 'consent', value: true }, { type: 'inactive_days_gte', days: 30 }] } } });
    expect($(v.host, '[data-testid="segment-count"]').textContent).toContain('12 customers match · 5 can receive marketing');
    // A nested "any of" group with a branch rule.
    click($$(v.host, 'button').find((b) => b.textContent === 'Add a group')!);
    expect($$(v.host, 'fieldset.crm-seg-group')).toHaveLength(2);
    await settle();
    const def = (data.calls.at(-1)!.body as { definition: { rules: unknown[] } }).definition;
    expect(def.rules[2]).toEqual({ op: 'or', rules: [{ type: 'branch', branchId: org.branches[0]!.id }] });
    // Save.
    const name = $(v.host, 'form input') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => { setter.call(name, 'Lapsed, main branch'); name.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { ($(v.host, 'form') as HTMLFormElement).requestSubmit(); });
    for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
    const saved = data.calls.find((c) => c.path === '/o/o1/marketing/segments');
    expect(saved?.body).toMatchObject({ name: 'Lapsed, main branch', description: null, definition: { op: 'and' } });
    expect(v.host.textContent).toContain('Saved “Lapsed, main branch” with 12 customers.');
    // The saved list.
    expect(v.host.textContent).toContain('Lapsed regulars');
    expect(v.host.textContent).toContain('31 customers');
    v.unmount();
  });

  it('does not count or save while a rule is incomplete', async () => {
    vi.useFakeTimers();
    const v = mount(wrap('en', <SegmentsView />));
    const select = $(v.host, '.crm-seg-rule select') as HTMLSelectElement;
    act(() => { select.value = 'has_tag'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    data.calls = [];
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(data.calls).toEqual([]);
    expect($(v.host, '.crm-seg-rule[data-invalid]')).not.toBeNull();
    expect(($$(v.host, 'button').find((b) => b.textContent === 'Save segment') as HTMLButtonElement).disabled).toBe(true);
    v.unmount();
  });

  it('shows the plan preview instead of the builder without the Marketing module, in Arabic too', () => {
    const v = mount(wrap('ar', <SegmentsView />, { marketing: false }), 'ar');
    expect(v.host.textContent).toContain('الشرائح جزء من التسويق');
    expect(v.host.querySelector('fieldset')).toBeNull();
    expect(v.host.textContent).not.toMatch(EASTERN_DIGITS);
    v.unmount();
  });
});
