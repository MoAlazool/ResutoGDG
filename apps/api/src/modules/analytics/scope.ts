// Shared helpers for Agent B2 modules (inventory, customers, analytics).
import type { TenantContext } from '../../common/auth/context';

/**
 * Branch filter for read models: an explicit branch (checked against the
 * caller's scope) or the caller's own branch allow-list (null = all branches).
 * RLS enforces the same scope again for member sessions.
 */
export function branchScope(ctx: TenantContext, branchId?: string | null): string[] | null {
  if (branchId) {
    ctx.assertBranch(branchId);
    return [branchId];
  }
  return ctx.branchFilter;
}

/** numeric columns arrive as strings; quantities have 3 decimals. */
export const num = (v: unknown): number => (v === null || v === undefined ? 0 : Math.round(Number(v) * 1000) / 1000);
export const int = (v: unknown): number => (v === null || v === undefined ? 0 : Math.round(Number(v)));
export const iso = (v: unknown): string | null => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v));

/** Local time-zone expression for an order/movement joined with branches b and organizations o. */
export const TZ = `coalesce(b.timezone, o.timezone)`;
