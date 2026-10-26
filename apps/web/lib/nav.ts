import type { ModuleKey, Permission, Role, ServiceMode } from '@resuto/contracts';
import { can } from '@resuto/contracts/lite';

/**
 * Staff navigation (21-SHELL, plan §3): seven primary areas, each with its own secondary list, and a Settings cluster
 * in the sidebar footer. Every dashboard route is reachable from here (an item, or a section/page action of an item:
 * lib/shell.test.ts checks it). Locked modules are never shown as disabled entries: they are listed on the Explore
 * page instead. The Free (QR menu) plan gets a reduced shell (`free` items only).
 */

/** Icon names of the shell's areas (components/shell/shell-icons.tsx draws them; secondary items are text only). */
export type ShellIconName = 'home' | 'operations' | 'store' | 'customers' | 'money' | 'insights' | 'apps' | 'settings' | 'explore';

export type AreaKey = 'home' | 'operations' | 'store' | 'customers' | 'money' | 'insights' | 'apps' | 'settings';

export interface NavItem {
  /** Relative to /dashboard/[orgId]; may carry a query (a tab of a page). */
  href: string;
  /** i18n key. */
  label: string;
  module: ModuleKey;
  permission?: Permission;
  /** Visible when the role has any of these (used instead of `permission`). */
  anyPermission?: Permission[];
  /**
   * Service models the entry belongs to (VS-16: counter and online-only venues drop the floor and reservations;
   * reservations also need "Accept table reservations"). Omitted = every model.
   */
  modes?: ServiceMode[];
  /** Hidden when the current branch takes no table reservations. */
  needsReservations?: boolean;
  /** Part of the Free (QR menu) shell. */
  free?: boolean;
  /** Label in the Free shell (i18n key). */
  freeLabel?: string;
  /**
   * Other routes that belong to this item (highlighted under it): routes reached from its page that do not share its
   * path prefix. Sub-routes under the item's own path (/finance/pnl) belong to it already. The palette's list of
   * sections and page actions per item is lib/palette-entries.ts PALETTE_SUBS.
   */
  also?: string[];
  /** `g` + this letter opens the item (ShortcutsProvider). Palette search words: lib/palette-keywords.ts. */
  shortcut?: string;
}

export interface NavArea { key: AreaKey; label: string; icon: ShellIconName; items: NavItem[] }

/** The seven primary areas (plan §3). */
export const AREAS: NavArea[] = [
  { key: 'home', label: 'nav.area.home', icon: 'home', items: [
    { href: '', label: 'nav.overview', module: 'core', permission: 'analytics:read', free: true, shortcut: 'h' },
    { href: '/setup', label: 'nav.setupGuide', module: 'core', permission: 'org:manage', free: true },
    { href: '/notifications', label: 'notifications.title', module: 'core', free: true },
  ] },
  { key: 'operations', label: 'nav.area.operations', icon: 'operations', items: [
    { href: '/orders', label: 'nav.orders', module: 'core', permission: 'orders:read', shortcut: 'o' },
    { href: '/kitchen', label: 'nav.kitchen', module: 'core', permission: 'kitchen:operate', shortcut: 'k' },
    { href: '/floor', label: 'nav.floorTables', module: 'core', permission: 'floor:read', modes: ['tables'] },
    { href: '/host', label: 'ops.host.nav', module: 'core', permission: 'floor:seat', modes: ['tables'] },
    { href: '/reservations', label: 'nav.reservations', module: 'core', permission: 'reservations:read', modes: ['tables'], needsReservations: true },
    { href: '/delivery', label: 'nav.delivery', module: 'driver', permission: 'delivery:dispatch' },
    { href: '/inventory', label: 'nav.inventory', module: 'core', permission: 'inventory:read' },
  ] },
  { key: 'store', label: 'nav.area.store', icon: 'store', items: [
    { href: '/menu', label: 'nav.menu', module: 'core', permission: 'menu:read', free: true, shortcut: 'm', also: ['/menu-import'] },
    // 22-TYPE: one name for the website builder ("Website studio", the page's own title is Website); /studio redirects here.
    { href: '/website', label: 'nav.studio', module: 'studio', permission: 'studio:read', free: true, freeLabel: 'nav.storeDesign' },
    { href: '/studio-media', label: 'nav.foodPhotos', module: 'studio', permission: 'studio:read' },
    // The QR codes hub has its own route in this area (it used to open the floor's QR tab, which highlighted Operations
    // and showed the front-of-house tabs). The floor keeps its "Table QR codes" tab for staff working on the floor.
    { href: '/qr', label: 'nav.qrCodes', module: 'core', permission: 'floor:write', free: true },
    { href: '/website?tab=domains', label: 'nav.domains', module: 'studio', permission: 'studio:read' },
  ] },
  { key: 'customers', label: 'nav.area.customers', icon: 'customers', items: [
    { href: '/inbox', label: 'nav.inbox', module: 'connect', permission: 'connect:read', shortcut: 'i' },
    { href: '/customers', label: 'nav.customers', module: 'core', permission: 'customers:read', shortcut: 'c' },
    { href: '/loyalty', label: 'nav.loyalty', module: 'marketing', permission: 'marketing:read' },
    { href: '/marketing', label: 'nav.marketingGrowth', module: 'marketing', permission: 'marketing:read' },
  ] },
  { key: 'money', label: 'nav.area.money', icon: 'money', items: [
    { href: '/payments', label: 'nav.payments', module: 'pay', permission: 'payments:read', shortcut: 'p' },
    { href: '/finance', label: 'nav.finance', module: 'finance', permission: 'finance:read' },
    { href: '/compliance', label: 'nav.compliance', module: 'compliance', permission: 'compliance:read' },
  ] },
  { key: 'insights', label: 'nav.area.insights', icon: 'insights', items: [
    { href: '/analytics', label: 'nav.analytics', module: 'core', permission: 'analytics:read', shortcut: 'a' },
    { href: '/intelligence', label: 'nav.intelligence', module: 'intelligence', permission: 'ai:use' },
  ] },
  { key: 'apps', label: 'nav.area.apps', icon: 'apps', items: [
    { href: '/intelligence/assistant', label: 'nav.copilot', module: 'intelligence', permission: 'ai:use' },
    { href: '/mcp', label: 'nav.mcp', module: 'mcp', anyPermission: ['mcp:manage', 'mcp:approve'] },
    // 21-MCP: the cross-feature approvals inbox (MCP, Studio AI, copilot and staff change sets).
    { href: '/approvals', label: 'nav.approvals', module: 'core', permission: 'changes:read' },
    { href: '/integrations', label: 'nav.integrations', module: 'core', permission: 'integrations:manage' },
  ] },
];

