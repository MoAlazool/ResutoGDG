'use client';
import { createContext, useContext, type ReactNode } from 'react';
import { can, type ModuleKey, type Permission, type Role } from '@resuto/contracts';

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
  can(p: Permission): boolean;
  hasModule(m: ModuleKey): boolean;
  reload(): Promise<void>;
  /**
   * Branch chosen in the shell's restaurant chip (null until there is a choice). `org.branches` lists it first, so
   * screens that open on `org.branches[0]` follow it; new screens should read this value directly.
   */
  branchId?: string | null;
  setBranchId?(branchId: string): void;
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
