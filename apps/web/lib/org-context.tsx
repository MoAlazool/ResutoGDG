'use client';
import { createContext, useContext, type ReactNode } from 'react';
import { can, type ModuleKey, type Permission, type Role } from '@resuto/contracts';

export interface OrgInfo {
  id: string; slug: string; name: string; nameAr: string | null; country: 'EG' | 'SA'; currency: 'EGP' | 'SAR';
  timezone: string; role: Role; status: string;
  branches: Array<{ id: string; name: string; nameAr: string | null; code: string; isActive: boolean }>;
}

interface OrgValue {
  org: OrgInfo;
  modules: Partial<Record<ModuleKey, boolean>> | null;
  can(p: Permission): boolean;
  hasModule(m: ModuleKey): boolean;
  reload(): Promise<void>;
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
