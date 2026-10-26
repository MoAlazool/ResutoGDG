import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MODULE_KEYS, type ModuleKey } from '@resuto/contracts';
import { connectionState, reportConnection, resetConnection, subscribeConnection } from './connection';
import { activeItem, ALL_AREAS, AREAS, homePath, isFreeShell, itemPath, lockedItems, NAV, navForBranch, SETTINGS_AREA, visibleAreas } from './nav';
import type { OrgInfo } from './org-context';
import { actionEntries, pageEntries } from './palette-entries';
import { isAnalyticsView } from './insights';
import { GO_SHORTCUTS } from './shortcuts';
import {
  dropShellSnapshot, readAllBranches, readShellSnapshot, SNAPSHOT_MAX_AGE_MS, withPreferredBranch, writeAllBranches, writeShellSnapshot,
} from './shell-snapshot';
import { USER_KEY_PATTERNS } from './user-storage';

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), keys: () => [...m.keys()] };
};
const org = (over: Partial<OrgInfo> = {}): OrgInfo => ({
  id: 'org-1', slug: 'olive', name: 'The Olive Room', nameAr: null, country: 'EG', currency: 'EGP', timezone: 'Africa/Cairo', role: 'owner', status: 'active',
  branches: [{ id: 'b1', name: 'Zamalek', nameAr: null, code: 'main', isActive: true }, { id: 'b2', name: 'Smash', nameAr: null, code: 'burger', isActive: true }],
  ...over,
});

describe('chrome-first shell snapshot (VS-07 / PCL-05)', () => {
  it('returns the last known restaurant only to the same user and for the same restaurant', () => {
    const store = memory();
    writeShellSnapshot({ scope: 'u:alice', org: org(), modules: { core: true }, savedAt: Date.now() }, store);
    expect(readShellSnapshot('org-1', 'u:alice', store)?.org.name).toBe('The Olive Room');
    expect(readShellSnapshot('org-1', 'u:bob', store)).toBeNull();
    expect(readShellSnapshot('org-2', 'u:alice', store)).toBeNull();
    expect(readShellSnapshot('org-1', null, store)).toBeNull();
  });

  it('ignores stale or corrupt snapshots and forgets one when access is gone', () => {
    const store = memory();
    writeShellSnapshot({ scope: 'u:a', org: org(), modules: null, savedAt: Date.now() - SNAPSHOT_MAX_AGE_MS - 1 }, store);
    expect(readShellSnapshot('org-1', 'u:a', store)).toBeNull();
    store.setItem('resuto.shell.org.org-1', '{not json');
    expect(readShellSnapshot('org-1', 'u:a', store)).toBeNull();
    writeShellSnapshot({ scope: 'u:a', org: org(), modules: null, savedAt: Date.now() }, store);
    dropShellSnapshot('org-1', store);
    expect(readShellSnapshot('org-1', 'u:a', store)).toBeNull();
  });

  it('stores under a per-user key that sign-out clears', () => {
    const store = memory();
    writeShellSnapshot({ scope: 'u:a', org: org(), modules: null, savedAt: Date.now() }, store);
    for (const k of store.keys()) expect(USER_KEY_PATTERNS.some((re) => re.test(k))).toBe(true);
  });

  it('puts the branch chosen in the restaurant chip first and leaves unknown choices alone', () => {
    expect(withPreferredBranch(org(), 'b2').branches.map((b) => b.id)).toEqual(['b2', 'b1']);
    expect(withPreferredBranch(org(), 'b1').branches.map((b) => b.id)).toEqual(['b1', 'b2']);
    expect(withPreferredBranch(org(), 'nope').branches.map((b) => b.id)).toEqual(['b1', 'b2']);
  });
});

describe('topbar connection status', () => {
  it('reports reconnecting after a network/gateway failure and live again after a success', () => {
    resetConnection();
    const seen: string[] = [];
    globalThis.window ??= { addEventListener() {}, removeEventListener() {} } as never;
    const off = subscribeConnection(() => seen.push(connectionState()));
    reportConnection(false);
    expect(connectionState()).toBe('reconnecting');
    reportConnection(false); // no duplicate notifications
    reportConnection(true);
    expect(connectionState()).toBe('live');
    expect(seen).toEqual(['reconnecting', 'live']);
    off();
  });
});

