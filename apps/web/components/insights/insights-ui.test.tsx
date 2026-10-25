// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { $, $$, click, EASTERN_DIGITS, mount } from '../../../../packages/ui/test/dom';
import { LocaleProvider } from '@/lib/i18n/client';
import { messagesFor } from '@/lib/i18n/messages';
import { OrgProvider, type OrgInfo } from '@/lib/org-context';
import type { SavedReport } from '@/lib/contracts-reports';

// 21-INSIGHTS: the Insights shell (one SectionNav, the period/comparison toolbar in the URL, the branch named by a link
// applied to the shell's switcher) and the saved-report controls, in English and Arabic.

const nav = vi.hoisted(() => ({ search: '', replace: vi.fn(), path: '/dashboard/o1/analytics/sales' }));
/** The URL's query, for useSearchParams and for window.location (the shell edits the live URL). */
const at = (search: string) => { nav.search = search; window.history.replaceState(null, '', `/x${search ? `?${search}` : ''}`); };
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(nav.search), usePathname: () => nav.path, useRouter: () => ({ push() {}, replace: nav.replace }),
}));
// The saved-report controls load as their own chunk; render them in place here.
vi.mock('next/dynamic', () => ({ default: (load: () => Promise<unknown>) => {
  let C: ((p: object) => ReactNode) | null = null;
  void load().then((m) => { C = m as (p: object) => ReactNode; });
  return (p: object) => (C ? <C {...p} /> : null);
} }));
const api = vi.hoisted(() => ({ call: vi.fn(), reports: [] as SavedReport[] }));
vi.mock('@/lib/session', () => ({ useSession: () => ({ call: api.call }) }));
vi.mock('@/lib/use-api', () => ({
  useApi: (path: string | null) => ({ data: path?.includes('/reports') ? { items: api.reports, nextCursor: null } : undefined, error: null, loading: false, reload: async () => {} }),
}));

const { InsightsShell, useInsights } = await import('./InsightsShell');
const { ReportControls } = await import('./ReportControls');

const ORG: OrgInfo = {
  id: 'o1', slug: 'olive', name: 'The Olive Room', nameAr: 'غرفة الزيتون', country: 'EG', currency: 'EGP', timezone: 'Africa/Cairo', role: 'owner', status: 'active',
  branches: [{ id: '0f0e0d0c-0b0a-4908-8706-050403020101', name: 'Zamalek', nameAr: 'الزمالك', code: 'main', isActive: true },
    { id: '0f0e0d0c-0b0a-4908-8706-050403020102', name: 'Maadi', nameAr: 'المعادي', code: 'maadi', isActive: true }],
};
const [ZAMALEK, MAADI] = ORG.branches.map((b) => b.id) as [string, string];
let shell: { branchId: string; all: boolean; set: ReturnType<typeof vi.fn> };
const render = (locale: 'en' | 'ar', node: ReactNode) => mount(
  <LocaleProvider locale={locale} messages={{ ...messagesFor(locale, 'guest'), ...messagesFor(locale, 'staff') }}>
    <OrgProvider value={{ org: ORG, modules: null, reload: async () => {}, branchId: shell.branchId, allBranches: shell.all, setBranchId: shell.set, registerAllBranches: () => () => {} }}>
      {node}
    </OrgProvider>
  </LocaleProvider>, locale);

function Probe() {
  const v = useInsights();
  return <output data-probe={JSON.stringify({ period: v.period, compare: v.compare, branchId: v.branchId, view: v.view })} />;
}
const probe = (host: HTMLElement) => JSON.parse($(host, 'output').getAttribute('data-probe')!);

beforeEach(() => {
  at(''); nav.path = '/dashboard/o1/analytics/sales'; nav.replace.mockReset(); api.call.mockReset(); api.reports = [];
  shell = { branchId: ZAMALEK, all: true, set: vi.fn() };
});
afterEach(() => { document.body.innerHTML = ''; });

