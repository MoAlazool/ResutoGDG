// Role → permission matrix. Single source of truth for the API guard, the
// dashboard (to hide actions) and MCP clients (which act with a non-owner role).
export const ROLES = ['owner', 'admin', 'manager', 'cashier', 'waiter', 'kitchen', 'host', 'marketing', 'accountant', 'driver'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'org:manage', 'branches:manage', 'members:manage', 'billing:manage', 'audit:read',
  'menu:read', 'menu:write', 'menu:availability',
  'floor:read', 'floor:write', 'floor:seat',
  'orders:read', 'orders:write', 'orders:status', 'orders:cancel',
  'kitchen:operate',
  'reservations:read', 'reservations:write',
  'inventory:read', 'inventory:write',
  'customers:read', 'customers:write', 'customers:export',
  'payments:read', 'payments:collect', 'payments:refund', 'payments:reconcile',
  'connect:read', 'connect:reply', 'connect:manage',
  'marketing:read', 'marketing:write', 'marketing:approve',
  'delivery:dispatch', 'delivery:drive',
  'studio:read', 'studio:write', 'studio:publish',
  'finance:read', 'finance:write',
  'compliance:read', 'compliance:write',
  'analytics:read', 'ai:use',
  'integrations:manage',
  'mcp:manage', 'mcp:approve',
  // 21-CS change sets: see the approvals inbox, approve or reject, and set the approval policy.
  'changes:read', 'changes:approve', 'changes:manage',
  // 21-POSAPI: pair, list and revoke native POS devices (owner, admin, manager).
  'devices:manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const all = [...PERMISSIONS];
const without = (...excluded: Permission[]) => all.filter((p) => !excluded.includes(p));

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: all,
  admin: without('billing:manage'),
  manager: without('org:manage', 'billing:manage', 'members:manage', 'integrations:manage', 'mcp:manage', 'delivery:drive', 'customers:export',
    'changes:manage'),
  cashier: ['menu:read', 'menu:availability', 'floor:read', 'floor:seat', 'orders:read', 'orders:write', 'orders:status',
    'reservations:read', 'reservations:write', 'customers:read', 'payments:read', 'payments:collect'],
  waiter: ['menu:read', 'menu:availability', 'floor:read', 'floor:seat', 'orders:read', 'orders:write', 'orders:status',
    'reservations:read', 'customers:read', 'payments:collect'],
  kitchen: ['menu:read', 'menu:availability', 'orders:read', 'orders:status', 'kitchen:operate', 'inventory:read'],
  host: ['floor:read', 'floor:seat', 'reservations:read', 'reservations:write', 'customers:read', 'orders:read'],
  marketing: ['menu:read', 'customers:read', 'marketing:read', 'marketing:write', 'marketing:approve', 'connect:read', 'connect:reply',
    'studio:read', 'studio:write', 'studio:publish', 'analytics:read', 'ai:use', 'changes:read', 'changes:approve'],
  accountant: ['orders:read', 'payments:read', 'payments:reconcile', 'finance:read', 'finance:write', 'compliance:read',
    'compliance:write', 'analytics:read', 'audit:read'],
  driver: ['delivery:drive'],
};

/** Roles that may override an operational safeguard, e.g. force-close a visit that is not settled (API and dashboard). */
export const MANAGER_ROLES: readonly Role[] = ['owner', 'admin', 'manager'];

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** Roles a member may assign: never above their own role. */
export function assignableRoles(role: Role): Role[] {
  if (role === 'owner') return ROLES.filter((r) => r !== 'owner');
  if (role === 'admin') return ROLES.filter((r) => r !== 'owner' && r !== 'admin');
  return [];
}