describe('role-aware landing (VS-05)', () => {
  it('sends each role to its own screen', () => {
    expect(homePath('owner', 'o1')).toBe('/dashboard/o1');
    expect(homePath('manager', 'o1')).toBe('/dashboard/o1');
    expect(homePath('kitchen', 'o1')).toBe('/kitchen/o1');
    expect(homePath('driver', 'o1')).toBe('/driver');
    expect(homePath('host', 'o1')).toBe('/dashboard/o1/host'); // VS-12: the front desk screen now exists
    expect(homePath('cashier', 'o1')).toBe('/dashboard/o1/orders');
    expect(homePath('marketing', 'o1')).toBe('/dashboard/o1');
    expect(homePath('something-new', 'o1')).toBe('/dashboard/o1');
  });

  it('opens the one kitchen display route for every role that runs the kitchen (21-OPS, plan §5)', async () => {
    const { kitchenDisplayPath } = await import('./home-path');
    // The dashboard's Kitchen link opens the full-screen display; there is no second, in-workspace copy any more.
    expect(kitchenDisplayPath('owner', 'o1')).toBe('/kitchen/o1');
    expect(kitchenDisplayPath('manager', 'o1')).toBe('/kitchen/o1');
    expect(kitchenDisplayPath('kitchen', 'o1')).toBe('/kitchen/o1');
    // Older links with ?display=full keep working.
    expect(kitchenDisplayPath('manager', 'o1', { full: true })).toBe('/kitchen/o1?display=full');
    expect(kitchenDisplayPath('kitchen', 'o1', { full: true })).toBe('/kitchen/o1?display=full');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 21-SHELL: seven areas, Settings cluster, Explore, Free shell, reachability, branch context
// ---------------------------------------------------------------------------------------------------------------
const WEB = join(__dirname, '..');
const ORG_DIR = join(WEB, 'app', 'dashboard', '[orgId]');
const ALL_ON = Object.fromEntries(MODULE_KEYS.map((m) => [m, true])) as Record<ModuleKey, boolean>;
const ONLY_CORE = Object.fromEntries(MODULE_KEYS.map((m) => [m, m === 'core'])) as Record<ModuleKey, boolean>;
const TABLES = { serviceMode: 'tables', acceptsReservations: true };
const t = (k: string) => k;

/** Every dashboard route under /dashboard/[orgId] (relative path, '' for the overview). */
function dashboardRoutes(): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, `${rel}/${name}`);
      else if (name === 'page.tsx') out.push(rel);
    }
  };
  walk(ORG_DIR, '');
  return out.sort();
}
const paths = (areas: ReturnType<typeof visibleAreas>) => areas.flatMap((a) => a.items.flatMap((i) => [itemPath(i.href), ...(i.also ?? [])]));

