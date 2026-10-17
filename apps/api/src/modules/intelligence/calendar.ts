// Calendar context for forecasting in Egypt and Saudi Arabia.

/** Python weekday numbers used by the AI service (Monday = 0). Both countries have a Friday–Saturday weekend. */
export const WEEKEND_DAYS = { EG: [4, 5], SA: [4, 5] } as const;
export const WEEKEND_NAMES = ['fri', 'sat'];

/**
 * Approximate first and last day of Ramadan (astronomical / Umm al-Qura estimates). Actual dates
 * depend on moon sighting and can differ by a day per country; responses label the source as
 * `approximate_table`. Extend before 2029.
 */
export const RAMADAN_PERIODS: Array<{ start: string; end: string }> = [
  { start: '2022-04-02', end: '2022-05-01' },
  { start: '2023-03-23', end: '2023-04-20' },
  { start: '2024-03-11', end: '2024-04-09' },
  { start: '2025-03-01', end: '2025-03-29' },
  { start: '2026-02-18', end: '2026-03-19' },
  { start: '2027-02-08', end: '2027-03-09' },
  { start: '2028-01-28', end: '2028-02-25' },
];

export function ramadanBetween(from: string, to: string) {
  return RAMADAN_PERIODS.filter((p) => p.end >= from && p.start <= to);
}

export const addDays = (isoDate: string, days: number) => {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** ISO week key, e.g. 2026-W42 (used in dedupe keys). */
export function isoWeek(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
