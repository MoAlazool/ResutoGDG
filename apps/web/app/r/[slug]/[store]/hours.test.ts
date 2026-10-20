import { hasEasternDigits } from '@resuto/contracts';
import { describe, expect, it } from 'vitest';
import { openStatus } from './hours';

// 2026-10-20 is a Tuesday (day 2). Cairo is UTC+3 in October 2026.
const at = (iso: string) => new Date(iso);
const HOURS = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, opens: '11:00', closes: '00:00' }));

describe('storefront opening status', () => {
  it('is open inside today’s slot in the branch time zone, including a slot that closes at midnight', () => {
    expect(openStatus(HOURS, 'Africa/Cairo', at('2026-10-20T20:30:00Z'), 'en')).toEqual({ open: true, today: '11:00 – 00:00' });
    expect(openStatus(HOURS, 'Africa/Cairo', at('2026-10-20T06:30:00Z'), 'en')?.open).toBe(false); // 09:30 Cairo
  });

  it('handles slots that run past midnight', () => {
    const late = [{ day: 1, opens: '18:00', closes: '02:00' }];
    expect(openStatus(late, 'Africa/Cairo', at('2026-10-19T22:30:00Z'), 'en')?.open).toBe(true); // Tue 01:30 Cairo, Monday's slot
    expect(openStatus(late, 'Africa/Cairo', at('2026-10-20T00:30:00Z'), 'en')?.open).toBe(false); // Tue 03:30
  });

  it('says nothing when no hours are published, and uses Western digits in Arabic', () => {
    expect(openStatus([], 'Africa/Cairo', new Date(), 'en')).toBeNull();
    expect(openStatus(null, 'Africa/Cairo', new Date(), 'en')).toBeNull();
    const ar = openStatus(HOURS, 'Africa/Cairo', at('2026-10-20T20:30:00Z'), 'ar');
    expect(ar?.today).toBeTruthy();
    expect(hasEasternDigits(ar!.today!)).toBe(false);
  });
});
