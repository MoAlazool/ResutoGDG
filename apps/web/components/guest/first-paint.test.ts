// PERF-01: the guest ordering page (/order/<slug>) and the QR table page (/t/<qr>) put their heading and menu in the
// server HTML itself. Behind a loading route boundary the page streamed after a skeleton and React revealed it with a
// batched timer, which a repeat visit's cached JavaScript delayed until hydration had finished (repeat-visit LCP
// ~1.35 s / ~1.6 s instead of ~0.3 s on the lab mobile profile). These tests keep the boundary away from both routes,
// render the real pages (server component + client experience) to HTML, and check the slow-read budget that keeps a
// cold menu read from holding the page. scripts/perf/guest-shell.mjs checks the same against a running build.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement as h, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicMenu, PublicMenuProduct, PublicTableView } from '@resuto/contracts';
import { LocaleProvider } from '@/lib/i18n/client';
import { messagesFor } from '@/lib/i18n/messages';
import { inspectGuestShell } from '../../../../scripts/perf/lib/guest-shell.mjs';

const reads = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('next/headers', () => ({ headers: async () => ({ get: () => null }) }));
vi.mock('next/cache', () => ({ unstable_cache: (cb: (...a: unknown[]) => Promise<unknown>) => cb }));
vi.mock('next/navigation', () => ({
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
  redirect: (p: string) => { throw new Error(`NEXT_REDIRECT ${p}`); },
  useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, prefetch() {} }),
  useParams: () => ({}),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/components/guest/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./server')>()),
  serverRead: (...a: unknown[]) => reads.fn(...a),
}));

const { default: OrderPage } = await import('@/app/order/[slug]/(menu)/page');
const { default: TablePage } = await import('@/app/t/[qr]/page');
const { MenuPending } = await import('@/app/t/[qr]/_guest/TableExperience');
const { menuSource } = await import('@/app/t/[qr]/_guest/menu-source');
const { GUEST_MENU_BUDGET_MS, GUEST_MENU_MIN_MS, menuBudget, within } = await import('./server');

const APP = fileURLToPath(new URL('../../app/', import.meta.url));
const dish = (id: string, name: string): PublicMenuProduct => ({
  id, name, nameAr: null, description: 'House favourite.', descriptionAr: null, priceMinor: 14500, imageUrl: null,
  allergens: [], dietary: [], spiceLevel: 0, available: true, prepMinutes: 10, modifierGroups: [],
}) as unknown as PublicMenuProduct;
const branch = { id: 'b1', code: 'main', name: 'Zamalek', nameAr: null, acceptsDineIn: true, acceptsPickup: true, acceptsDelivery: false, acceptsReservations: false };
const menu = {
  org: { name: 'The Olive Room', nameAr: null, currency: 'EGP', slug: 'the-olive-room' },
  branch, branches: [branch],
  categories: [{ id: 'c1', name: 'Starters', nameAr: null, products: [dish('p1', 'Burrata & heirloom tomato'), dish('p2', 'Roasted pumpkin soup')] }],
} as unknown as PublicMenu;
const webMenu = { ...menu, payment: { payAtPickup: true, cashOnDelivery: false, online: false }, cover: null };
const table: PublicTableView = {
  org: { name: 'The Olive Room', nameAr: null, slug: 'the-olive-room', currency: 'EGP' }, branch: { id: 'b1', code: 'main', name: 'Zamalek', nameAr: null },
  table: { label: 'T4' }, accepting: true, reason: null, cover: null,
};
const QR = 'qr_abcdefghijklmnop';
const html = (locale: 'en' | 'ar', el: ReactElement) => renderToStaticMarkup(h(LocaleProvider, { locale, messages: messagesFor(locale, 'guest'), children: el }));
const order = () => OrderPage({ params: Promise.resolve({ slug: 'the-olive-room' }), searchParams: Promise.resolve({}) }) as Promise<ReactElement>;
const qrPage = () => TablePage({ params: Promise.resolve({ qr: QR }) }) as Promise<ReactElement>;
const never = () => new Promise(() => {});

beforeEach(() => { reads.fn.mockReset(); });
afterEach(() => { vi.useRealTimers(); });

describe('guest routes have no loading boundary above the page (PERF-01)', () => {
  // A loading.tsx in any segment from the app root down wraps the page in a Suspense boundary; so would <Suspense> in
  // a layout or page on the way.
  const routes = {
    'web order': ['', 'order', 'order/[slug]', 'order/[slug]/(menu)'],
    'QR table': ['', 't', 't/[qr]'],
  };
  for (const [name, dirs] of Object.entries(routes)) {
    it(name, () => {
      for (const dir of dirs) {
        for (const f of ['loading.tsx', 'loading.ts', 'loading.jsx', 'loading.js']) expect(existsSync(join(APP, dir, f)), `${dir}/${f}`).toBe(false);
        for (const f of ['layout.tsx', 'page.tsx', 'template.tsx']) {
          const file = join(APP, dir, f);
          if (existsSync(file)) expect(readFileSync(file, 'utf8'), `${dir}/${f}`).not.toMatch(/<Suspense\b/);
        }
      }
    });
  }
});