describe('seven-area navigation (21-SHELL)', () => {
  it('has the seven primary areas of plan §3 in order, and Settings in the footer cluster', () => {
    expect(AREAS.map((a) => a.key)).toEqual(['home', 'operations', 'store', 'customers', 'money', 'insights', 'apps']);
    expect(SETTINGS_AREA.items.map((i) => i.href)).toEqual(['/settings', '/settings/messaging', '/settings/devices', '/team', '/billing', '/data', '/audit']);
    const where = (href: string) => ALL_AREAS.find((a) => a.items.some((i) => i.href === href))?.key;
    expect(['', '/setup', '/notifications'].map(where)).toEqual(['home', 'home', 'home']);
    expect(['/orders', '/kitchen', '/floor', '/host', '/reservations', '/delivery', '/inventory'].map(where)).toEqual(Array(7).fill('operations'));
    expect(['/menu', '/website', '/studio-media', '/qr', '/website?tab=domains'].map(where)).toEqual(Array(5).fill('store'));
    expect(['/inbox', '/customers', '/loyalty', '/marketing'].map(where)).toEqual(Array(4).fill('customers'));
    expect(['/payments', '/finance', '/compliance'].map(where)).toEqual(Array(3).fill('money'));
    expect(['/analytics', '/intelligence'].map(where)).toEqual(['insights', 'insights']);
    expect(['/intelligence/assistant', '/mcp', '/integrations'].map(where)).toEqual(['apps', 'apps', 'apps']);
    // Menu import is not a separate entry: it is reached from the Menu item (and its page actions).
    expect(ALL_AREAS.flatMap((a) => a.items).some((i) => i.href === '/menu-import')).toBe(false);
  });

  it('every dashboard route is reachable within two clicks from the navigation, and from the command palette', () => {
    const areas = visibleAreas({ role: 'owner', modules: ALL_ON, plan: 'pro', branch: TABLES });
    const nav = new Set(paths(areas));
    const palette = new Set(pageEntries(areas, 'owner', t, { explore: true }).map((e) => itemPath(e.href!)));
    // Routes opened from a list row (a customer, a payment, an MCP connection, a change set) or by an OAuth flow
    // (/dashboard/mcp-authorize redirects to mcp/authorize): reached through their parent page.
    const viaParent: Record<string, string> = {
      '/customers/[customerId]': '/customers', '/payments/[paymentId]': '/payments', '/mcp/clients/[clientId]': '/mcp', '/mcp/authorize': '/mcp',
      '/approvals/[changeSetId]': '/approvals',
      // 21-INSIGHTS: the analytics views (/analytics/sales …) share one dynamic route, reached from the Analytics item's
      // SectionNav and listed in the palette by their own paths.
      '/analytics/[section]': '/analytics',
    };
    const missing: string[] = [];
    for (const route of dashboardRoutes()) {
      if (route === '/explore') { if (!palette.has(route)) missing.push(route); continue; }
      const parent = viaParent[route];
      if (parent) { if (!nav.has(parent)) missing.push(`${route} (parent ${parent})`); continue; }
      // In the navigation (area → item: two clicks), or one palette search away under its item's page (item → tab).
      const inNav = nav.has(route);
      const inPalette = palette.has(route);
      const owner = ALL_AREAS.flatMap((a) => a.items).find((i) => route === itemPath(i.href) || route.startsWith(`${itemPath(i.href)}/`) || (i.also ?? []).includes(route));
      if (!inPalette || (!inNav && !(owner && nav.has(itemPath(owner.href))))) missing.push(route);
    }
    expect(missing).toEqual([]);
    expect(dashboardRoutes().length).toBeGreaterThan(45);
  });

  it('every navigation and palette link points at a real route', () => {
    const files = dashboardRoutes();
    // The analytics views are the known sections of /analytics/[section] (21-INSIGHTS ANALYTICS_VIEWS), nothing else.
    expect(files).toContain('/analytics/[section]');
    const routes = { has: (l: string) => files.includes(l) || (l.startsWith('/analytics/') && isAnalyticsView(l.slice('/analytics/'.length))) };
    const areas = visibleAreas({ role: 'owner', modules: ALL_ON, plan: 'pro', branch: TABLES });
    const links = [...paths(areas), ...pageEntries(areas, 'owner', t, { explore: true }).map((e) => itemPath(e.href!)),
      ...actionEntries({ role: 'owner', hrefs: new Set(areas.flatMap((a) => a.items.map((i) => i.href))), multiBranch: true }, t).filter((e) => e.href).map((e) => itemPath(e.href!))];
    expect(links.filter((l) => !routes.has(l))).toEqual([]);
  });

  it('shows no locked module as a navigation item: the plan\'s missing modules are listed on Explore', () => {
    const starter = { ...ALL_ON, marketing: false, studio: false, finance: false, compliance: false, intelligence: false, mcp: false, driver: false };
    const areas = visibleAreas({ role: 'owner', modules: starter, plan: 'starter', branch: TABLES });
    const items = areas.flatMap((a) => a.items);
    expect(items.filter((i) => starter[i.module] === false)).toEqual([]);
    expect(items.map((i) => i.href)).toEqual(expect.arrayContaining(['/orders', '/inbox', '/payments', '/menu']));
    const locked = lockedItems({ role: 'owner', modules: starter, plan: 'starter', branch: TABLES }).map((i) => i.href);
    expect(locked).toEqual(expect.arrayContaining(['/marketing', '/loyalty', '/website', '/finance', '/intelligence', '/mcp', '/delivery']));
    expect(locked).not.toContain('/orders');
    // Everything on: nothing to explore.
    expect(lockedItems({ role: 'owner', modules: ALL_ON, plan: 'pro', branch: TABLES })).toEqual([]);
    // Unknown entitlements (endpoint down): the full navigation, the API still enforces.
    expect(visibleAreas({ role: 'owner', modules: null, plan: null, branch: TABLES }).length).toBe(8);
  });

  it('the Free (QR menu) shell shows only Home, Menu, Store design, QR codes, Settings and Explore', () => {
    for (const ctx of [{ plan: 'free', modules: ONLY_CORE }, { plan: null, modules: ONLY_CORE }, { plan: 'free', modules: ALL_ON }]) {
      expect(isFreeShell(ctx.plan, ctx.modules)).toBe(true);
      const areas = visibleAreas({ role: 'owner', ...ctx, branch: TABLES });
      expect(areas.map((a) => a.key)).toEqual(['home', 'store', 'settings']);
      expect(areas.find((a) => a.key === 'store')!.items.map((i) => [i.href, i.label])).toEqual([
        ['/menu', 'nav.menu'], ['/website', 'nav.storeDesign'], ['/qr', 'nav.qrCodes'],
      ]);
      expect(areas.find((a) => a.key === 'home')!.items.map((i) => i.href)).toEqual(['', '/setup', '/notifications']);
      // Operations, customers, money, insights and apps stay hidden; Explore lists them.
      const locked = lockedItems({ role: 'owner', ...ctx, branch: TABLES }).map((i) => i.href);
      expect(locked).toEqual(expect.arrayContaining(['/orders', '/kitchen', '/inbox', '/customers', '/payments', '/analytics', '/integrations']));
    }
    expect(isFreeShell('starter', ALL_ON)).toBe(false);
    expect(isFreeShell(null, null)).toBe(false);
    expect(isFreeShell(null, { core: true, connect: true })).toBe(false);
  });

  it('filters by role and branch service model, as before', () => {
    const kitchen = visibleAreas({ role: 'kitchen', modules: ALL_ON, plan: 'pro', branch: TABLES });
    expect(kitchen.flatMap((a) => a.items).map((i) => i.href)).toEqual(['/notifications', '/orders', '/kitchen', '/inventory', '/menu']);
    const host = visibleAreas({ role: 'host', modules: ALL_ON, plan: 'pro', branch: TABLES }).flatMap((a) => a.items).map((i) => i.href);
    expect(host).toEqual(expect.arrayContaining(['/orders', '/floor', '/host', '/reservations', '/customers']));
    expect(host).not.toContain('/settings');
    const counter = visibleAreas({ role: 'owner', modules: ALL_ON, plan: 'pro', branch: { serviceMode: 'counter', acceptsReservations: false } })
      .flatMap((a) => a.items).map((i) => i.href);
    expect(counter).not.toContain('/floor');
    expect(counter).not.toContain('/reservations');
    // The QR hub stays for counter venues (their venue code is on the QR codes page).
    expect(counter).toContain('/qr');
    // Drivers land on /driver; inside the workspace they only have their notifications.
    expect(visibleAreas({ role: 'driver', modules: ALL_ON, plan: 'pro', branch: TABLES }).flatMap((a) => a.items).map((i) => i.href)).toEqual(['/notifications']);
  });

  it('highlights the item a page belongs to', () => {
    const areas = visibleAreas({ role: 'owner', modules: ALL_ON, plan: 'pro', branch: TABLES });
    const at = (p: string) => activeItem(areas, p)?.item.href;
    expect(at('')).toBe('');
    expect(at('/orders')).toBe('/orders');
    expect(at('/finance/pnl')).toBe('/finance');
    expect(at('/intelligence/forecast')).toBe('/intelligence');
    expect(at('/intelligence/assistant')).toBe('/intelligence/assistant');
    expect(at('/mcp/clients/abc')).toBe('/mcp');
    expect(at('/menu-import')).toBe('/menu');
    expect(at('/floor')).toBe('/floor');
    expect(at('/website')).toBe('/website');
    expect(at('/customers/c1')).toBe('/customers');
    expect(at('/explore')).toBeUndefined();
    const free = visibleAreas({ role: 'owner', modules: ONLY_CORE, plan: 'free', branch: TABLES });
    expect(activeItem(free, '/qr')?.item.href).toBe('/qr');
  });

  it('every area route group has its own loading and error state', () => {
    const missing: string[] = [];
    for (const name of readdirSync(ORG_DIR)) {
      const dir = join(ORG_DIR, name);
      if (!statSync(dir).isDirectory() || name.startsWith('_')) continue;
      for (const f of ['loading.tsx', 'error.tsx']) if (!existsSync(join(dir, f))) missing.push(`${name}/${f}`);
      if (existsSync(join(dir, 'error.tsx'))) expect(readFileSync(join(dir, 'error.tsx'), 'utf8')).toMatch(/AreaError/);
    }
    expect(missing).toEqual([]);
    expect(readFileSync(join(WEB, 'components/shell/AreaError.tsx'), 'utf8')).toMatch(/ErrorState/);
  });

  it('g-shortcuts are unique letters that open navigation items', () => {
    const letters = GO_SHORTCUTS.map((s) => s.letter);
    expect(new Set(letters).size).toBe(letters.length);
    expect(Object.fromEntries(GO_SHORTCUTS.map((s) => [s.letter, s.item.href]))).toEqual({
      h: '', o: '/orders', k: '/kitchen', m: '/menu', i: '/inbox', c: '/customers', p: '/payments', a: '/analytics', s: '/settings',
    });
  });
});

