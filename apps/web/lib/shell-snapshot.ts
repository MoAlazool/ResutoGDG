import type { ModuleKey } from '@resuto/contracts';
import type { OrgInfo } from './org-context';

// Last known restaurant for the chrome-first staff shell (VS-07 / PCL-05). The sidebar, restaurant chip and nav
// render immediately from this snapshot while GET /o/:id and the entitlements refresh in the background, and the
// workspace stays usable when such a refresh fails. Per user: the key prefix is in lib/user-storage.ts
// USER_KEY_PATTERNS (`resuto.shell.`), so it is removed on sign-out and when another user signs in, and the stored
// scope must match the signed-in user before it is used. The API stays authoritative: the snapshot only decides
// what the chrome shows first; every page request is still authorised server side.

export interface ShellSnapshot {
  scope: string;
  org: OrgInfo;
  modules: Partial<Record<ModuleKey, boolean>> | null;
  /** The plan id when the entitlements were known (the Free shell). Absent in snapshots written before 21-SHELL. */
  plan?: string | null;
  savedAt: number;
}

const key = (orgId: string) => `resuto.shell.org.${orgId}`;
const BRANCH_KEY = (orgId: string) => `resuto.shell.branch.${orgId}`;
/** Snapshots older than this are not used for the chrome (the restaurant may have changed a lot). */
export const SNAPSHOT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const local = (): Store | null => { try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; } };

export function readShellSnapshot(orgId: string, scope: string | null, store: Store | null = local(), now = Date.now()): ShellSnapshot | null {
  if (!scope || !store) return null;
  try {
    const s = JSON.parse(store.getItem(key(orgId)) ?? 'null') as ShellSnapshot | null;
    if (!s || s.scope !== scope || s.org?.id !== orgId || typeof s.savedAt !== 'number' || now - s.savedAt > SNAPSHOT_MAX_AGE_MS) return null;
    return s;
  } catch {
    return null;
  }
}

export function writeShellSnapshot(snapshot: ShellSnapshot, store: Store | null = local()) {
  try { store?.setItem(key(snapshot.org.id), JSON.stringify(snapshot)); } catch { /* quota or private mode */ }
}

/** Removes the snapshot (the user lost access to the restaurant, or it no longer exists). */
export function dropShellSnapshot(orgId: string, store: Store | null = local()) {
  try { store?.removeItem(key(orgId)); } catch { /* ignore */ }
}

/** The branch chosen in the restaurant chip (per user, per restaurant). */
export function readPreferredBranch(orgId: string, store: Store | null = local()): string | null {
  try { return store?.getItem(BRANCH_KEY(orgId)) ?? null; } catch { return null; }
}
export function writePreferredBranch(orgId: string, branchId: string, store: Store | null = local()) {
  try { store?.setItem(BRANCH_KEY(orgId), branchId); } catch { /* ignore */ }
}

const ALL_KEY = (orgId: string) => `resuto.shell.allBranches.${orgId}`;
/**
 * Whether the branch switcher is on "All branches" (per user, per restaurant). Nothing stored = all branches, as the
 * overview, analytics, customers and inventory screens opened before they followed the shell.
 */
export function readAllBranches(orgId: string, store: Store | null = local()): boolean {
  try { return (store?.getItem(ALL_KEY(orgId)) ?? '1') === '1'; } catch { return true; }
}
export function writeAllBranches(orgId: string, all: boolean, store: Store | null = local()) {
  try { store?.setItem(ALL_KEY(orgId), all ? '1' : '0'); } catch { /* ignore */ }
}

/**
 * Branches with the preferred one first. Screens that default to `org.branches[0]` (orders, menu, reservations,
 * kitchen, payments) therefore open on the branch chosen in the restaurant chip.
 */
export function withPreferredBranch(org: OrgInfo, branchId: string | null): OrgInfo {
  const i = branchId ? org.branches.findIndex((b) => b.id === branchId) : -1;
  if (i <= 0) return org;
  const branches = [org.branches[i]!, ...org.branches.slice(0, i), ...org.branches.slice(i + 1)];
  return { ...org, branches };
}
