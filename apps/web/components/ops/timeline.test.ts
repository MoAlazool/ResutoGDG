import { describe, expect, it } from 'vitest';
import { clock, hourTicks, layoutTimeline, minutesInDay, offsetOf, shiftDay, timelineWindow } from './timeline';

// Cairo is UTC+3 in late October 2026 (summer time ends on the last Thursday of October).
const TZ = 'Africa/Cairo';
const DAY = '2026-10-25';
const at = (hhmm: string, day = DAY) => new Date(`${day}T${hhmm}:00+03:00`).toISOString();
const booking = (id: string, tableId: string | null, start: string, end: string, status = 'confirmed') => ({ id, tableId, startsAt: at(start), endsAt: at(end), status });

describe('reservation timeline layout', () => {
  it('reads times in the restaurant\'s zone, past midnight beyond 24:00', () => {
    expect(minutesInDay(at('19:30'), TZ, DAY)).toBe(19 * 60 + 30);
    expect(minutesInDay(at('00:30', '2026-10-26'), TZ, DAY)).toBe(24 * 60 + 30);
    expect(clock(24 * 60 + 30)).toBe('00:30');
    expect(shiftDay('2026-10-31', 1)).toBe('2026-11-01');
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('shows an hour either side of the bookings, at least six hours, the evening when empty', () => {
    expect(timelineWindow([])).toEqual({ start: 17 * 60, end: 23 * 60 });
    expect(timelineWindow([{ start: 13 * 60 + 15, end: 22 * 60 + 10 }])).toEqual({ start: 12 * 60, end: 24 * 60 });
    const short = timelineWindow([{ start: 20 * 60, end: 21 * 60 }]);
    expect(short.end - short.start).toBe(6 * 60);
    expect(short.start).toBeLessThanOrEqual(19 * 60);
    expect(hourTicks({ start: 17 * 60, end: 20 * 60 })).toEqual([17 * 60, 18 * 60, 19 * 60, 20 * 60]);
  });

  it('one row per table in order, a row for bookings without a table, overlaps stacked in lanes', () => {
    const tables = [{ id: 't1', label: 'T1' }, { id: 't2', label: 'T2' }];
    const { window: w, rows } = layoutTimeline(tables, [
      booking('a', 't1', '19:00', '20:30'), booking('b', 't1', '20:00', '21:00'), booking('c', 't1', '21:00', '22:00'),
      booking('d', null, '20:00', '21:30'), booking('x', 't2', '19:00', '20:00', 'cancelled'), booking('g', 'gone', '18:00', '19:00'),
    ], TZ, DAY);
    expect(w).toEqual({ start: 17 * 60, end: 23 * 60 });
    expect(rows.map((r) => r.label)).toEqual(['T1', 'T2', null]);
    const t1 = rows[0]!;
    expect(t1.bars.map((b) => [b.booking.id, b.lane])).toEqual([['a', 0], ['b', 1], ['c', 0]]);
    expect(t1.lanes).toBe(2);
    expect(rows[1]!.bars).toEqual([]); // the cancelled booking is not drawn
    expect(rows[2]!.bars.map((b) => b.booking.id)).toEqual(['g', 'd']); // no table, or a table no longer on the floor
    const a = t1.bars[0]!;
    expect(a.offset).toBeCloseTo((2 / 6) * 100, 5);
    expect(a.width).toBeCloseTo((1.5 / 6) * 100, 5);
  });

  it('percentages run along the inline axis from the window start (the same numbers in RTL), clamped to the window', () => {
    const w = { start: 18 * 60, end: 24 * 60 };
    expect(offsetOf(18 * 60, w)).toBe(0);
    expect(offsetOf(21 * 60, w)).toBe(50);
    expect(offsetOf(25 * 60, w)).toBe(100);
    expect(offsetOf(10 * 60, w)).toBe(0);
  });
});
