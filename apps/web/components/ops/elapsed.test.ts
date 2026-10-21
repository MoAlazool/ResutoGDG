import { describe, expect, it } from 'vitest';
import { translate } from '../../lib/i18n/messages';
import { isNewTicket, lateness, ticketAge, type AgeUnits } from './elapsed';

describe('kitchen ticket timers (VS-10 / VS-25)', () => {
  it('reads m:ss for the first hour, h mm up to a day, then days', () => {
    expect(ticketAge(0)).toBe('0:00');
    expect(ticketAge(65)).toBe('1:05');
    expect(ticketAge(59 * 60 + 59)).toBe('59:59');
    expect(ticketAge(3600)).toBe('1h 00');
    expect(ticketAge(2 * 3600 + 7 * 60)).toBe('2h 07');
    // The audit saw "2839:59" and "26511:11" for old demo tickets.
    expect(ticketAge(2839 * 60 + 59)).toBe('1d');
    expect(ticketAge(26511 * 60)).toBe('18d');
  });

  it('takes the hour and day marks from the dictionary, so the Arabic board has no Latin units (DF-15 / VS-21)', () => {
    const units = (locale: 'en' | 'ar'): AgeUnits => ({
      hours: (h, mm) => translate(locale, 'ops.kds.ageHours', { h, mm }), days: (d) => translate(locale, 'ops.kds.ageDays', { d }),
    });
    expect(ticketAge(2 * 3600 + 7 * 60, units('en'))).toBe('2h 07');
    expect(ticketAge(3 * 86_400, units('en'))).toBe('3d');
    const ar = [ticketAge(2 * 3600 + 7 * 60, units('ar')), ticketAge(86_400, units('ar')), ticketAge(3 * 86_400, units('ar')), ticketAge(19 * 86_400, units('ar'))];
    expect(ar).toEqual(['2 س 07', 'يوم', '3 أيام', '19 يومًا']);
    for (const v of ar) expect(v).not.toMatch(/[A-Za-z]/); // Western digits, Arabic units
    expect(ticketAge(65, units('ar'))).toBe('1:05');
  });

  it('marks lateness by the ticket age and old tickets as stale, not red', () => {
    expect(lateness(5 * 60)).toBe('fresh');
    expect(lateness(16 * 60)).toBe('late');
    expect(lateness(30 * 60)).toBe('very-late');
    expect(lateness(13 * 3600)).toBe('stale');
  });

  it('computes "new" from the server clock', () => {
    const now = Date.parse('2026-10-20T12:00:30Z');
    expect(isNewTicket('placed', '2026-10-20T12:00:00Z', now)).toBe(true);
    expect(isNewTicket('placed', '2026-10-20T11:58:00Z', now)).toBe(false);
    expect(isNewTicket('accepted', '2026-10-20T12:00:00Z', now)).toBe(false);
  });
});
