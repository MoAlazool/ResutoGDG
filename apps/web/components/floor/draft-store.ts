// Floor Studio draft persistence and undo history (pure, storage injected).
// The draft survives reloads and failed saves in sessionStorage, exactly like
// the legacy editor ("resuto-floor-draft"), but keyed per restaurant and branch.
import { normalizeLayout, sameLayout, type FloorLayout } from './model';

export interface StoredDraft { draft: FloorLayout; base: FloorLayout; savedAt: number }
export interface KeyValueStorage { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

export const draftKey = (orgId: string, branchId: string) => `resuto.floor.draft.${orgId}.${branchId}`;

export function loadDraft(storage: KeyValueStorage | null, key: string): StoredDraft | null {
  if (!storage) return null;
  try {
    const raw = JSON.parse(storage.getItem(key) ?? 'null');
    if (!raw?.draft || !raw?.base) return null;
    return { draft: normalizeLayout(raw.draft), base: normalizeLayout(raw.base), savedAt: Number(raw.savedAt) || 0 };
  } catch {
    return null;
  }
}

/** Stores the draft while it differs from its base; clears it once they match. Returns false when storage is full. */
export function rememberDraft(storage: KeyValueStorage | null, key: string, draft: FloorLayout, base: FloorLayout): boolean {
  if (!storage) return false;
  try {
    if (sameLayout(draft, base)) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify({ draft, base, savedAt: Date.now() }));
    return true;
  } catch {
    return false;
  }
}

export function clearDraft(storage: KeyValueStorage | null, key: string) {
  try { storage?.removeItem(key); } catch { /* ignore */ }
}

// --- Undo / redo -------------------------------------------------------------------
export interface History { past: FloorLayout[]; future: FloorLayout[] }
export const HISTORY_LIMIT = 60;
export const emptyHistory = (): History => ({ past: [], future: [] });

export function checkpoint(h: History, before: FloorLayout): History {
  const past = [...h.past, structuredClone(before)];
  if (past.length > HISTORY_LIMIT) past.shift();
  return { past, future: [] };
}

export function undo(h: History, current: FloorLayout): { history: History; draft: FloorLayout } | null {
  if (!h.past.length) return null;
  const past = h.past.slice(0, -1);
  return { history: { past, future: [...h.future, structuredClone(current)] }, draft: h.past[h.past.length - 1]! };
}

export function redo(h: History, current: FloorLayout): { history: History; draft: FloorLayout } | null {
  if (!h.future.length) return null;
  const future = h.future.slice(0, -1);
  return { history: { past: [...h.past, structuredClone(current)], future }, draft: h.future[h.future.length - 1]! };
}