/** The Settings cluster in the sidebar footer. */
export const SETTINGS_AREA: NavArea = { key: 'settings', label: 'nav.group.settings', icon: 'settings', items: [
  { href: '/settings', label: 'nav.settings', module: 'core', permission: 'org:manage', free: true, shortcut: 's' },
  { href: '/team', label: 'nav.teamRoles', module: 'core', permission: 'members:manage', free: true },
  { href: '/billing', label: 'nav.billing', module: 'core', permission: 'billing:manage', free: true },
  { href: '/data', label: 'nav.dataImportExport', module: 'core', anyPermission: ['menu:write', 'customers:export', 'finance:read'], free: true },
  { href: '/audit', label: 'nav.audit', module: 'core', permission: 'audit:read', free: true },
] };

/** The Explore Resuto page: modules outside the plan, as previews with an upgrade action. */
export const EXPLORE_ITEM: NavItem = { href: '/explore', label: 'nav.explore', module: 'core', free: true };

/** Every area including the Settings cluster (for lookups, the palette and shortcuts). */
export const ALL_AREAS: NavArea[] = [...AREAS, SETTINGS_AREA];

/** @deprecated grouping kept for older imports: the areas as { group, items }. */
export const NAV: Array<{ group: string; items: NavItem[] }> = ALL_AREAS.map((a) => ({ group: a.label, items: a.items }));

export const navVisible = (item: { permission?: Permission; anyPermission?: Permission[] }, role: Role) =>
  item.anyPermission ? item.anyPermission.some((p) => can(role, p)) : !item.permission || can(role, item.permission);

/** Whether an entry applies to the branch's service model (VS-16). Unknown mode = table service (the default). */
export const navForBranch = (item: NavItem, branch: { serviceMode?: string | null; acceptsReservations?: boolean } | null | undefined) => {
  if (!branch) return true;
  const mode = (branch.serviceMode ?? 'tables') as ServiceMode;
  if (item.modes && !item.modes.includes(mode)) return false;
  if (item.needsReservations && branch.acceptsReservations === false) return false;
  return true;
};

export type Modules = Partial<Record<ModuleKey, boolean>> | null;

/** Module enabled for the restaurant. Unknown entitlements (endpoint unavailable) count as enabled: the API enforces. */
export const moduleOn = (modules: Modules, m: ModuleKey) => modules === null || modules[m] !== false;

/**
 * The Free (QR menu) shell: the plan is `free`, or the entitlements include nothing beyond core. Unknown
 * entitlements are not Free (the full shell is shown and the API enforces).
 */
