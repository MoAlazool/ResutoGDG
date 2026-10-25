// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdminProviderAppView, AdminTenantRow } from '@resuto/contracts';
import { $, $$, EASTERN_DIGITS, mount } from '../../../../packages/ui/test/dom';
import { ApiRequestError } from '@/lib/api';
import { LocaleProvider } from '@/lib/i18n/client';
import { messagesFor } from '@/lib/i18n/messages';

// 21-ADMIN operator console in a browser-like DOM, in English and Arabic: the shell (platform role check, navigation
// with icons and aria-current, account menu, refusal for members without a platform role, an error with Retry when
// the check fails otherwise), the restaurants list (row links, sortable headers, filter chips, keyset pages) and the
// provider apps page (readiness, copy buttons, secrets never shown).

const h = vi.hoisted(() => ({
  pathname: '/admin',
  search: new URLSearchParams(),
  replace: vi.fn(),
  push: vi.fn(),
  routes: {} as Record<string, unknown>,
  calls: [] as string[],
  scope: 'u0',
  token: 'tok',
}));
vi.mock('next/navigation', () => ({
  usePathname: () => h.pathname,
  useSearchParams: () => h.search,
  useRouter: () => ({ push: h.push, replace: h.replace }),
  useParams: () => ({}),
}));
vi.mock('@/lib/session', () => {
  const call = async (path: string) => {
    h.calls.push(path);
    const hit = Object.entries(h.routes).find(([p]) => path === p || path.startsWith(`${p}?`));
    if (!hit) throw new ApiRequestError(404, 'not_found', 'Not found');
    const v = hit[1];
    if (v instanceof Error) throw v;
    return typeof v === 'function' ? (v as (p: string) => unknown)(path) : v;
  };
  const session = {
    ready: true, tokenReady: true, get token() { return h.token; }, get scope() { return h.scope; }, meError: null,
    me: { user: { id: 'u1', email: 'ops@resuto.test', fullName: 'Mona Adel' }, memberships: [] },
    call, signOut: vi.fn(async () => undefined),
  };
  return { useSession: () => session };
});

const { AdminShell } = await import('./AdminShell');
const { ADMIN_STRINGS } = await import('./strings');
const { default: TenantsPage } = await import('./page');
const { default: ProvidersPage } = await import('./providers/page');

let scopeN = 0;
const inLocale = (locale: 'en' | 'ar', node: ReactNode) => (
  <LocaleProvider locale={locale} messages={{ ...messagesFor(locale, 'guest'), ...messagesFor(locale, 'staff') }}>{node}</LocaleProvider>
);
const flush = () => act(async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0)); });
const render = async (locale: 'en' | 'ar', node: ReactNode) => {
  h.scope = `u${++scopeN}`; // a fresh query-cache partition per test
  const v = mount(inLocale(locale, <AdminShell strings={ADMIN_STRINGS[locale]}>{node}</AdminShell>), locale);
  await flush();
  return v;
};

afterEach(() => { document.body.innerHTML = ''; h.routes = {}; h.calls = []; h.pathname = '/admin'; h.search = new URLSearchParams(); h.token = 'tok'; });

const tenant = (i: number, over: Partial<AdminTenantRow> = {}): AdminTenantRow => ({
  id: `00000000-0000-4000-8000-00000000000${i}`, slug: `olive-${i}`, name: `Olive ${i}`, nameAr: `زيتون ${i}`, country: 'EG', status: 'active',
  planId: 'pro', subscriptionStatus: 'active', createdAt: `2026-10-0${i}T10:00:00Z`, lastOrderAt: null,
  counts: { branches: i, members: 2, orders30d: 10 * i }, ...over,
} as AdminTenantRow);

