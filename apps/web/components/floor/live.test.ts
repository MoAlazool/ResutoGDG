import { describe, expect, it } from 'vitest';
import { liveCounts, liveStateKey, smallestFreeTable, type LiveTable } from './live';

const NOW = Date.parse('2026-10-20T20:00:00Z');
const table = (label: string, capacity: number, extra: Partial<LiveTable> = {}): LiveTable => ({
  id: label, label, capacity, zone: null, shape: 'square', cx: 0, cy: 0, width: 100, height: 100, rotation: 0, features: [], reservable: true,
  minSpendMinor: null, premium: false, internalNotes: null, status: 'available', version: 0, visit: null, nextReservation: null, ...extra,
} as unknown as LiveTable);
const visit = (v: Partial<NonNullable<LiveTable['visit']>>) => ({ id: 'v', partySize: 2, openedAt: '2026-10-20T19:00:00Z', orderCount: 1, dueMinor: 1000, paidMinor: 0, requests: [], ...v });

describe('live floor states (VS-11, legacy tableState)', () => {
  it('maps kitchen and bill progress like the original floor', () => {
    expect(liveStateKey(table('A', 2), NOW)).toBe('available');
    expect(liveStateKey(table('A', 2, { status: 'cleaning' }), NOW)).toBe('cleaning');
    expect(liveStateKey(table('A', 2, { nextReservation: { id: 'r', startsAt: '2026-10-20T20:30:00Z', guestName: 'N', partySize: 2 } }), NOW)).toBe('reserved');
    expect(liveStateKey(table('A', 2, { nextReservation: { id: 'r', startsAt: '2026-10-20T23:30:00Z', guestName: 'N', partySize: 2 } }), NOW)).toBe('available');
    expect(liveStateKey(table('A', 2, { visit: visit({ orderCount: 0, dueMinor: 0 }) }), NOW)).toBe('seated');
    expect(liveStateKey(table('A', 2, { visit: visit({ preparing: 1 }) }), NOW)).toBe('preparing');
    expect(liveStateKey(table('A', 2, { visit: visit({ preparing: 1, ready: 1 }) }), NOW)).toBe('ready');
    expect(liveStateKey(table('A', 2, { visit: visit({ requests: ['bill'] }) }), NOW)).toBe('payment');
    expect(liveStateKey(table('A', 2, { visit: visit({ paidMinor: 400, dueMinor: 600 }) }), NOW)).toBe('partiallyPaid');
    expect(liveStateKey(table('A', 2, { visit: visit({ paidMinor: 1000, dueMinor: 0, totalMinor: 1000 }) }), NOW)).toBe('paid');
    expect(liveStateKey(table('A', 2, { visit: visit({}) }), NOW)).toBe('dining');
  });

  it('counts the legacy KPI strip and picks the smallest free table for a walk-in', () => {
    const tables = [table('T1', 2), table('T2', 4, { visit: visit({ partySize: 3, preparing: 2 }) }), table('T3', 6), table('T4', 4)];
    const c = liveCounts(tables, NOW);
    expect(c).toMatchObject({ total: 4, free: 3, occupiedTables: 1, occupiedSeats: 3, inKitchen: 2, seats: 16 });
    expect(smallestFreeTable(tables, 3, NOW)?.label).toBe('T4');
    expect(smallestFreeTable(tables, 2, NOW)?.label).toBe('T1');
    expect(smallestFreeTable(tables, 7, NOW)).toBeNull();
  });
});