describe('the pages render their heading and menu in the HTML', () => {
  it('web order: <h1> and the dish cards, no skeleton', async () => {
    reads.fn.mockResolvedValue({ status: 'ok', data: webMenu });
    const out = html('en', await order());
    expect(reads.fn).toHaveBeenCalledWith('/public/order/the-olive-room', { revalidate: 30, tags: ['menu:the-olive-room'] });
    expect(inspectGuestShell(out)).toMatchObject({ ok: true, problems: [] });
    expect(out).toContain('Burrata &amp; heirloom tomato');
    expect(out).not.toContain('gx-menu-skeleton');
  });

  it('QR table (Arabic): <h1> and the dish cards, no skeleton', async () => {
    reads.fn.mockImplementation(async (path: string) => (path.startsWith('/public/tables/') ? { status: 'ok', data: table } : { status: 'ok', data: menu }));
    const out = html('ar', await qrPage());
    expect(reads.fn).toHaveBeenCalledWith('/public/menu/the-olive-room?branch=main', { revalidate: 30, tags: ['menu:the-olive-room'] });
    expect(inspectGuestShell(out)).toMatchObject({ ok: true, problems: [] });
    expect(out).toContain('Roasted pumpkin soup');
  });

  it('an unknown restaurant is still a 404', async () => {
    reads.fn.mockResolvedValue({ status: 'missing' });
    await expect(order()).rejects.toThrow('NEXT_NOT_FOUND');
  });
});