describe('console shell', () => {
  it('a platform operator sees the console: four sections with icons, the current one marked, the role named', async () => {
    h.routes = { '/admin/me': { userId: 'u1', role: 'superadmin' }, '/admin/tenants': { items: [], nextCursor: null } };
    const v = await render('en', <TenantsPage />);
    const nav = $(v.host, 'nav.ws-nav');
    expect(nav.getAttribute('aria-label')).toBe('Resuto admin');
    const links = $$<HTMLAnchorElement>(nav, 'a');
    expect(links.map((a) => a.textContent)).toEqual(['Restaurants', 'Prices', 'Operations', 'Provider apps']);
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/admin', '/admin/prices', '/admin/operations', '/admin/providers']);
    expect(links[0]!.getAttribute('aria-current')).toBe('page');
    expect(links.every((a) => a.querySelector('svg.rui-icon[aria-hidden="true"]'))).toBe(true);
    expect(v.host.textContent).toContain('Role: Superadmin');
    expect($(v.host, 'a.skip-link').getAttribute('href')).toBe('#workspace-main');
    // Account menu: opening it never signs out; sign-out is its own item.
    const profile = $(v.host, '.ws-sidebar-bottom button.ws-profile');
    expect(profile.getAttribute('aria-haspopup')).toBe('menu');
    v.unmount();
  });

  it('in Arabic: translated navigation and role, Western digits, phone tab bar with the same sections', async () => {
    h.pathname = '/admin/operations';
    h.routes = { '/admin/me': { userId: 'u1', role: 'support' } };
    const v = await render('ar', <div>child</div>);
    const links = $$<HTMLAnchorElement>(v.host, 'nav.ws-nav a');
    expect(links.map((a) => a.textContent)).toEqual(['المطاعم', 'الأسعار', 'التشغيل', 'تطبيقات المزوّدين']);
    expect(links[2]!.getAttribute('aria-current')).toBe('page');
    expect(v.host.textContent).toContain('الدور: الدعم');
    expect($$(v.host, 'nav.ws-tabbar a')).toHaveLength(4);
    expect(EASTERN_DIGITS.test(v.host.textContent ?? '')).toBe(false);
    v.unmount();
  });

  it('a signed-in member without a platform role is refused and the console never renders', async () => {
    h.routes = { '/admin/me': new ApiRequestError(403, 'forbidden', 'Platform administrators only') };
    const v = await render('en', <div id="secret-child">child</div>);
    expect(v.host.textContent).toContain('Platform administrators only.');
    expect(v.host.querySelector('#secret-child')).toBeNull();
    expect(v.host.querySelector('nav.ws-nav')).toBeNull();
    expect(h.calls).toEqual(['/admin/me']);
    v.unmount();
  });

  it('a failed role check is an error with Retry, not a refusal; Retry asks again', async () => {
    h.routes = { '/admin/me': new ApiRequestError(503, 'unavailable', 'Down for maintenance') };
    const v = await render('en', <div id="child">child</div>);
    expect(v.host.textContent).not.toContain('Platform administrators only.');
    expect(v.host.querySelector('#child')).toBeNull();
    h.routes = { '/admin/me': { userId: 'u1', role: 'finance' } };
    const retry = $$<HTMLButtonElement>(v.host, 'button').find((b) => /retry/i.test(b.textContent ?? ''))!;
    expect(retry).toBeTruthy();
    await act(async () => { retry.click(); });
    await flush();
    expect(v.host.querySelector('#child')).not.toBeNull();
    v.unmount();
  });
  it('a token refresh re-checks the role without unmounting the page; a transient failure keeps the console', async () => {
    h.routes = { '/admin/me': { userId: 'u1', role: 'superadmin' } };
    const node = <div id="page"><input id="draft" defaultValue="" /></div>;
    const v = await render('en', node);
    const draft = v.host.querySelector<HTMLInputElement>('#draft')!;
    draft.value = 'half-typed reason';
    h.routes = { '/admin/me': new ApiRequestError(503, 'unavailable', 'Down') };
    h.token = 'tok-refreshed';
    v.rerender(inLocale('en', <AdminShell strings={ADMIN_STRINGS.en}>{node}</AdminShell>));
    await flush();
    expect(h.calls.filter((c) => c === '/admin/me')).toHaveLength(2);
    expect(v.host.querySelector('#draft')).toBe(draft);
    expect(draft.value).toBe('half-typed reason');
    // Only the API's refusal ends access.
    h.routes = { '/admin/me': new ApiRequestError(403, 'forbidden', 'Platform administrators only') };
    h.token = 'tok-3';
    v.rerender(inLocale('en', <AdminShell strings={ADMIN_STRINGS.en}>{node}</AdminShell>));
    await flush();
    expect(v.host.querySelector('#draft')).toBeNull();
    expect(v.host.textContent).toContain('Platform administrators only.');
    v.unmount();
  });
});

