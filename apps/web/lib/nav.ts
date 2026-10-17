import type { ModuleKey, Permission } from '@resuto/contracts';

export interface NavItem {
  href: string;           // relative to /dashboard/[orgId]
  label: string;          // i18n key
  icon: string;
  module: ModuleKey;
  permission?: Permission;
  /** Visible when the role has any of these (used instead of `permission`). */
  anyPermission?: Permission[];
}

/** Dashboard navigation. Each entry's page directory is owned by one agent (MODULE_CONTRACTS.md). */
export const NAV: Array<{ group: string; items: NavItem[] }> = [
  { group: 'nav.group.operations', items: [
    { href: '', label: 'nav.overview', icon: '◎', module: 'core', permission: 'analytics:read' },
    { href: '/orders', label: 'nav.orders', icon: '🧾', module: 'core', permission: 'orders:read' },
    { href: '/kitchen', label: 'nav.kitchen', icon: '🔥', module: 'core', permission: 'kitchen:operate' },
    { href: '/floor', label: 'nav.floor', icon: '▦', module: 'core', permission: 'floor:read' },
    { href: '/reservations', label: 'nav.reservations', icon: '📅', module: 'core', permission: 'reservations:read' },
    { href: '/menu', label: 'nav.menu', icon: '🍽', module: 'core', permission: 'menu:read' },
    { href: '/inventory', label: 'nav.inventory', icon: '📦', module: 'core', permission: 'inventory:read' },
    { href: '/delivery', label: 'nav.delivery', icon: '🛵', module: 'driver', permission: 'delivery:dispatch' },
  ] },
  { group: 'nav.group.customers', items: [
    { href: '/customers', label: 'nav.customers', icon: '👥', module: 'core', permission: 'customers:read' },
    { href: '/inbox', label: 'nav.inbox', icon: '💬', module: 'connect', permission: 'connect:read' },
    { href: '/marketing', label: 'nav.marketing', icon: '📣', module: 'marketing', permission: 'marketing:read' },
    { href: '/website', label: 'nav.website', icon: '🌐', module: 'studio', permission: 'studio:read' },
  ] },
  { group: 'nav.group.money', items: [
    { href: '/payments', label: 'nav.payments', icon: '💳', module: 'pay', permission: 'payments:read' },
    { href: '/finance', label: 'nav.finance', icon: '📊', module: 'finance', permission: 'finance:read' },
    { href: '/compliance', label: 'nav.compliance', icon: '🛡', module: 'compliance', permission: 'compliance:read' },
  ] },
  { group: 'nav.group.intelligence', items: [
    { href: '/analytics', label: 'nav.analytics', icon: '📈', module: 'core', permission: 'analytics:read' },
    { href: '/intelligence', label: 'nav.intelligence', icon: '✦', module: 'intelligence', permission: 'ai:use' },
    { href: '/mcp', label: 'nav.mcp', icon: '⇄', module: 'mcp', anyPermission: ['mcp:manage', 'mcp:approve'] },
  ] },
  { group: 'nav.group.settings', items: [
    { href: '/settings', label: 'nav.settings', icon: '⚙', module: 'core', permission: 'org:manage' },
    { href: '/team', label: 'nav.team', icon: '🪪', module: 'core', permission: 'members:manage' },
    { href: '/integrations', label: 'nav.integrations', icon: '🔌', module: 'core', permission: 'integrations:manage' },
    { href: '/billing', label: 'nav.billing', icon: '★', module: 'core', permission: 'billing:manage' },
    { href: '/audit', label: 'nav.audit', icon: '☰', module: 'core', permission: 'audit:read' },
  ] },
];
