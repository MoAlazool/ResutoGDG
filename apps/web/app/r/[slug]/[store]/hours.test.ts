import { hasEasternDigits } from '@resuto/contracts';
import { describe, expect, it } from 'vitest';
import { deliveryArea, openStatus, pickupEta } from './hours';

// 2026-10-20 is a Tuesday (day 2). Cairo is UTC+3 in October 2026.
const at = (iso: string) => new Date(iso);
const HOURS = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, opens: '11:00', closes: '00:00' }));

describe('storefront opening status', () => {
  it('is open inside today’s slot in the branch time zone, including a slot that closes at midnight', () => {
    // Legacy's 12-hour clock ("11:00 AM – 12:00 AM", legacy burger.js).
    const s = openStatus(HOURS, 'Africa/Cairo', at('2026-10-20T20:30:00Z'), 'en');
    expect(s?.open).toBe(true);
    expect(s?.today).toMatch(/^11:00\s?am – 12:00\s?am$/i);
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

describe('storefront delivery area and pickup estimate (PAR-02)', () => {
  const smash = { district: 'Downtown', districtAr: 'وسط البلد', city: 'Cairo' };
  it('labels delivery with the branch district in the page language, never the Latin city on an Arabic page when an Arabic name exists', () => {
    expect(deliveryArea(smash, 'en')).toBe('Downtown');
    expect(deliveryArea(smash, 'ar')).toBe('وسط البلد');
    expect(deliveryArea({ district: 'Downtown', districtAr: null, city: 'Cairo' }, 'ar')).toBe('Downtown');
    expect(deliveryArea({ district: null, districtAr: '  ', city: 'Cairo' }, 'en')).toBe('Cairo');
    expect(deliveryArea({}, 'ar')).toBeNull();
  });

  it('estimates pickup from the median dish preparation time, and says nothing without one', () => {
    expect(pickupEta([12, 14, 13, 12, 10, 8, 9, 5, null])).toBe(12);
    expect(pickupEta([null, undefined, 0])).toBeNull();
    expect(pickupEta([])).toBeNull();
  });
});