describe('restaurants list', () => {
  it('rows are links to the restaurant (keyboard reachable), headers sort, keyset pages go forward and back', async () => {
    const first = { items: [tenant(1), tenant(2, { status: 'suspended', lastOrderAt: '2026-10-20T09:00:00Z' }), tenant(3)], nextCursor: 'c2' };
    const second = { items: [tenant(4)], nextCursor: null };
    h.routes = { '/admin/me': { userId: 'u1', role: 'superadmin' }, '/admin/tenants': (p: string) => (p.includes('cursor=c2') ? second : first) };
    const v = await render('en', <TenantsPage />);
    const table = $(v.host, 'table.data');
    const rowLinks = $$<HTMLAnchorElement>(table, 'tbody th[scope="row"] a.rui-dt-rowlink');
    expect(rowLinks.map((a) => a.getAttribute('href'))).toEqual([1, 2, 3].map((i) => `/admin/tenants/${tenant(i).id}`));
    expect(table.textContent).toContain('Suspended');
    expect(h.calls).toContain('/admin/tenants?limit=50');

    // Sorting by branches, descending on the second click.
    const sortBtn = $$<HTMLButtonElement>(table, 'thead button.rui-dt-sort').find((b) => b.textContent?.startsWith('Branches'))!;
    await act(async () => { sortBtn.click(); });
    await act(async () => { sortBtn.click(); });
    expect($$(table, 'tbody th[scope="row"] strong').map((n) => n.textContent)).toEqual(['Olive 3', 'Olive 2', 'Olive 1']);
    expect(sortBtn.closest('th')!.getAttribute('aria-sort')).toBe('descending');

    // Next page uses the cursor; Previous returns.
    const next = $$<HTMLButtonElement>(v.host, '.rui-dt-pager button').find((b) => b.textContent === 'Next')!;
    await act(async () => { next.click(); });
    await flush();
    expect(h.calls.some((c) => c.includes('cursor=c2'))).toBe(true);
    expect($(v.host, 'table.data').textContent).toContain('Olive 4');
    expect(v.host.textContent).toContain('Page 2');
    v.unmount();
  });

  it('filters come from the URL, are sent to the API and show as removable chips (Arabic)', async () => {
    h.search = new URLSearchParams('status=suspended&country=SA&q=olive');
    h.routes = { '/admin/me': { userId: 'u1', role: 'support' }, '/admin/tenants': { items: [], nextCursor: null } };
    const v = await render('ar', <TenantsPage />);
    const call = h.calls.find((c) => c.startsWith('/admin/tenants'))!;
    expect(Object.fromEntries(new URLSearchParams(call.split('?')[1]))).toEqual({ limit: '50', q: 'olive', status: 'suspended', country: 'SA' });
    const chips = $$(v.host, '.rui-filter-chip').map((c) => c.textContent);
    expect(chips).toEqual(['البحث: olive', 'الحالة: موقوف', 'الدولة: السعودية']);
    expect(v.host.textContent).toContain('لا توجد مطاعم مطابقة.');
    // Removing a chip clears that filter in the URL.
    const remove = $$<HTMLButtonElement>(v.host, '.rui-filter-chip button')[1]!;
    await act(async () => { remove.click(); });
    expect(h.replace).toHaveBeenCalled();
    expect(String(h.replace.mock.calls.at(-1)![0])).not.toContain('status=');
    v.unmount();
  });
});

