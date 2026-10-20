// Browser storage that belongs to the signed-in staff user. It is removed on sign-out and when a different user
// signs in on the same browser, so one person's restaurant, drafts and preferences never leak to the next.
// Guest-flow keys (cart, table visit, reservation manage links, payment intents) are not user data and stay.

/** Keys (localStorage and sessionStorage) that hold per-user staff state. New per-user keys use `resuto:u:`. */
export const USER_KEY_PATTERNS: RegExp[] = [
  /^resuto_session$/, // dev-auth session
  /^resuto:u:/, // convention for new per-user keys
  /^resuto\.shell\./, // cached restaurant snapshot for the chrome-first shell
  /^resuto\.kds\./, // KDS branch/station choice
  /^resuto_intel_branch$/, // AI insights branch filter
  /^resuto_driver_org$/, // driver's selected restaurant
  /^resuto\.floor\.draft\./, // unsaved floor-plan drafts (sessionStorage)
  /^sb-[a-z0-9]+-auth-token/, // Supabase session (also removed by supabase.auth.signOut)
];

/** The user the stored per-user keys belong to (token subject). */
export const OWNER_KEY = 'resuto.shell.owner';

type Store = Pick<Storage, 'length' | 'key' | 'removeItem'>;
const stores = (): Store[] => {
  const out: Store[] = [];
  try { if (typeof localStorage !== 'undefined') out.push(localStorage); } catch { /* blocked */ }
  try { if (typeof sessionStorage !== 'undefined') out.push(sessionStorage); } catch { /* blocked */ }
  return out;
};

/** Removes every per-user key (optionally keeping some, e.g. the session that was just stored). Returns the count. */
export function clearUserStorage(opts: { keep?: (key: string) => boolean; targets?: Store[] } = {}): number {
  let removed = 0;
  for (const s of opts.targets ?? stores()) {
    const keys: string[] = [];
    for (let i = 0; i < s.length; i++) { const k = s.key(i); if (k) keys.push(k); }
    for (const k of keys) {
      if (opts.keep?.(k)) continue;
      if (USER_KEY_PATTERNS.some((re) => re.test(k))) { try { s.removeItem(k); removed++; } catch { /* ignore */ } }
    }
  }
  return removed;
}

/**
 * Records `scope` as the owner of the per-user keys. When another user's keys are present they are removed first
 * (the session just written for the new user is kept). Returns true when a different user's data was cleared.
 */
export function claimUserStorage(scope: string, keep?: (key: string) => boolean): boolean {
  try {
    const prev = localStorage.getItem(OWNER_KEY);
    if (prev === scope) return false;
    const cleared = prev !== null;
    if (cleared) clearUserStorage({ keep });
    localStorage.setItem(OWNER_KEY, scope);
    return cleared;
  } catch {
    return false;
  }
}
