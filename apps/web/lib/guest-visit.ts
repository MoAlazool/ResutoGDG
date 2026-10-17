'use client';
// Guest table-session credential shared by the QR ordering pages (/t/[qr], Agent B1)
// and the bill payment pages (/t/[qr]/pay, Agent D1). Kept in sessionStorage so it
// never outlives the browser tab and is never sent anywhere but the Resuto API.
export interface GuestVisit {
  /** Bearer token returned by POST /v1/public/tables/:qr/session; send as X-Visit-Token. */
  token: string;
  visitId: string;
  orgId: string;
  branchId: string;
  tableLabel: string;
  currency: 'EGP' | 'SAR';
  savedAt: number;
}

const key = (qr: string) => `resuto.visit.${qr}`;

export function saveGuestVisit(qr: string, visit: Omit<GuestVisit, 'savedAt'>) {
  try { sessionStorage.setItem(key(qr), JSON.stringify({ ...visit, savedAt: Date.now() })); } catch { /* private mode */ }
}

export function loadGuestVisit(qr: string): GuestVisit | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(key(qr)) ?? 'null') as GuestVisit | null;
    return v && typeof v.token === 'string' ? v : null;
  } catch {
    return null;
  }
}

export function clearGuestVisit(qr: string) {
  try { sessionStorage.removeItem(key(qr)); } catch { /* ignore */ }
}

export const visitHeaders = (v: GuestVisit | null): Record<string, string> => (v ? { 'X-Visit-Token': v.token } : {});
