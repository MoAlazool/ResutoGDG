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
  /** Starts a new group in the SectionNav (a divider before the first link of a group). */
  group?: string;
}

export const FINANCE_SECTIONS: SectionLink[] = [
  { href: '/finance', label: 'finance.nav.overview' },
  { href: '/finance/pnl', label: 'finance.nav.pnl' },
  { href: '/finance/expenses', label: 'finance.nav.expenses' },
  { href: '/finance/exports', label: 'finance.nav.exports' },
];

/**
 * The Insights area (21-INSIGHTS): analytics (measured from the restaurant's own records) then intelligence (findings,
 * forecasts and models), one SectionNav for both. Routes: lib/insights.ts INSIGHTS_PATHS. The former Analytics tabs
 * (`/analytics?tab=…`) redirect to these routes and `/intelligence/customers` (segments and churn) merged into
 * Customers. The Copilot assistant (`/intelligence/assistant`) belongs to AI & Apps, not here.
 */
export const INSIGHTS_SECTIONS: SectionLink[] = [
  { href: '/analytics', label: 'insights.area.overview', permission: 'analytics:read' },
  { href: '/analytics/sales', label: 'insights.area.sales', permission: 'analytics:read' },
  { href: '/analytics/menu', label: 'insights.area.menu', permission: 'analytics:read' },
  { href: '/analytics/customers', label: 'insights.area.customers', permission: 'analytics:read' },
  { href: '/analytics/funnel', label: 'insights.analytics.tab.funnel', permission: 'analytics:read' },
  { href: '/analytics/retention', label: 'insights.analytics.tab.retention', permission: 'analytics:read' },
  { href: '/analytics/ratings', label: 'insights.area.ratings', permission: 'analytics:read' },
  { href: '/analytics/marketing', label: 'insights.area.marketing', permission: 'analytics:read' },
  { href: '/analytics/operations', label: 'insights.area.operations', permission: 'analytics:read' },
  { href: '/analytics/sustainability', label: 'insights.area.sustainability', permission: 'analytics:read' },
  { href: '/analytics/roi', label: 'insights.area.roi', permission: 'analytics:read' },
  { href: '/intelligence', label: 'insights.area.findings', permission: 'ai:use', module: 'intelligence', group: 'intelligence' },
  { href: '/intelligence/forecast', label: 'insights.area.forecast', permission: 'ai:use', module: 'intelligence', group: 'intelligence' },
  { href: '/intelligence/recommendations', label: 'insights.area.recommendations', permission: 'ai:use', module: 'intelligence', group: 'intelligence' },
  { href: '/intelligence/research', label: 'insights.area.research', permission: 'ai:use', module: 'intelligence', group: 'intelligence' },
  { href: '/intelligence/routes', label: 'insights.area.routes', permission: 'delivery:dispatch', module: 'intelligence', group: 'intelligence' },
];
/** The analytics part of the Insights sections (under the Analytics navigation item). */
export const ANALYTICS_SECTIONS = INSIGHTS_SECTIONS.filter((s) => s.href.startsWith('/analytics'));
/** The intelligence part (under the Intelligence navigation item). */
export const INTELLIGENCE_SECTIONS = INSIGHTS_SECTIONS.filter((s) => s.href.startsWith('/intelligence'));

export const MCP_SECTIONS: SectionLink[] = [
  { href: '/mcp', label: 'mcp.tab.clients', permission: 'mcp:manage' },
  { href: '/mcp/approvals', label: 'mcp.tab.approvals', permission: 'mcp:approve' },
  { href: '/mcp/calls', label: 'mcp.tab.calls', permission: 'mcp:manage' },
  { href: '/mcp/connect', label: 'mcp.tab.connect', anyPermission: ['mcp:manage', 'mcp:approve'] },
  { href: '/approvals', label: 'mcp.tab.inbox', permission: 'changes:read' },
];

/**
 * The Settings cluster: the restaurant (org:manage), Messaging, which holds the Inbox's channels and templates
 * (21-INBOX), iPad devices (22-DEVICES: POS pairing), and the pages of the sidebar's Settings group (21-MONEY: one SettingsPage template for team, plan &
 * billing, data and the audit log; same permissions as their navigation items in lib/nav.ts SETTINGS_AREA).
 */
export const SETTINGS_SECTIONS: SectionLink[] = [
  { href: '/settings', label: 'nav.settings', permission: 'org:manage' },
  { href: '/settings/messaging', label: 'nav.messaging', permission: 'connect:read', module: 'connect' },
  { href: '/settings/devices', label: 'nav.devices', permission: 'devices:manage' },
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
