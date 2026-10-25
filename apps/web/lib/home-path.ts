import type { Role } from '@resuto/contracts';
import { can, ROLES } from '@resuto/contracts/lite';

/**
 * Where a staff member lands after signing in or opening /dashboard, by role (VS-05): the kitchen team on the
 * full-screen kitchen display, drivers on the driver app, the front desk on the live floor (its front-desk screen
 * when that route exists), cashiers on orders, waiters on the floor, everyone with analytics on the overview.
 */
/**
 * Older links to the kitchen display carried this query (PAR-05, when managers saw the display inside the workspace);
 * it is still accepted and changes nothing.
 */
export const KDS_FULL_PARAM = 'display=full';

/**
 * Where the kitchen display opens (21-OPS, plan §5 "one route"): the full-screen display at /kitchen/[orgId] for
 * everyone, opened from the dashboard's Kitchen link as well as being the kitchen team's home. `full` keeps the
 * older ?display=full query on the link.
 */
export function kitchenDisplayPath(_role: Role | string, orgId: string, opts: { full?: boolean } = {}): string {
  return `/kitchen/${orgId}${opts.full ? `?${KDS_FULL_PARAM}` : ''}`;
}

export function homePath(role: Role | string, orgId: string): string {
  const base = `/dashboard/${orgId}`;
  if (!(ROLES as readonly string[]).includes(role)) return base;
  switch (role as Role) {
    case 'kitchen': return `/kitchen/${orgId}`;
    case 'driver': return '/driver';
    case 'host': return `${base}/host`;
    case 'waiter': return `${base}/floor`;
    case 'cashier': return `${base}/orders`;
    default: return can(role as Role, 'analytics:read') ? base : `${base}/orders`;
  }
}
