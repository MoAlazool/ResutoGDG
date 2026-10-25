// Reservation timeline layout (21-OPS: a Gantt-style day per table). Pure, so it is unit tested without a browser.
// Times are minutes from the start of the day in the restaurant's time zone (a booking past midnight runs beyond
// 1440); bars are placed in percent of the visible window along the inline axis, so the same numbers lay out left to
// right in English and right to left in Arabic (the component positions them with inset-inline-start).

export interface TimelineBooking { id: string; tableId: string | null; startsAt: string; endsAt: string; status: string }
export interface TimelineTable { id: string; label: string }
export interface TimelineWindow { start: number; end: number }
export interface TimelineBar<B> { booking: B; start: number; end: number; offset: number; width: number; lane: number }
export interface TimelineRow<B> { id: string | null; label: string | null; bars: Array<TimelineBar<B>>; lanes: number }

/** The day before or after a YYYY-MM-DD date (calendar arithmetic, no time zone involved). */
export const shiftDay = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Bookings that no longer hold a table are left off the timeline. */
export const HIDDEN_STATUSES: ReadonlySet<string> = new Set(['cancelled', 'expired']);

const parts = (iso: string | number, timeZone: string) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
};

const dayIndex = (date: string) => Math.round(Date.parse(`${date}T00:00:00Z`) / 86_400_000);

/** Minutes from the start of `day` (YYYY-MM-DD) in `timeZone`: negative before it, above 1440 after it. */
export function minutesInDay(iso: string | number, timeZone: string, day: string): number {
  const p = parts(iso, timeZone);
  return (dayIndex(p.date) - dayIndex(day)) * 1440 + p.minutes;
}

/**
 * The hours shown: from an hour before the first booking to an hour after the last, on whole hours, at least six
 * hours wide; an empty day shows the evening service (17:00-23:00).
 */
export function timelineWindow(spans: ReadonlyArray<{ start: number; end: number }>, minHours = 6): TimelineWindow {
  if (!spans.length) return { start: 17 * 60, end: 23 * 60 };
  let start = Math.max(0, Math.floor(Math.min(...spans.map((s) => s.start)) / 60) * 60 - 60);
  let end = Math.min(48 * 60, Math.ceil(Math.max(...spans.map((s) => s.end)) / 60) * 60 + 60);
  if (end - start < minHours * 60) {
    const grow = minHours * 60 - (end - start);
    start = Math.max(0, start - Math.floor(grow / 120) * 60);
    end = start + minHours * 60;
  }
  return { start, end };
}

/** Whole hours inside the window, as minutes. */
export function hourTicks(w: TimelineWindow): number[] {
  const out: number[] = [];
  for (let m = Math.ceil(w.start / 60) * 60; m <= w.end; m += 60) out.push(m);
  return out;
}

/** Percent of the window at minute `m` (clamped). */
export const offsetOf = (m: number, w: TimelineWindow) => Math.min(100, Math.max(0, ((m - w.start) / (w.end - w.start)) * 100));

/** "19:00" for a minute of the day (Western digits; 25:30 past midnight reads 01:30). */
export const clock = (m: number) => {
  const mm = ((m % 1440) + 1440) % 1440;
  return `${String(Math.floor(mm / 60)).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}`;
};

/**
 * One row per table (in the given order) and, when needed, a row for bookings with no table yet. Overlapping bookings
 * on one table stack in lanes (first fit), so a double booking is visible instead of hidden under another bar.
 */
export function layoutTimeline<B extends TimelineBooking>(tables: readonly TimelineTable[], bookings: readonly B[], timeZone: string, day: string, window?: TimelineWindow): { window: TimelineWindow; rows: Array<TimelineRow<B>> } {
  const spans = bookings.filter((b) => !HIDDEN_STATUSES.has(b.status))
    .map((b) => ({ booking: b, start: minutesInDay(b.startsAt, timeZone, day), end: Math.max(minutesInDay(b.endsAt, timeZone, day), minutesInDay(b.startsAt, timeZone, day) + 15) }));
  const w = window ?? timelineWindow(spans);
  const known = new Set(tables.map((t) => t.id));
  const rowOf = (id: string | null, label: string | null): TimelineRow<B> => {
    const mine = spans.filter((s) => (id === null ? !s.booking.tableId || !known.has(s.booking.tableId) : s.booking.tableId === id)).sort((a, b) => a.start - b.start || a.end - b.end);
    const laneEnds: number[] = [];
    const bars = mine.map((s) => {
      let lane = laneEnds.findIndex((end) => end <= s.start);
      if (lane === -1) { lane = laneEnds.length; laneEnds.push(s.end); } else laneEnds[lane] = s.end;
      const offset = offsetOf(s.start, w);
      return { booking: s.booking, start: s.start, end: s.end, offset, width: Math.max(0, offsetOf(s.end, w) - offset), lane };
    });
    return { id, label, bars, lanes: Math.max(1, laneEnds.length) };
  };
  const rows = tables.map((t) => rowOf(t.id, t.label));
  const loose = rowOf(null, null);
  if (loose.bars.length) rows.push(loose);
  return { window: w, rows };
}