export function isFreeShell(plan: string | null | undefined, modules: Modules): boolean {
  if (plan === 'free') return true;
  if (!modules) return false;
  const on = Object.entries(modules).filter(([, v]) => v).map(([k]) => k);
  return on.length > 0 && on.every((k) => k === 'core');
}

export interface ShellContext {
  role: Role;
  modules: Modules;
  plan?: string | null;
  /** The branch the shell is on (its service model drives the operations items). */
  branch?: { serviceMode?: string | null; acceptsReservations?: boolean } | null;
}

/**
 * The navigation a member sees: role permissions, the branch's service model, and the plan. In a paid shell, items of
 * modules the plan does not include are left out (they appear on Explore); in the Free shell only `free` items show,
 * because they are the Free offer (the website item opens the Studio preview until 21-ONB ships Studio basic).
 */
export function visibleAreas(ctx: ShellContext): NavArea[] {
  const free = isFreeShell(ctx.plan, ctx.modules);
  return ALL_AREAS.map((a) => ({
    ...a,
    items: a.items
      .filter((i) => navVisible(i, ctx.role) && navForBranch(i, ctx.branch))
      .filter((i) => (free ? !!i.free : moduleOn(ctx.modules, i.module)))
      .map((i) => (free && i.freeLabel ? { ...i, label: i.freeLabel } : i)),
  })).filter((a) => a.items.length > 0);
}

/** Items the member's role could use but the plan does not include: the Explore page lists them. */
export function lockedItems(ctx: ShellContext): NavItem[] {
  const free = isFreeShell(ctx.plan, ctx.modules);
  const seen = new Set<string>();
  const out: NavItem[] = [];
  for (const a of ALL_AREAS) {
    for (const i of a.items) {
      if (!navVisible(i, ctx.role) || seen.has(i.href)) continue;
      const locked = free ? !i.free : !moduleOn(ctx.modules, i.module);
      if (locked) { seen.add(i.href); out.push(i); }
    }
  }
  return out;
}

/** Path of an item without its query ("/website?tab=domains" → "/website"). */
export const itemPath = (href: string) => href.split('?')[0]!;

/** The query of an item's href as pairs ("/website?tab=domains" → [["tab", "domains"]]). */
const itemQuery = (href: string): Array<[string, string]> => {
  const q = href.split('?')[1];
  return q ? [...new URLSearchParams(q).entries()] : [];
};

/**
 * The item a page belongs to: the item, or one of its sub-routes, whose route is the longest prefix of the path. An
 * item with a query (a tab of a page, "/website?tab=domains") matches only when the current query has its parameters,
 * and then wins over the item of the page itself; without them it never matches. `path` is relative to the restaurant
 * and may carry the query ("/website?tab=domains"); `search` is the query of the current URL when `path` has none.
 * At most one item is active for any URL (lib/shell.test.ts checks every item).
 */
export function activeItem(areas: NavArea[], path: string, search = ''): { area: NavArea; item: NavItem } | null {
  const [bare, inline] = path.split('?') as [string, string | undefined];
  const params = new URLSearchParams(inline ?? search);
  let best: { area: NavArea; item: NavItem; len: number; exact: boolean } | null = null;
  const consider = (area: NavArea, item: NavItem, href: string, exact: boolean) => {
    const p = itemPath(href);
    const hit = p === '' ? bare === '' : bare === p || bare.startsWith(`${p}/`);
    if (!hit) return;
    const query = itemQuery(href);
    if (query.some(([k, v]) => params.get(k) !== v)) return;
    // A matching query is more specific than the page alone, but never more than a longer path.
    const len = p.length + (query.length ? 0.5 : 0);
    if (!best || len > best.len || (len === best.len && exact && !best.exact)) best = { area, item, len, exact };
  };
  for (const area of areas) {
    for (const item of area.items) {
      consider(area, item, item.href, true);
      for (const p of item.also ?? []) consider(area, item, p, false);
    }
  }
  const b = best as { area: NavArea; item: NavItem } | null;
  return b ? { area: b.area, item: b.item } : null;
}

/** Role-aware landing (VS-05) lives in its own module so the sign-in pages do not import the navigation table. */
export { homePath } from './home-path';

/** Active-order statuses counted in the Orders navigation badge (as the legacy workspace did). */
export const ACTIVE_ORDER_STATUSES = 'awaiting_payment,placed,accepted,preparing,ready';

/** Post-sign-in redirect validation lives in a dependency-free module so session.tsx can share it. */
export { safeNext } from './safe-next';
