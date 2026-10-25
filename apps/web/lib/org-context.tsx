'use client';
import { useSearchParams } from 'next/navigation';
import { createContext, useContext, useEffect, type ReactNode } from 'react';
import type { ModuleKey, Permission, Role } from '@resuto/contracts';
import { can } from '@resuto/contracts/lite';

export interface OrgInfo {
  id: string; slug: string; name: string; nameAr: string | null; country: 'EG' | 'SA'; currency: 'EGP' | 'SAR';
  timezone: string; role: Role; status: string;
  branches: Array<{ id: string; name: string; nameAr: string | null; code: string; isActive: boolean; acceptsDineIn?: boolean;
    acceptsPickup?: boolean; acceptsDelivery?: boolean; acceptsReservations?: boolean; serviceMode?: 'tables' | 'counter' | 'online' }>;
  onboarding?: Record<string, unknown> | null;
}

interface OrgValue {
  org: OrgInfo;
  modules: Partial<Record<ModuleKey, boolean>> | null;
  /** The restaurant's plan id (`free`, `starter` …) when the entitlements are known. */
  plan?: string | null;
  can(p: Permission): boolean;
  hasModule(m: ModuleKey): boolean;
  reload(): Promise<void>;
  /**
   * The one branch context (21-SHELL): the branch chosen in the shell's branch switcher, always a real branch when the
   * restaurant has one. `org.branches` lists it first, so screens that open on `org.branches[0]` follow it.
   * When the switcher is on "All branches", this is still the last single branch, for screens that need one; screens
   * that can show every branch read `useBranchScope({ allowAll: true })` instead.
   */
  branchId?: string | null;
  /** The switcher is on "All branches" (only offered while a screen that supports it is open). */
  allBranches?: boolean;
  /** Choose a branch, or null for "All branches". Persisted per user and restaurant. */
  setBranchId?(branchId: string | null): void;
  /** A screen that can show all branches registers itself, so the switcher offers "All branches" (returns unregister). */
  registerAllBranches?(): () => void;
}

const OrgContext = createContext<OrgValue | null>(null);

export function OrgProvider({ value, children }: { value: Omit<OrgValue, 'can' | 'hasModule'>; children: ReactNode }) {
  const full: OrgValue = {
    ...value,
    can: (p) => can(value.org.role, p),
    // Unknown entitlements (endpoint unavailable) → show the module; the API still enforces.
    hasModule: (m) => value.modules === null || value.modules[m] !== false,
  };
  return <OrgContext.Provider value={full}>{children}</OrgContext.Provider>;
}

export function useOrg() {
  const v = useContext(OrgContext);
  if (!v) throw new Error('useOrg must be used inside the dashboard');
  return v;
}

/** The dashboard org when inside it, otherwise null (shared components used on both sides). */
export function useOptionalOrg() {
  return useContext(OrgContext);
}

/**
 * The shell's branch for a screen (replaces the per-page branch selects). With `allowAll`, the screen supports
 * "All branches": it registers itself so the switcher offers that choice, and `branchId` is '' while it is chosen.
 * Without it, `branchId` is always a single branch (the last one chosen). `setBranchId('')` selects all branches.
 */
export function useBranchScope({ allowAll = false }: { allowAll?: boolean } = {}): { branchId: string; allBranches: boolean; setBranchId(id: string): void } {
  const v = useOrg();
  const register = v.registerAllBranches;
  useEffect(() => (allowAll && register ? register() : undefined), [allowAll, register]);
  const single = v.branchId ?? v.org.branches.find((b) => b.isActive)?.id ?? '';
  const all = allowAll && !!v.allBranches;
  return {
    branchId: all ? '' : single,
    allBranches: all,
    setBranchId: (id: string) => v.setBranchId?.(id === '' ? (allowAll ? null : single || null) : id),
  };
}

/**
 * For screens that used to keep their own branch filter in the URL (`?branch=<id>`, orders and reservations): a link
 * that names a branch selects it in the shell's switcher, so the screen and the shell never disagree. Returns that
 * branch while the switch happens, otherwise `fallback` (the shell's branch).
 */
export function useBranchParam(fallback: string, name = 'branch'): string {
  const v = useOrg();
  const params = useSearchParams();
  const wanted = params.get(name);
  const valid = !!wanted && v.org.branches.some((b) => b.id === wanted && b.isActive !== false);
  const set = v.setBranchId;
  useEffect(() => { if (valid && wanted !== v.branchId) set?.(wanted); }, [valid, wanted, v.branchId, set]);
  return valid ? wanted! : fallback;
}

/** Whether the restaurant has more than one active branch (screens hide branch labels and filters otherwise). */
export const isMultiBranch = (org: OrgInfo) => org.branches.filter((b) => b.isActive).length > 1;
