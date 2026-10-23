import { beforeAll, describe, expect, it } from 'vitest';
import { clearCounterVisit, counterStage, loadCounterVisit, readyForPickup, saveCounterVisit, ticketLabel } from './counter-state';

// A minimal Storage for node (the web unit tests run without a DOM).
beforeAll(() => {
  const m = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k),
  };
});

const view = (over: Partial<Parameters<typeof counterStage>[0] & object> = {}) => ({
  ticket: '7', orders: [{ status: 'placed', fulfillment: 'pickup' }], totals: { totalMinor: 9000, dueMinor: 9000 }, requests: [], settling: false, ...over,
});

describe('counter ticket (FT-07, legacy guest.js counterTicket)', () => {
  it('shows the menu until something is ordered; an all-cancelled visit has nothing to pay', () => {
    expect(counterStage(null)).toBe('menu');
    expect(counterStage(view({ orders: [], totals: { totalMinor: 0, dueMinor: 0 } }))).toBe('menu');
    expect(counterStage(view({ orders: [{ status: 'cancelled' }], totals: { totalMinor: 0, dueMinor: 0 } }))).toBe('menu');
  });

  it('offers "Pay now on my phone" / "Pay at the counter" while an amount is due, then waits for the cashier', () => {
    expect(counterStage(view())).toBe('choose');
    expect(counterStage(view({ requests: [{ kind: 'bill', status: 'open' }] }))).toBe('cashier');
    expect(counterStage(view({ requests: [{ kind: 'bill', status: 'acknowledged' }] }))).toBe('cashier');
    // A waiter request (tables only) or a resolved one does not count as choosing the counter.
    expect(counterStage(view({ requests: [{ kind: 'waiter', status: 'open' }] }))).toBe('choose');
    expect(counterStage(view({ requests: [{ kind: 'bill', status: 'resolved' }] }))).toBe('choose');
  });

  it('never shows paid before the server recorded it: a payment in flight is "paying", only dueMinor 0 is settled', () => {
    expect(counterStage(view({ settling: true }))).toBe('paying');
    expect(counterStage(view({ settling: true, requests: [{ kind: 'bill', status: 'open' }] }))).toBe('paying');
    expect(counterStage(view({ totals: { totalMinor: 9000, dueMinor: 1 } }))).toBe('choose');
    expect(counterStage(view({ totals: { totalMinor: 9000, dueMinor: 0 } }))).toBe('settled');
  });

  it('prints the ticket like the legacy counter, in Western digits whatever the input', () => {
    expect(ticketLabel('7')).toBe('#007');
    expect(ticketLabel(42)).toBe('#042');
    expect(ticketLabel('1234')).toBe('#1234');
    expect(ticketLabel('٣')).toBe('#003');
    expect(ticketLabel(null)).toBe('#000');
  });

  it('tells the guest to come to the counter when an order is ready for pickup', () => {
    expect(readyForPickup([{ status: 'preparing' }])).toBe(false);
    expect(readyForPickup([{ status: 'picked_up' }, { status: 'ready' }])).toBe(true);
  });

  it('keeps the visit token per venue code across tabs, and forgets it on request', () => {
    const v = { token: 't'.repeat(43), visitId: 'v1', orgId: 'o1', branchId: 'b1', tableLabel: '', currency: 'EGP' as const };
    expect(loadCounterVisit('code-a')).toBeNull();
    saveCounterVisit('code-a', v);
    expect(loadCounterVisit('code-a')).toMatchObject(v);
    expect(loadCounterVisit('code-b')).toBeNull();
    localStorage.setItem('resuto.counter.code-c', '{not json');
    expect(loadCounterVisit('code-c')).toBeNull();
    clearCounterVisit('code-a');
    expect(loadCounterVisit('code-a')).toBeNull();
  });
});
