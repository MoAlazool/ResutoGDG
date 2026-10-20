import { can, ROLES, type Role } from '@resuto/contracts';

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