describe('a slow menu read does not hold the page (GUEST_MENU_BUDGET_MS)', () => {
  it('web order: after the budget the page renders its heading and the menu skeleton, to load in the browser', async () => {
    vi.useFakeTimers();
    reads.fn.mockImplementation(never);
    const page = order();
    await vi.advanceTimersByTimeAsync(GUEST_MENU_BUDGET_MS);
    const out = html('en', await page);
    expect(out).toMatch(/<h1[\s>]/);
    expect(out).toContain('gx-menu-skeleton');
    expect(out).toContain('role="status"');
    expect(out).not.toContain('gx-dish-name');
  });

  it('QR table: the same once the table is known', async () => {
    vi.useFakeTimers();
    reads.fn.mockImplementation((path: string) => (path.startsWith('/public/tables/') ? Promise.resolve({ status: 'ok', data: table }) : never()));
    const page = qrPage();
    await vi.advanceTimersByTimeAsync(GUEST_MENU_BUDGET_MS);
    const out = html('ar', await page);
    expect(out).toMatch(/<h1[\s>]/);
    expect(out).toContain('gx-menu-skeleton');
    expect(out).not.toContain('gx-dish-name');
  });

  it('QR table not taking orders: the same skeleton, and the browser then loads the public menu (no visit to wait for)', async () => {
    vi.useFakeTimers();
    const closed = { ...table, accepting: false, reason: 'cleaning' } as unknown as PublicTableView;
    reads.fn.mockImplementation((path: string) => (path.startsWith('/public/tables/') ? Promise.resolve({ status: 'ok', data: closed }) : never()));
    const page = qrPage();
    await vi.advanceTimersByTimeAsync(GUEST_MENU_BUDGET_MS);
    const out = html('en', await page);
    expect(out).toContain('gx-menu-skeleton');
    expect(out).not.toContain('gx-dish-name');
    // TableExperience marks such a table 'unavailable' without opening a session: the menu comes from the table lookup.
    expect(menuSource({ hasMenu: false, visit: null, phase: 'unavailable', table: closed })).toEqual({ path: '/public/menu/the-olive-room?branch=main' });
  });

  it('the budget counts from the start of the request: a slow table read leaves the menu read less time', async () => {
    vi.useFakeTimers();
    let menuAsked = false;
    reads.fn.mockImplementation((path: string) => {
      if (path.startsWith('/public/tables/')) return new Promise((r) => setTimeout(() => r({ status: 'ok', data: table }), 1000));
      menuAsked = true;
      return never();
    });
    let done = false;
    const page = qrPage().then((p) => { done = true; return p; });
    await vi.advanceTimersByTimeAsync(1000);
    expect(menuAsked).toBe(true);
    await vi.advanceTimersByTimeAsync(GUEST_MENU_BUDGET_MS - 1000 + 1);
    expect(done).toBe(true);   // ~1.2 s after the request started, not 1 s + 1.2 s
    expect(html('en', await page)).toContain('gx-menu-skeleton');
  });

  it('menuBudget(): what is left of the budget since the request started, never less than the minimum', () => {
    expect(menuBudget(1000, 1000)).toBe(GUEST_MENU_BUDGET_MS);
    expect(menuBudget(1000, 1400)).toBe(GUEST_MENU_BUDGET_MS - 400);
    expect(menuBudget(1000, 1000 + GUEST_MENU_BUDGET_MS + 500)).toBe(GUEST_MENU_MIN_MS);
    expect(menuBudget(1000, 900)).toBe(GUEST_MENU_BUDGET_MS);
  });

  it('within(): the read when it is in time, "late" after the budget (the read is not cancelled), timers cleared', async () => {
    vi.useFakeTimers();
    expect(await within(Promise.resolve({ status: 'ok' as const, data: 1 }), 50)).toEqual({ status: 'ok', data: 1 });
    expect(vi.getTimerCount()).toBe(0);
    let finish!: (v: { status: 'ok'; data: number }) => void;
    const slow = new Promise<{ status: 'ok'; data: number }>((r) => { finish = r; });
    const raced = within(slow, 50);
    await vi.advanceTimersByTimeAsync(50);
    expect(await raced).toEqual({ status: 'late' });
    finish({ status: 'ok', data: 2 });
    expect(await slow).toEqual({ status: 'ok', data: 2 });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('QR table: a menu that is not in the HTML is loaded in the browser (menu-source.ts)', () => {
  const visit = { token: 'tok', visitId: 'v1', orgId: 'o1', branchId: 'b1', tableLabel: 'T4', currency: 'EGP' as const, savedAt: 0 };
  it('the menu is there: nothing to load', () => {
    expect(menuSource({ hasMenu: true, visit, phase: 'ready', table })).toBeNull();
  });
  it("with a visit: the visit's menu", () => {
    expect(menuSource({ hasMenu: false, visit, phase: 'ready', table })).toEqual({ path: '/public/visits/current/menu', headers: { 'X-Visit-Token': 'tok' } });
  });
  it('while the session opens: wait for it', () => {
    expect(menuSource({ hasMenu: false, visit: null, phase: 'joining', table })).toBeNull();
  });
  it('without a visit (not taking orders, session refused, visit closed): the public menu of the branch', () => {
    for (const phase of ['unavailable', 'closed'] as const) {
      expect(menuSource({ hasMenu: false, visit: null, phase, table })).toEqual({ path: '/public/menu/the-olive-room?branch=main' });
    }
  });
  it('neither a visit nor the table: nothing to load from (the page offers Retry, which scans in again)', () => {
    expect(menuSource({ hasMenu: false, visit: null, phase: 'unavailable', table: null })).toBeNull();
  });
  it('MenuPending: the skeleton while loading; a failure shows why and Retry, never an endless "Loading…"', () => {
    const loading = html('en', h(MenuPending, { error: null, onRetry: () => {} }));
    expect(loading).toContain('gx-menu-skeleton');
    expect(loading).toContain('role="status"');
    const failed = html('ar', h(MenuPending, { error: 'تعذّر تحميل القائمة.', onRetry: () => {} }));
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('إعادة المحاولة');
    expect(failed).not.toContain('gx-menu-skeleton');
    expect(failed).not.toContain('جارٍ التحميل');
  });
});

describe('inspectGuestShell (scripts/perf/guest-shell.mjs)', () => {
  const card = '<article class="gx-dish"><button type="button" class="gx-dish-name"><h3>Burrata</h3></button></article>';
  it('passes a page whose heading and cards are in the document', () => {
    expect(inspectGuestShell(`<body><div class="gx"><section class="gx-cover"><h1>Menu</h1></section>${card}</div></body>`)).toMatchObject({ ok: true });
  });
  it("ignores Next's empty metadata boundary in a hidden div", () => {
    const html = `<body><div hidden=""><!--$?--><template id="B:0"></template><!--/$--></div><div class="gx"><h1>Menu</h1>${card}</div>`
      + '<div hidden id="S:1"></div><script>$RC("B:0","S:1")</script></body>';
    expect(inspectGuestShell(html)).toMatchObject({ ok: true, firstFallback: null });
  });
  it('fails the streamed shape: loading fallback first, content in a hidden segment', () => {
    const streamed = '<body><!--$?--><template id="B:0"></template><div class="gx gx-loading"><div class="gx-dish"></div></div><!--/$-->'
      + `<div hidden id="S:0"><div class="gx"><h1>Menu</h1>${card}</div></div><script>$RC("B:0","S:0")</script></body>`;
    const r = inspectGuestShell(streamed);
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual(expect.arrayContaining([expect.stringContaining('hidden segment'), expect.stringContaining('fallback'), expect.stringContaining('loading shell')]));
  });
  it('fails a page without a heading or dish card', () => {
    expect(inspectGuestShell('<body><p>Loading…</p></body>').problems).toEqual(['no <h1> in the HTML', 'no dish card in the HTML']);
  });
});
