import { can, ROLES, type ModuleKey, type Permission, type Role } from '@resuto/contracts';
import type { NavGlyphName } from '@resuto/ui';

export interface NavItem {
  href: string;           // relative to /dashboard/[orgId]
  label: string;          // i18n key
  /** Monochrome glyph from the legacy workspace set (@resuto/ui NAV_GLYPHS); never colour emoji. */
  glyph: NavGlyphName;
  module: ModuleKey;
  permission?: Permission;
  /** Visible when the role has any of these (used instead of `permission`). */
  anyPermission?: Permission[];
}

/** Dashboard navigation. Each entry's page directory is owned by one agent (MODULE_CONTRACTS.md). */
export const NAV: Array<{ group: string; items: NavItem[] }> = [
  { group: 'nav.group.operations', items: [
    { href: '', label: 'nav.overview', glyph: 'overview', module: 'core', permission: 'analytics:read' },
    { href: '/orders', label: 'nav.orders', glyph: 'orders', module: 'core', permission: 'orders:read' },
    { href: '/kitchen', label: 'nav.kitchen', glyph: 'kitchen', module: 'core', permission: 'kitchen:operate' },
    { href: '/floor', label: 'nav.floor', glyph: 'floor', module: 'core', permission: 'floor:read' },
    { href: '/reservations', label: 'nav.reservations', glyph: 'reservations', module: 'core', permission: 'reservations:read' },
    { href: '/menu', label: 'nav.menu', glyph: 'menu', module: 'core', permission: 'menu:read' },
    { href: '/inventory', label: 'nav.inventory', glyph: 'inventory', module: 'core', permission: 'inventory:read' },
    { href: '/delivery', label: 'nav.delivery', glyph: 'delivery', module: 'driver', permission: 'delivery:dispatch' },
  ] },
  { group: 'nav.group.customers', items: [
    { href: '/customers', label: 'nav.customers', glyph: 'customers', module: 'core', permission: 'customers:read' },
    { href: '/inbox', label: 'nav.inbox', glyph: 'inbox', module: 'connect', permission: 'connect:read' },
    { href: '/marketing', label: 'nav.marketing', glyph: 'marketing', module: 'marketing', permission: 'marketing:read' },
    { href: '/website', label: 'nav.website', glyph: 'website', module: 'studio', permission: 'studio:read' },
  ] },
  { group: 'nav.group.money', items: [
    { href: '/payments', label: 'nav.payments', glyph: 'payments', module: 'pay', permission: 'payments:read' },
    { href: '/finance', label: 'nav.finance', glyph: 'finance', module: 'finance', permission: 'finance:read' },
    { href: '/compliance', label: 'nav.compliance', glyph: 'compliance', module: 'compliance', permission: 'compliance:read' },
  ] },
  { group: 'nav.group.intelligence', items: [
    { href: '/analytics', label: 'nav.analytics', glyph: 'analytics', module: 'core', permission: 'analytics:read' },
    { href: '/intelligence', label: 'nav.intelligence', glyph: 'intelligence', module: 'intelligence', permission: 'ai:use' },
    { href: '/mcp', label: 'nav.mcp', glyph: 'mcp', module: 'mcp', anyPermission: ['mcp:manage', 'mcp:approve'] },
  ] },
  { group: 'nav.group.settings', items: [
    { href: '/settings', label: 'nav.settings', glyph: 'settings', module: 'core', permission: 'org:manage' },
    { href: '/team', label: 'nav.team', glyph: 'team', module: 'core', permission: 'members:manage' },
    { href: '/integrations', label: 'nav.integrations', glyph: 'integrations', module: 'core', permission: 'integrations:manage' },
    { href: '/billing', label: 'nav.billing', glyph: 'billing', module: 'core', permission: 'billing:manage' },
    { href: '/audit', label: 'nav.audit', glyph: 'audit', module: 'core', permission: 'audit:read' },
  ] },
];

export const navVisible = (item: NavItem, role: Role) =>
  item.anyPermission ? item.anyPermission.some((p) => can(role, p)) : !item.permission || can(role, item.permission);

/**
 * Where a staff member lands after signing in or opening /dashboard, by role (VS-05): the kitchen team on the
 * full-screen kitchen display, drivers on the driver app, the front desk on the live floor (its front-desk screen
 * when that route exists), cashiers on orders, waiters on the floor, everyone with analytics on the overview.
 */
export function homePath(role: Role | string, orgId: string): string {
  const base = `/dashboard/${orgId}`;
  if (!(ROLES as readonly string[]).includes(role)) return base;
  switch (role as Role) {
    case 'kitchen': return `/kitchen/${orgId}`;
    case 'driver': return '/driver';
    case 'host': return `${base}/floor`;
    case 'waiter': return `${base}/floor`;
    case 'cashier': return `${base}/orders`;
    default: return can(role as Role, 'analytics:read') ? base : `${base}/orders`;
  }
}

/** Active-order statuses counted in the Orders navigation badge (as the legacy workspace did). */
export const ACTIVE_ORDER_STATUSES = 'awaiting_payment,placed,accepted,preparing,ready';

/** Post-sign-in redirect validation lives in a dependency-free module so session.tsx can share it. */
export { safeNext } from './safe-next';
