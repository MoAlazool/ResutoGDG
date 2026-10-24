import type { Role } from '@resuto/contracts';
import { can, ROLES } from '@resuto/contracts/lite';

/**
 * Where a staff member lands after signing in or opening /dashboard, by role (VS-05): the kitchen team on the
 * full-screen kitchen display, drivers on the driver app, the front desk on the live floor (its front-desk screen
 * when that route exists), cashiers on orders, waiters on the floor, everyone with analytics on the overview.
 */
/** Query that keeps the dedicated full-screen kitchen display for staff who also have the workspace (PAR-05). */
export const KDS_FULL_PARAM = 'display=full';

/**
 * Where the kitchen display opens (gallery PAR-05). Legacy showed managers the KDS inside the staff workspace, with a
 * full-screen option; only the kitchen team lived on the dedicated wall screen. Anyone whose home is the workspace
 * gets the in-shell display unless they asked for full screen.
 */
export function kitchenDisplayPath(role: Role | string, orgId: string, opts: { full?: boolean } = {}): string {
  if (opts.full || homePath(role, orgId) === `/kitchen/${orgId}`) return `/kitchen/${orgId}${opts.full ? `?${KDS_FULL_PARAM}` : ''}`;
  return `/dashboard/${orgId}/kitchen`;
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