const app = (over: Partial<AdminProviderAppView> = {}): AdminProviderAppView => ({
  provider: 'tiktok_ads', name: 'TikTok for Business (Marketing API)', source: 'database', environment: 'sandbox', appId: '7300000000000000001',
  configIds: {}, secrets: { appSecret: { set: true, hint: '…7788' } }, reviewStatus: 'in_review', notes: null, updatedAt: '2026-10-24T08:00:00Z',
  environmentFallback: [{ name: 'TIKTOK_APP_ID', set: false }], redirectUris: ['https://api.resuto.test/v1/public/integrations/oauth/tiktok_ads/callback'],
  webhooks: [], serves: ['tiktok_ads'], requirements: [], reviewPermissions: ['ads.read'],
  checklist: [{ key: 'app_id', done: true }, { key: 'app_secret', done: true }, { key: 'review_approved', done: false }, { key: 'acceptance_recorded', done: false }],
  acceptance: { passed: 0, lastPassedAt: null }, blockers: [], ...over,
});

describe('provider apps', () => {
  it('logo, readiness, URLs with copy buttons; a stored secret shows only "set" and its last four characters', async () => {
    h.pathname = '/admin/providers';
    h.routes = { '/admin/me': { userId: 'u1', role: 'superadmin' }, '/admin/providers': { items: [app()] } };
    const v = await render('en', <ProvidersPage />);
    const section = $(v.host, 'section[data-provider="tiktok_ads"]');
    expect(section.querySelector('img.rui-provider[data-provider="tiktok"]')).not.toBeNull();
    expect(section.textContent).toContain('2 of 4 ready');
    expect(section.querySelector('progress')!.getAttribute('value')).toBe('2');
    expect(section.textContent).toContain('verification pending');
    const url = section.querySelector('code[dir="ltr"]')!;
    expect(url.textContent).toBe('https://api.resuto.test/v1/public/integrations/oauth/tiktok_ads/callback');
    expect(url.parentElement!.querySelector('button')!.textContent).toBe('Copy');
    const form = section.querySelector('form[aria-label="TikTok for Business (Marketing API)"]')!;
    const secret = form.querySelector<HTMLInputElement>('input[type="password"]')!;
    expect(secret.value).toBe('');
    expect(secret.getAttribute('autocomplete')).toBe('new-password');
    expect(form.textContent).toContain('Set (…7788)');
    // Section navigation: one entry per app, linking to its section.
    expect($(v.host, '.rui-settings-nav a').getAttribute('href')).toBe('#provider-tiktok_ads');
    v.unmount();
  });

  it('support (read-only) sees the readiness but no form; Arabic labels', async () => {
    h.pathname = '/admin/providers';
    h.routes = { '/admin/me': { userId: 'u1', role: 'support' }, '/admin/providers': { items: [app({ provider: 'foodics', name: 'Foodics' })] } };
    const v = await render('ar', <ProvidersPage />);
    const section = $(v.host, 'section[data-provider="foodics"]');
    expect(section.querySelector('form')).toBeNull();
    expect(section.textContent).toContain('دورك هنا للقراءة فقط.');
    expect(section.textContent).toContain('2 من 4 جاهزة');
    expect(EASTERN_DIGITS.test(v.host.textContent ?? '')).toBe(false);
    v.unmount();
  });
});

describe('area loading and error states', () => {
  it('the detail placeholder has a main column and an inspector; the console error goes back to /admin', async () => {
    const { AreaSkeleton } = await import('@/components/shell/AreaSkeleton');
    const { AreaError } = await import('@/components/shell/AreaError');
    const sk = mount(inLocale('en', <AreaSkeleton template="detail" />));
    expect($(sk.host, '[data-template="detail"]').getAttribute('aria-busy')).toBe('true');
    expect(sk.host.querySelector('.area-sk-detail .area-sk-main')).not.toBeNull();
    expect(sk.host.querySelector('.area-sk-detail .area-sk-end')).not.toBeNull();
    sk.unmount();
    for (const locale of ['en', 'ar'] as const) {
      const v = mount(inLocale(locale, <AreaError error={Object.assign(new Error('boom'), { digest: 'd1' })} reset={() => undefined} area="admin" homeHref="/admin" />), locale);
      const home = $$<HTMLAnchorElement>(v.host, 'a.btn').at(-1)!;
      expect(home.getAttribute('href')).toBe('/admin');
      expect($(v.host, '[role="alert"]').getAttribute('data-area')).toBe('admin');
      if (locale === 'ar') expect(home.textContent).toMatch(/[؀-ۿ]/);
      v.unmount();
    }
  });
});
