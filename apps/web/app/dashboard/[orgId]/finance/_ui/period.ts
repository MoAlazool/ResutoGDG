// Finance period picker and comparison (21-MONEY). Pure date maths on calendar dates (YYYY-MM-DD, no time zone), so it
// is unit tested and the page only passes the result to the finance API (?from&to, at most 366 days per request).

export const PERIOD_PRESETS = ['mtd', 'last_month', 'last_30', 'qtd', 'ytd', 'custom'] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number];
export const COMPARE_MODES = ['previous_period', 'last_year', 'none'] as const;
export type CompareMode = (typeof COMPARE_MODES)[number];
export interface DateRange { from: string; to: string }

/** The finance API's longest period (packages/contracts financePeriod). */
export const MAX_PERIOD_DAYS = 366;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const parse = (d: string) => { const [y, m, day] = d.split('-').map(Number); return { y: y!, m: m!, d: day! }; };
const fmt = (y: number, m: number, d: number) => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const utc = (d: string) => { const p = parse(d); return Date.UTC(p.y, p.m - 1, p.d); };

/** A real calendar date in YYYY-MM-DD form (2026-02-30 is not one). */
export const isDate = (d: unknown): d is string => typeof d === 'string' && DATE.test(d) && new Date(utc(d)).toISOString().slice(0, 10) === d;

export function addDays(date: string, days: number): string {
  return new Date(utc(date) + days * 864e5).toISOString().slice(0, 10);
}

/** Moves a date by whole months, keeping the day where the month has it and clamping to its last day otherwise. */
export function addMonths(date: string, months: number): string {
  const p = parse(date);
  const total = p.y * 12 + (p.m - 1) + months;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  return fmt(y, m, Math.min(p.d, daysInMonth(y, m)));
}

/** Days in a range, both ends included. */
export const periodDays = (r: DateRange) => Math.round((utc(r.to) - utc(r.from)) / 864e5) + 1;

/** A valid finance period: two dates, from ≤ to, at most MAX_PERIOD_DAYS long. */
export const validPeriod = (r: Partial<DateRange> | null | undefined): r is DateRange =>
  !!r && isDate(r.from) && isDate(r.to) && r.from <= r.to && periodDays(r as DateRange) <= MAX_PERIOD_DAYS;

/** The range of a preset ending today (the restaurant's calendar date). */
export function presetRange(preset: Exclude<PeriodPreset, 'custom'>, today: string): DateRange {
  const t = parse(today);
  switch (preset) {
    case 'mtd': return { from: fmt(t.y, t.m, 1), to: today };
    case 'last_month': { const first = addMonths(fmt(t.y, t.m, 1), -1); const p = parse(first); return { from: first, to: fmt(p.y, p.m, daysInMonth(p.y, p.m)) }; }
    case 'last_30': return { from: addDays(today, -29), to: today };
    case 'qtd': return { from: fmt(t.y, Math.floor((t.m - 1) / 3) * 3 + 1, 1), to: today };
    case 'ytd': return { from: fmt(t.y, 1, 1), to: today };
  }
}

/** The preset a range matches (for the picker), or 'custom'. */
export function presetOf(r: DateRange, today: string): PeriodPreset {
  for (const p of PERIOD_PRESETS) {
    if (p === 'custom') continue;
    const x = presetRange(p, today);
    if (x.from === r.from && x.to === r.to) return p;
  }
  return 'custom';
}

/**
 * The comparison range.
 * - previous_period: a range that starts on the 1st of a month (month to date, a whole month, a quarter) compares
 *   with the same span one month (quarter: three months) earlier, so 1-25 Oct compares with 1-25 Sep and October
 *   with September; any other range compares with the same number of days just before it.
 * - last_year: the same dates a year earlier (29 Feb becomes 28 Feb).
 */
export function compareRange(r: DateRange, mode: CompareMode): DateRange | null {
  if (mode === 'none' || !validPeriod(r)) return null;
  if (mode === 'last_year') return { from: addMonths(r.from, -12), to: addMonths(r.to, -12) };
  const f = parse(r.from);
  const to = parse(r.to);
  if (f.d === 1) {
    const months = (to.y - f.y) * 12 + (to.m - f.m) + 1;
    // Whole calendar months (Oct, Q3): the same number of whole months before.
    if (to.d === daysInMonth(to.y, to.m)) {
      const from = addMonths(r.from, -months);
      const end = parse(addMonths(r.from, -1));
      return { from, to: fmt(end.y, end.m, daysInMonth(end.y, end.m)) };
    }
    // Month or quarter to date: the same days of the earlier month(s).
    const shift = months <= 1 ? 1 : months <= 3 ? 3 : 12;
    return { from: addMonths(r.from, -shift), to: addMonths(r.to, -shift) };
  }
  const n = periodDays(r);
  const prevTo = addDays(r.from, -1);
  return { from: addDays(prevTo, -(n - 1)), to: prevTo };
}

/** Change in percent (12.5 = +12.5 %); null without a comparison base (previous 0 or unknown), never Infinity. */
export function deltaPct(current: number | null | undefined, previous: number | null | undefined): number | null {
  if (current === null || current === undefined || previous === null || previous === undefined) return null;
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
}

/**
 * The comparison series aligned with the current period's days (day 1 with day 1 …): values of the comparison range in
 * date order, padded with null where the comparison has fewer days. Missing days in either range count as 0.
 */
export function alignDays(current: DateRange, previous: DateRange, rows: Array<{ date: string; value: number }>): number[] {
  const byDate = new Map(rows.map((r) => [r.date, r.value]));
  const n = periodDays(current);
  const m = periodDays(previous);
  return Array.from({ length: n }, (_, i) => (i < m ? byDate.get(addDays(previous.from, i)) ?? 0 : 0));
}

/** Every day of a range with its value (0 where no row). */
export function fillDays(r: DateRange, rows: Array<{ date: string; value: number }>): Array<{ date: string; value: number }> {
  const byDate = new Map(rows.map((x) => [x.date, x.value]));
  return Array.from({ length: periodDays(r) }, (_, i) => { const date = addDays(r.from, i); return { date, value: byDate.get(date) ?? 0 }; });
}
