// "Open now · Today 11:00 – 00:00" for a storefront, from the branch's published opening hours in the branch's time
// zone (legacy burger.js hard-coded this line; here it is data, and absent when no hours are published).
import { formatClock } from '@resuto/contracts';

export interface Slot { day: number; opens: string; closes: string }

const minutes = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return (h ?? 0) * 60 + (m ?? 0); };

/** Weekday (0 = Sunday) and minutes past midnight at `now` in `timeZone`. */
export function localNow(now: Date, timeZone: string): { day: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { day, minute: Number(get('hour')) * 60 + Number(get('minute')) };
}

export function validSlots(raw: unknown): Slot[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((h): h is Slot => !!h && typeof h.day === 'number' && h.day >= 0 && h.day <= 6 && /^\d{2}:\d{2}$/.test(h.opens) && /^\d{2}:\d{2}$/.test(h.closes));
}

/**
 * Whether the branch is open at `now`, and today's hours as text. A slot that closes at or before it opens runs past
 * midnight (11:00 – 00:00 is open until midnight; 18:00 – 02:00 is still open at 01:00 the next day).
 * Returns null when the branch publishes no hours, so the page says nothing rather than guessing.
 */
export function openStatus(raw: unknown, timeZone: string, now: Date, locale: 'en' | 'ar'): { open: boolean; today: string | null } | null {
  const slots = validSlots(raw);
  if (!slots.length) return null;
  const { day, minute } = localNow(now, timeZone);
  const yesterday = (day + 6) % 7;
  const open = slots.some((s) => {
    const o = minutes(s.opens), c = minutes(s.closes);
    if (c > o) return s.day === day && minute >= o && minute < c;
    return (s.day === day && minute >= o) || (s.day === yesterday && minute < c);
  });
  const todays = slots.filter((s) => s.day === day).sort((a, b) => a.opens.localeCompare(b.opens));
  const clock = (hhmm: string) => formatClock(Math.floor(minutes(hhmm) / 60) % 24, minutes(hhmm) % 60, locale, 'h23');
  const today = todays.length ? todays.map((s) => `${clock(s.opens)} – ${clock(s.closes)}`).join(', ') : null;
  return { open, today };
}
