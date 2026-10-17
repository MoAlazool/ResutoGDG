// Live floor state mapping (pure). Maps the floor API's live payload onto the
// legacy table-state palette used by the manager/host floors.
import type { FloorTable } from './model';

export interface LiveVisit { id: string; partySize: number | null; openedAt: string; orderCount: number; dueMinor: number; paidMinor: number; requests: string[] }
export interface LiveReservation { id: string; startsAt: string; guestName: string | null; partySize: number }
export type LiveTable = FloorTable & { status: string; visit: LiveVisit | null; nextReservation: LiveReservation | null };
export interface LiveFloorResponse { revision: number; tables: LiveTable[] }

/** Visual state (CSS class `state-*`) and the i18n key of its worded tag. */
export function liveState(t: LiveTable): { state: string; key: string } {
  if (t.status === 'out_of_service') return { state: 'unavailable', key: 'unavailable' };
  if (t.status === 'cleaning') return { state: 'cleaning', key: 'cleaning' };
  const v = t.visit;
  if (v) {
    if (v.requests.some((r) => r === 'bill' || r === 'payment' || r === 'bill_requested')) return { state: 'bill-requested', key: 'billRequested' };
    if (v.paidMinor > 0 && v.dueMinor > 0) return { state: 'partially-paid', key: 'partiallyPaid' };
    if (v.orderCount > 0 && v.dueMinor === 0 && v.paidMinor > 0) return { state: 'paid', key: 'paid' };
    if (v.orderCount > 0) return { state: 'ordering', key: 'ordering' };
    return { state: 'occupied', key: 'seated' };
  }
  if (t.status === 'occupied') return { state: 'occupied', key: 'seated' };
  if (t.status === 'reserved') return { state: 'reserved', key: 'reserved' };
  return { state: 'available', key: 'available' };
}

export const LEGEND: Array<{ key: string; fill: string; stroke: string }> = [
  { key: 'available', fill: '#f4ead7', stroke: '#8b7757' },
  { key: 'seated', fill: '#dcebd7', stroke: '#4d775e' },
  { key: 'ordering', fill: '#dcebd7', stroke: '#3f6b50' },
  { key: 'billRequested', fill: '#eadff3', stroke: '#76528f' },
  { key: 'reserved', fill: '#ede9e1', stroke: '#5d7cae' },
  { key: 'cleaning', fill: '#dce8f2', stroke: '#4e7897' },
  { key: 'unavailable', fill: '#ede9e1', stroke: '#a8a49c' },
];

/** Headline counts for the live floor KPI row. */
export function liveCounts(tables: LiveTable[]) {
  const states = tables.map((t) => liveState(t).key);
  return {
    free: states.filter((s) => s === 'available').length,
    seated: tables.filter((t) => t.visit).length,
    guests: tables.reduce((n, t) => n + (t.visit?.partySize ?? 0), 0),
    needsYou: tables.filter((t) => (t.visit?.requests.length ?? 0) > 0 || t.status === 'cleaning').length,
  };
}