describe('one branch context (21-SHELL)', () => {
  it('remembers "All branches" per restaurant, defaulting to all branches', () => {
    const store = memory();
    expect(readAllBranches('org-1', store)).toBe(true);
    writeAllBranches('org-1', false, store);
    expect(readAllBranches('org-1', store)).toBe(false);
    expect(readAllBranches('org-2', store)).toBe(true);
    // Per-user keys: removed on sign-out.
    for (const k of store.keys()) expect(USER_KEY_PATTERNS.some((re) => re.test(k))).toBe(true);
  });

  it('no screen keeps its own branch select any more', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(name) && /function BranchSelect|<BranchSelect\b/.test(readFileSync(p, 'utf8'))) offenders.push(p.slice(WEB.length + 1));
      }
    };
    walk(join(WEB, 'app', 'dashboard'));
    walk(join(WEB, 'components'));
    expect(offenders).toEqual([]);
  });
});

describe('service model drives the navigation (VS-16)', () => {
  const items = NAV.flatMap((g) => g.items);
  const hrefs = (branch: Parameters<typeof navForBranch>[1]) => items.filter((i) => navForBranch(i, branch)).map((i) => i.href);
  it('table service keeps the floor, front desk and reservations', () => {
    expect(hrefs({ serviceMode: 'tables', acceptsReservations: true })).toEqual(expect.arrayContaining(['/floor', '/host', '/reservations']));
  });
  it('counter and online-only venues drop the floor, front desk and reservations', () => {
    for (const serviceMode of ['counter', 'online']) {
      const h = hrefs({ serviceMode, acceptsReservations: false });
      expect(h).not.toContain('/floor');
      expect(h).not.toContain('/host');
      expect(h).not.toContain('/reservations');
      expect(h).toContain('/orders');
      expect(h).toContain('/menu');
    }
  });
  it('a table-service branch that takes no reservations hides only reservations', () => {
    const h = hrefs({ serviceMode: 'tables', acceptsReservations: false });
    expect(h).toContain('/floor');
    expect(h).not.toContain('/reservations');
  });
  it('an unknown branch (still loading) hides nothing', () => {
    expect(hrefs(undefined)).toHaveLength(items.length);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 22-TYPE: routing correctness. Every item opens a real route, is the one active item on its own URL (and in its own
// area), the Website studio and the QR codes hub keep their area, and old URLs still land somewhere sensible.
// ---------------------------------------------------------------------------------------------------------------
describe('navigation routing regression (22-TYPE)', () => {
  const ROLES = ['owner', 'manager', 'host', 'cashier', 'kitchen', 'marketing', 'accountant', 'waiter'] as const;
  const CONTEXTS = [
    { name: 'pro tables', modules: ALL_ON, plan: 'pro', branch: TABLES },
    { name: 'pro counter', modules: ALL_ON, plan: 'pro', branch: { serviceMode: 'counter', acceptsReservations: false } },
    { name: 'free', modules: ONLY_CORE, plan: 'free', branch: TABLES },
  ];
  const routes = new Set(dashboardRoutes());

  it('every item, for every role and plan, opens a dashboard route that exists', () => {
    const bad: string[] = [];
    for (const role of ROLES) for (const ctx of CONTEXTS) {
      for (const a of visibleAreas({ role, ...ctx })) for (const i of a.items) if (!routes.has(itemPath(i.href))) bad.push(`${role}/${ctx.name}: ${i.href}`);
    }
    expect(bad).toEqual([]);
  });

  it('on its own URL, every item is the one active item, in its own area (query included)', () => {
    const wrong: string[] = [];
    for (const role of ROLES) for (const ctx of CONTEXTS) {
      const areas = visibleAreas({ role, ...ctx });
      // The sidebar renders the primary areas and the Settings cluster as two lists: each list has at most one active
      // item, and the two lists never both have one.
      const primary = areas.filter((a) => a.key !== 'settings');
      const settings = areas.filter((a) => a.key === 'settings');
      for (const area of areas) for (const item of area.items) {
        const hit = activeItem(areas, item.href);
        if (hit?.item !== item || hit.area.key !== area.key) wrong.push(`${role}/${ctx.name}: ${item.href} → ${hit?.item.href ?? 'none'} (${hit?.area.key ?? '-'})`);
        const both = [activeItem(primary, item.href), activeItem(settings, item.href)].filter(Boolean);
        if (both.length !== 1) wrong.push(`${role}/${ctx.name}: ${item.href} active in ${both.length} lists`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('a page tab item is active only on its tab; the page item everywhere else on that page', () => {
    const areas = visibleAreas({ role: 'owner', modules: ALL_ON, plan: 'pro', branch: TABLES });
    const at = (p: string, q = '') => activeItem(areas, p, q)?.item.href;
    expect(at('/website')).toBe('/website');
    expect(at('/website', 'tab=domains')).toBe('/website?tab=domains');
    expect(at('/website?tab=domains')).toBe('/website?tab=domains');
    expect(at('/website', 'tab=domains&x=1')).toBe('/website?tab=domains');
    expect(at('/website', 'tab=design')).toBe('/website');
    expect(at('/website', 'tab=creative')).toBe('/website');
    expect(activeItem(areas, '/website', 'tab=domains')?.area.key).toBe('store');
  });

  it('the QR codes item has its own route in Menu & Store; the floor\'s QR tab stays with the floor', () => {
    const areas = visibleAreas({ role: 'owner', modules: ALL_ON, plan: 'pro', branch: TABLES });
    expect(activeItem(areas, '/qr')).toMatchObject({ area: { key: 'store' }, item: { href: '/qr', label: 'nav.qrCodes' } });
    expect(activeItem(areas, '/floor', 'tab=qr')).toMatchObject({ area: { key: 'operations' }, item: { href: '/floor' } });
    expect(activeItem(areas, '/floor', 'tab=studio')?.item.href).toBe('/floor');
    expect(routes.has('/qr')).toBe(true);
    // No navigation item points into another item's page any more except the Domains tab of the website studio.
    const tabItems = ALL_AREAS.flatMap((a) => a.items).filter((i) => i.href.includes('?')).map((i) => i.href);
    expect(tabItems).toEqual(['/website?tab=domains']);
  });

  it('names the website builder "Website studio" in both languages, and /studio redirects to it', async () => {
    const { dictionaries } = await import('./i18n/messages');
    expect(dictionaries.en['nav.studio']).toBe('Website studio');
    expect(dictionaries.ar['nav.studio']).toBe('استوديو الموقع');
    const { navRedirects } = await import('./nav-redirects');
    expect(navRedirects()).toContainEqual({ source: '/dashboard/:orgId/studio', destination: '/dashboard/:orgId/website', permanent: false });
    // Nothing else claims /studio (a real route there would shadow the redirect).
    expect(routes.has('/studio')).toBe(false);
  });

  it('the palette lists the QR codes hub and no stale floor-tab entry', () => {
    const areas = visibleAreas({ role: 'owner', modules: ALL_ON, plan: 'pro', branch: TABLES });
    const hrefs = pageEntries(areas, 'owner', t, { explore: false }).map((e) => e.href);
    expect(hrefs).toContain('/qr');
    expect(hrefs).not.toContain('/floor?tab=qr');
  });
});
