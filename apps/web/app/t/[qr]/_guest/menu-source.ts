// Where the QR table page loads its menu in the browser when it did not arrive in the HTML (PERF-01: a server menu
// read slower than GUEST_MENU_BUDGET_MS, or the API unreachable while the page rendered).
//
// - The menu is already there: nothing to load.
// - With a table visit: the visit's own menu (/public/visits/current/menu).
// - While the session is still opening: wait for it (the visit menu follows).
// - Without a visit (the table is not taking orders, the session could not be opened, the visit was closed): the
//   branch's public menu, from the table lookup the page already has, so the guest still sees the menu instead of an
//   endless skeleton.
// - Neither a visit nor the table: nothing to load from; the page offers to try again (which scans in again).
import type { PublicTableView } from '@resuto/contracts';
import { visitHeaders, type GuestVisit } from '@/lib/guest-visit';

export type TablePhase = 'joining' | 'ready' | 'closed' | 'unavailable';
export interface MenuSource { path: string; headers?: Record<string, string> }

export function menuSource(s: { hasMenu: boolean; visit: GuestVisit | null; phase: TablePhase; table: PublicTableView | null }): MenuSource | null {
  if (s.hasMenu) return null;
  if (s.visit) return { path: '/public/visits/current/menu', headers: visitHeaders(s.visit) };
  if (s.phase === 'joining') return null;
  if (s.table) return { path: `/public/menu/${encodeURIComponent(s.table.org.slug)}?branch=${encodeURIComponent(s.table.branch.code)}` };
  return null;
}
