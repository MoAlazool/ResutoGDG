// Counter page state (FT-07, legacy guest.js counterTicket()): what the ticket shows and which choice the guest gets.
// Only what the server recorded counts: the amount due comes from the visit totals, and nothing here marks a payment.
import { toWesternDigits } from '@resuto/contracts';
import type { GuestVisit } from '@/lib/guest-visit';

export interface CounterViewInput {
  ticket: string | null;
  orders: Array<{ status: string; fulfillment?: string }>;
  totals: { totalMinor: number; dueMinor: number };
  requests: Array<{ kind: string; status: string }>;
  settling?: boolean;
}

/**
 * - `menu`: nothing ordered yet (or everything cancelled): the guest browses the menu.
 * - `choose`: an amount is due and the guest has not picked how to pay: "Pay now on my phone" / "Pay at the counter".
 * - `cashier`: the guest chose the counter: "The cashier has your order. Pay at the counter with this number."
 * - `paying`: an online payment is in flight (the provider has not confirmed it yet).
 * - `settled`: paid in full, as recorded by the server.
 */
export type CounterStage = 'menu' | 'choose' | 'cashier' | 'paying' | 'settled';

export function counterStage(v: CounterViewInput | null): CounterStage {
  if (!v) return 'menu';
  const live = v.orders.filter((o) => o.status !== 'cancelled');
  if (!live.length || v.totals.totalMinor <= 0) return 'menu';
  if (v.totals.dueMinor <= 0) return 'settled';
  if (v.settling) return 'paying';
  return v.requests.some((r) => r.kind === 'bill' && r.status !== 'resolved') ? 'cashier' : 'choose';
}

/** Ticket number as the legacy counter printed it: a hash and three digits at least (Western digits in every language). */
export const ticketLabel = (n: string | number | null | undefined) =>
  `#${toWesternDigits(String(n ?? 0)).replace(/\D/g, '').padStart(3, '0') || '000'}`;

/** At least one order is waiting at the pass: the guest should come to the counter. */
export const readyForPickup = (orders: Array<{ status: string }>) => orders.some((o) => o.status === 'ready');

// The counter visit token is kept in localStorage (not sessionStorage like a table): a guest waiting for a takeaway
// closes the tab and scans again, and must get the same ticket back. It only works while the visit is open.
const key = (code: string) => `resuto.counter.${code}`;

export function saveCounterVisit(code: string, visit: Omit<GuestVisit, 'savedAt'>) {
  try { localStorage.setItem(key(code), JSON.stringify({ ...visit, savedAt: Date.now() })); } catch { /* private mode */ }
}

export function loadCounterVisit(code: string): GuestVisit | null {
  try {
    const v = JSON.parse(localStorage.getItem(key(code)) ?? 'null') as GuestVisit | null;
    return v && typeof v.token === 'string' && typeof v.visitId === 'string' ? v : null;
  } catch {
    return null;
  }
}

export function clearCounterVisit(code: string) {
  try { localStorage.removeItem(key(code)); } catch { /* ignore */ }
}
