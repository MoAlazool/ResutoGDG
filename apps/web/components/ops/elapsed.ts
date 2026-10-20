// Ticket timers for the kitchen board (VS-10 / VS-25). A ticket shows m:ss for the first hour, h:mm up to a day and
// whole days beyond ("2839:59" for a two-day-old ticket was noise). Lateness follows the ticket's own age in service:
// amber from 15 minutes, red from 25; a ticket older than 12 hours is no longer "late", it is stale (left open from an
// earlier service) and is shown as such instead of painting every old ticket red. Western digits in both languages.

export const LATE_MIN = 15;
export const VERY_LATE_MIN = 25;
export const STALE_HOURS = 12;

const pad = (n: number) => String(n).padStart(2, '0');

/** "4:07", "1:05:00" style is avoided: under an hour m:ss, under a day h:mm with an "h" mark, then "Nd". */
export function ticketAge(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 3600) return `${Math.floor(s / 60)}:${pad(s % 60)}`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ${pad(Math.floor((s % 3600) / 60))}`;
  return `${Math.floor(s / 86_400)}d`;
}

export type Lateness = 'fresh' | 'late' | 'very-late' | 'stale';

export function lateness(seconds: number): Lateness {
  const m = seconds / 60;
  if (m >= STALE_HOURS * 60) return 'stale';
  if (m >= VERY_LATE_MIN) return 'very-late';
  if (m >= LATE_MIN) return 'late';
  return 'fresh';
}

/** A placed ticket is "new" (pulses) for its first minute, computed from the server clock (PCL-19: not a stale flag). */
export const isNewTicket = (status: string, placedAt: string, serverNow: number) =>
  status === 'placed' && serverNow - Date.parse(placedAt) < 60_000;
