// Command palette entries (21-SHELL): every page the member can open (navigation items and their sections/page
// actions) and the shell actions. Pure, so lib/shell.test.ts can check that every dashboard route is reachable.
import type { Permission, Role } from '@resuto/contracts';
import { can } from '@resuto/contracts/lite';
import { EXPLORE_ITEM, navVisible, type NavArea } from './nav';
import { PALETTE_KEYWORDS } from './palette-keywords';
import { FINANCE_SECTIONS, INTELLIGENCE_SECTIONS, MCP_SECTIONS, type SectionLink } from './sections';

export type PaletteAction = 'signOut' | 'language' | 'branches';

export interface PaletteEntry {
  id: string;
  kind: 'page' | 'action' | 'branch' | 'record';
  /** Visible text (already translated). */
  label: string;
  /** Secondary text: the area of a page, the type of a record. */
  hint?: string;
  /** English search words (the label is matched in the page language). */
  keywords?: string;
  /** Relative to /dashboard/[orgId] for pages and page actions; absolute for records. */
  href?: string;
  action?: PaletteAction;
  /** Branch entries: the branch id, or null for "All branches". */
  branchId?: string | null;
}

type T = (key: string, vars?: Record<string, string | number>) => string;

/**
 * Routes reached from an item's page (its SectionNav sections or page actions), by item href: the palette lists them
 * under the item ("Finance › P&L"), so every dashboard route is one palette search away.
 */
export const PALETTE_SUBS: Record<string, SectionLink[]> = {
  '/menu': [{ href: '/menu-import', label: 'nav.menuImport', permission: 'menu:write' }],
  '/finance': FINANCE_SECTIONS.slice(1),
  '/intelligence': INTELLIGENCE_SECTIONS.filter((s) => s.href !== '/intelligence' && s.href !== '/intelligence/assistant'),
  '/mcp': [...MCP_SECTIONS.slice(1), { href: '/mcp/new', label: 'mcp.clients.new', permission: 'mcp:manage' }],
};

/** Pages: each visible item, then the sections and page actions under it ("Finance › P&L"). */
export function pageEntries(areas: NavArea[], role: Role, t: T, opts: { explore?: boolean } = {}): PaletteEntry[] {
  const out: PaletteEntry[] = [];
  for (const area of areas) {
    for (const item of area.items) {
      out.push({ id: `page:${item.href}`, kind: 'page', label: t(item.label), hint: t(area.label), keywords: PALETTE_KEYWORDS[item.href], href: item.href });
      for (const s of PALETTE_SUBS[item.href] ?? []) {
        if (!navVisible(s, role)) continue;
        out.push({ id: `page:${s.href}`, kind: 'page', label: `${t(item.label)} › ${t(s.label)}`, hint: t(area.label), keywords: `${PALETTE_KEYWORDS[item.href] ?? ''} ${PALETTE_KEYWORDS[s.href] ?? ''}`, href: s.href });
      }
    }
  }
  if (opts.explore) out.push({ id: 'page:/explore', kind: 'page', label: t(EXPLORE_ITEM.label), keywords: PALETTE_KEYWORDS[EXPLORE_ITEM.href], href: EXPLORE_ITEM.href });
  return out;
}

export interface ActionContext {
  role: Role;
  /** The pages the member can see (an action is offered only where its page is in the navigation). */
  hrefs: Set<string>;
  multiBranch: boolean;
}

const ACTIONS: Array<{ id: string; label: string; keywords: string; href?: string; page?: string; permission?: Permission; action?: PaletteAction }> = [
  { id: 'new-order', label: 'palette.action.newOrder', keywords: 'new order create add ticket', href: '/orders?new=1', page: '/orders', permission: 'orders:write' },
  { id: 'new-reservation', label: 'palette.action.newReservation', keywords: 'new reservation booking book table', href: '/reservations?new=1', page: '/reservations', permission: 'reservations:write' },
  { id: 'invite', label: 'palette.action.inviteMember', keywords: 'invite member staff team add user', href: '/team?invite=1', page: '/team', permission: 'members:manage' },
  { id: 'branches', label: 'palette.action.switchBranch', keywords: 'switch branch location change', action: 'branches' },
  { id: 'language', label: 'palette.action.switchLanguage', keywords: 'language arabic english switch lang', action: 'language' },
  { id: 'sign-out', label: 'palette.action.signOut', keywords: 'sign out log out logout exit', action: 'signOut' },
];

/** Shell actions the member can use. */
export function actionEntries(ctx: ActionContext, t: T): PaletteEntry[] {
  return ACTIONS
    .filter((a) => (!a.permission || can(ctx.role, a.permission)) && (!a.page || ctx.hrefs.has(a.page)) && (a.action !== 'branches' || ctx.multiBranch))
    .map((a) => ({ id: `action:${a.id}`, kind: 'action' as const, label: t(a.label), keywords: a.keywords, href: a.href, action: a.action }));
}