describe('Insights shell', () => {
  it('one SectionNav for analytics and intelligence; its links keep the period and comparison', async () => {
    at('period=7d&compare=last_year');
    const v = render('en', <InsightsShell section="sales"><Probe /></InsightsShell>);
    await act(async () => {});
    const links = $$(v.host, 'nav.section-nav a');
    expect(links.map((a) => a.textContent)).toEqual(['Overview', 'Sales', 'Menu performance', 'Customers', 'Ratings', 'Marketing', 'Operations',
      'Sustainability', 'ROI calculator', 'Findings', 'Forecast', 'Recommendations', 'Research', 'Routes']);
    expect(links[1]!.getAttribute('aria-current')).toBe('page');
    expect(links[2]!.getAttribute('href')).toBe('/dashboard/o1/analytics/menu?period=7d&compare=last_year');
    // The intelligence group starts with a divider.
    expect($$(v.host, 'nav.section-nav li[data-group-start]').map((li) => li.textContent)).toEqual(['Findings']);
    expect($<HTMLSelectElement>(v.host, 'select').value).toBe('7d');
    expect($(v.host, '[role="radio"][aria-checked="true"]').textContent).toBe('Same period last year');
    expect(probe(v.host)).toMatchObject({ compare: 'last_year', period: { preset: '7d' }, branchId: '' });
    v.unmount();
  });

  it('changing the period or comparison rewrites the URL (defaults left out)', async () => {
    at('period=7d');
    const v = render('en', <InsightsShell section="sales"><Probe /></InsightsShell>);
    await act(async () => {});
    const select = $<HTMLSelectElement>(v.host, 'select');
    act(() => { select.value = '30d'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(nav.replace).toHaveBeenLastCalledWith('/dashboard/o1/analytics/sales', { scroll: false });
    click($$(v.host, '[role="radio"]').find((r) => r.textContent === 'No comparison')!);
    expect(nav.replace).toHaveBeenLastCalledWith('/dashboard/o1/analytics/sales?period=7d&compare=none', { scroll: false });
    v.unmount();
  });

  it('a link\'s branch selects that branch in the shell once, then leaves the URL', async () => {
    at(`period=today&branch=${MAADI}`);
    let v = render('en', <InsightsShell section="sales"><Probe /></InsightsShell>);
    await act(async () => {});
    expect(shell.set).toHaveBeenCalledWith(MAADI);
    expect(nav.replace).toHaveBeenCalledWith('/dashboard/o1/analytics/sales?period=today', { scroll: false });
    v.unmount();
    // "All branches" on an analytics view; a branch that does not exist is ignored (and still removed from the URL).
    shell = { branchId: ZAMALEK, all: false, set: vi.fn() };
    at('branch=all');
    v = render('en', <InsightsShell section="sales"><Probe /></InsightsShell>);
    await act(async () => {});
    expect(shell.set).toHaveBeenCalledWith(null);
    v.unmount();
    shell = { branchId: ZAMALEK, all: false, set: vi.fn() };
    at('branch=0f0e0d0c-0b0a-4908-8706-0504030201ff');
    v = render('en', <InsightsShell section="sales"><Probe /></InsightsShell>);
    await act(async () => {});
    expect(shell.set).not.toHaveBeenCalled();
    expect(nav.replace).toHaveBeenCalled();
    v.unmount();
  });

  it('intelligence views work on one branch and have no period toolbar; Arabic, Western digits', async () => {
    nav.path = '/dashboard/o1/intelligence/forecast';
    at('horizon=7');
    const v = render('ar', <InsightsShell section="forecast"><Probe /></InsightsShell>);
    await act(async () => {});
    expect(probe(v.host)).toMatchObject({ branchId: ZAMALEK, view: { filters: { horizon: '7' } } });
    expect(v.host.querySelector('select')).toBeNull();
    expect($(v.host, 'nav.section-nav a[aria-current="page"]').textContent).toBe('التوقعات');
    expect(v.host.textContent).not.toMatch(EASTERN_DIGITS);
    v.unmount();
  });
});

describe('saved-report controls', () => {
  const view = { period: '7d' as const, compare: 'last_year' as const, filters: {} };
  const report = (over: Partial<SavedReport>): SavedReport => ({ id: 'r1', name: 'Weekend sales', section: 'sales', view, branchId: null, shared: false, mine: true,
    authorName: null, createdAt: '2026-10-25T10:00:00Z', updatedAt: '2026-10-25T10:00:00Z', ...over });

  it('lists own and shared reports, each opening its view; marks the open one', () => {
    at('report=r2');
    api.reports = [report({}), report({ id: 'r2', name: 'Team forecast', section: 'forecast', view: { ...view, filters: { horizon: '7' } }, branchId: MAADI, mine: false, shared: true, authorName: 'Mona' })];
    const v = render('en', <ReportControls section="sales" view={view} branchId="" />);
    click($$(v.host, 'button').find((b) => b.textContent?.startsWith('Saved reports'))!);
    const links = $$(v.host, '.rui-pop-panel a');
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/dashboard/o1/analytics/sales?period=7d&compare=last_year&branch=all&report=r1',
      `/dashboard/o1/intelligence/forecast?period=7d&compare=last_year&branch=${MAADI}&horizon=7&report=r2`,
      '/dashboard/o1/analytics#saved-reports',
    ]);
    expect(links[1]!.getAttribute('aria-current')).toBe('page');
    expect(links[1]!.textContent).toContain('Mona');
    expect(v.host.textContent).toContain('Team forecast');
    v.unmount();
  });

  it('saves the current view under a name, private unless shared, for the shell\'s branch', async () => {
    api.call.mockResolvedValue(report({ id: 'new' }));
    const v = render('en', <ReportControls section="sales" view={view} branchId={MAADI} />);
    click($$(v.host, 'button').find((b) => b.textContent === 'Save view')!);
    const name = $<HTMLInputElement>(v.host, '.rui-pop-panel input.input');
    expect(name.value).toBe('Sales · Last 7 days');
    click($(v.host, '.rui-pop-panel input[role="switch"]'));
    await act(async () => { $(v.host, '.rui-pop-panel form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(api.call).toHaveBeenCalledWith('/o/o1/reports', { body: { name: 'Sales · Last 7 days', section: 'sales', view, branchId: MAADI, shared: true } });
    expect(nav.replace).toHaveBeenCalledWith('/dashboard/o1/analytics/sales?report=new', { scroll: false });
    v.unmount();
  });

  it('says so when nothing is saved yet (Arabic)', () => {
    const v = render('ar', <ReportControls section="sales" view={view} branchId="" />);
    click($$(v.host, 'button').find((b) => b.textContent?.startsWith('التقارير المحفوظة'))!);
    expect(v.host.textContent).toContain('لا توجد تقارير محفوظة بعد');
    expect(v.host.textContent).not.toMatch(EASTERN_DIGITS);
    v.unmount();
  });
});
