// "Add to calendar" (legacy reservations.js addToCalendar): a one-event .ics file the phone's calendar opens.

const stamp = (v: string | number) => new Date(v).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/[,;]/g, '\\$&');

/** The iCalendar text for one reservation (UTC times, so the calendar shows them in the phone's own zone). */
export function reservationIcs(r: { id: string; startsAt: string; endsAt: string }, summary: string, now = Date.now()): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Resuto//Reservations//EN', 'BEGIN:VEVENT', `UID:${r.id}@resuto`, `DTSTAMP:${stamp(now)}`,
    `DTSTART:${stamp(r.startsAt)}`, `DTEND:${stamp(r.endsAt)}`, `SUMMARY:${esc(summary)}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
}

export function downloadIcs(r: { id: string; startsAt: string; endsAt: string }, summary: string) {
  const url = URL.createObjectURL(new Blob([reservationIcs(r, summary)], { type: 'text/calendar' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'reservation.ics';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** "mm:ss" left until `until` (Western digits; never negative). */
export function timeLeft(until: string | null, now = Date.now()): { ms: number; text: string } {
  const ms = until ? Math.max(0, Date.parse(until) - now) : 0;
  const s = Math.floor(ms / 1000);
  return { ms, text: `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` };
}
