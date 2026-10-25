import type { ModuleKey, Permission } from '@resuto/contracts';

/**
 * Sub-navigation of the areas that span several routes (21-SHELL `SectionNav`): one definition per area, used by the
 * page's SectionNav, by the sidebar (the routes highlight their area item) and by the command palette. `href` is
 * relative to /dashboard/[orgId]; `label` is an i18n key.
 */
export interface SectionLink {
  href: string;
  label: string;
  permission?: Permission;
  anyPermission?: Permission[];
  module?: ModuleKey;
}

export const FINANCE_SECTIONS: SectionLink[] = [
  { href: '/finance', label: 'finance.nav.overview' },
  { href: '/finance/pnl', label: 'finance.nav.pnl' },
  { href: '/finance/expenses', label: 'finance.nav.expenses' },
  { href: '/finance/exports', label: 'finance.nav.exports' },
];

export const INTELLIGENCE_SECTIONS: SectionLink[] = [
  { href: '/intelligence', label: 'intelligence.tab.insights' },
  { href: '/intelligence/forecast', label: 'intelligence.tab.forecast' },
  { href: '/intelligence/customers', label: 'intelligence.tab.customers' },
  { href: '/intelligence/recommendations', label: 'intelligence.tab.recommendations' },
  { href: '/intelligence/routes', label: 'intelligence.tab.routes', permission: 'delivery:dispatch' },
  { href: '/intelligence/assistant', label: 'intelligence.tab.assistant' },
  { href: '/intelligence/research', label: 'intelligence.tab.research' },
];

export const MCP_SECTIONS: SectionLink[] = [
  { href: '/mcp', label: 'mcp.tab.clients', permission: 'mcp:manage' },
  { href: '/mcp/approvals', label: 'mcp.tab.approvals', permission: 'mcp:approve' },
  { href: '/mcp/calls', label: 'mcp.tab.calls', permission: 'mcp:manage' },
  { href: '/mcp/connect', label: 'mcp.tab.connect', anyPermission: ['mcp:manage', 'mcp:approve'] },
  { href: '/approvals', label: 'mcp.tab.inbox', permission: 'changes:read' },
];

/**
 * The Settings cluster: the restaurant (org:manage), Messaging, which holds the Inbox's channels and templates
 * (21-INBOX), and the pages of the sidebar's Settings group (21-MONEY: one SettingsPage template for team, plan &
 * billing, data and the audit log; same permissions as their navigation items in lib/nav.ts SETTINGS_AREA).
 */
export const SETTINGS_SECTIONS: SectionLink[] = [
  { href: '/settings', label: 'nav.settings', permission: 'org:manage' },
  { href: '/settings/messaging', label: 'nav.messaging', permission: 'connect:read', module: 'connect' },
  { href: '/team', label: 'nav.teamRoles', permission: 'members:manage' },
  { href: '/billing', label: 'nav.billing', permission: 'billing:manage' },
  { href: '/data', label: 'nav.dataImportExport', anyPermission: ['menu:write', 'customers:export', 'finance:read'] },
  { href: '/audit', label: 'nav.audit', permission: 'audit:read' },
];

/**
 * Front of house (21-OPS): the floor, the front desk and reservations share one live map and one set of tabs, so the
 * three screens read as one area. Table-service branches only (the pages' nav items carry the same rule).
 */
export const FRONT_OF_HOUSE_SECTIONS: SectionLink[] = [
  { href: '/floor', label: 'nav.floorTables', permission: 'floor:read' },
  { href: '/host', label: 'ops.host.nav', permission: 'floor:seat' },
  { href: '/reservations', label: 'nav.reservations', permission: 'reservations:read' },
];

/** The section whose route is the longest prefix of `path` (relative to the restaurant), or null. */
export function activeSection(sections: SectionLink[], path: string): SectionLink | null {
  let best: SectionLink | null = null;
  for (const s of sections) {
    if ((path === s.href || path.startsWith(`${s.href}/`)) && (!best || s.href.length > best.href.length)) best = s;
  }
  return best;
}
