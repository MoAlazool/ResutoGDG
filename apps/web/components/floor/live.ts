// Live floor state mapping (pure). Maps the floor API's live payload onto the legacy table states
// (legacy/public/app.js tableState): Available, Reserved (within the hour), Needs cleaning, Seated, In the kitchen,
// Food ready, Paying, Part paid, Paid / ready to close, Dining. Colours are the protected table-state tokens.
import type { FloorTable } from './model';

export interface LiveVisit {
  id: string; partySize: number | null; openedAt: string; orderCount: number; dueMinor: number; paidMinor: number; requests: string[];
  preparing?: number; ready?: number; totalMinor?: number; openedVia?: string; undoable?: boolean; billingLocked?: boolean;
}
export interface LiveReservation { id: string; startsAt: string; guestName: string | null; partySize: number }
export type LiveTable = FloorTable & { status: string; visit: LiveVisit | null; nextReservation: LiveReservation | null };
export interface LiveFloorResponse { revision: number; tables: LiveTable[] }

export type LiveStateKey = 'available' | 'reserved' | 'cleaning' | 'unavailable' | 'seated' | 'preparing' | 'ready' | 'payment' | 'partiallyPaid' | 'paid' | 'dining';

const STATE_CLASS: Record<LiveStateKey, string> = {
  available: 'available', reserved: 'reserved', cleaning: 'cleaning', unavailable: 'unavailable', seated: 'ordering', preparing: 'preparing',
  ready: 'ready', payment: 'payment', partiallyPaid: 'partially-paid', paid: 'paid', dining: 'eating',
};

/** Tables whose next reservation starts within this window show as Reserved (legacy: one hour). */
export const RESERVED_SOON_MS = 60 * 60_000;

/** Visual state (CSS class `state-*`) and the key of its worded tag (ops.floor.state.*). */
export function liveState(t: LiveTable, now = Date.now()): { state: string; key: LiveStateKey } {
  const k = liveStateKey(t, now);
  return { state: STATE_CLASS[k], key: k };
}

export function liveStateKey(t: LiveTable, now = Date.now()): LiveStateKey {
  if (t.status === 'out_of_service') return 'unavailable';
  const v = t.visit;
  if (!v) {
    if (t.status === 'cleaning') return 'cleaning';
    const r = t.nextReservation;
    if (r && Date.parse(r.startsAt) < now + RESERVED_SOON_MS) return 'reserved';
    return t.status === 'occupied' ? 'seated' : 'available';
  }
  if ((v.ready ?? 0) > 0) return 'ready';
  if ((v.preparing ?? 0) > 0) return 'preparing';
  const total = v.totalMinor ?? v.dueMinor + v.paidMinor;
  if (total > 0 && v.dueMinor === 0) return 'paid';
  if (v.billingLocked || v.requests.some((r) => r === 'bill')) return 'payment';
  if (v.paidMinor > 0) return 'partiallyPaid';
  if (!v.orderCount) return 'seated';
  return 'dining';
}

/** States in the legacy legend order, with their token colours. */
export const LEGEND: Array<{ key: LiveStateKey; fill: string; stroke: string }> = [
  { key: 'available', fill: 'var(--state-available-fill)', stroke: 'var(--state-available-stroke)' },
  { key: 'seated', fill: 'var(--state-occupied-fill)', stroke: 'var(--state-occupied-stroke)' },
  { key: 'preparing', fill: 'var(--state-preparing-fill)', stroke: 'var(--state-preparing-stroke)' },
  { key: 'ready', fill: 'var(--state-ready-fill)', stroke: 'var(--state-ready-stroke)' },
  { key: 'payment', fill: 'var(--state-payment-fill)', stroke: 'var(--state-payment-stroke)' },
  { key: 'paid', fill: 'var(--state-paid-fill)', stroke: 'var(--state-paid-stroke)' },
  { key: 'reserved', fill: 'var(--state-reserved-fill)', stroke: 'var(--state-reserved-stroke)' },
  { key: 'cleaning', fill: 'var(--state-cleaning-fill)', stroke: 'var(--state-cleaning-stroke)' },
];

const OCCUPIED: ReadonlySet<LiveStateKey> = new Set(['seated', 'preparing', 'ready', 'payment', 'partiallyPaid', 'paid', 'dining']);

/** The legacy floor KPI strip: tables available, occupied seat capacity, upcoming reservations, in the kitchen. */
export function liveCounts(tables: LiveTable[], now = Date.now()) {
  const keys = tables.map((t) => liveStateKey(t, now));
  const occupied = tables.filter((_, i) => OCCUPIED.has(keys[i]!));
  return {
    total: tables.length,
    seats: tables.reduce((n, t) => n + t.capacity, 0),
    free: keys.filter((k) => k === 'available').length,
    occupiedTables: occupied.length,
    occupiedSeats: occupied.reduce((n, t) => n + (t.visit?.partySize || t.capacity), 0),
    upcoming: tables.filter((t) => t.nextReservation && Date.parse(t.nextReservation.startsAt) >= now - 30 * 60_000).length,
    inKitchen: tables.reduce((n, t) => n + (t.visit?.preparing ?? 0), 0),
    readyToServe: tables.reduce((n, t) => n + (t.visit?.ready ?? 0), 0),
    guests: tables.reduce((n, t) => n + (t.visit?.partySize ?? 0), 0),
    seatedNow: tables.filter((t) => t.visit).length,
    needsYou: tables.filter((t) => (t.visit?.requests.length ?? 0) > 0 || t.status === 'cleaning').length,
  };
}

/** The smallest free table that fits the party (legacy walk-in: "auto-picks the smallest free table"). */
export function smallestFreeTable(tables: LiveTable[], party: number, now = Date.now()): LiveTable | null {
  return tables
    .filter((t) => liveStateKey(t, now) === 'available' && t.capacity >= party)
    .sort((a, b) => a.capacity - b.capacity || a.label.localeCompare(b.label, undefined, { numeric: true }))[0] ?? null;
}
