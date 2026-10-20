import { describe, expect, it } from 'vitest';
import { phoneE164 } from './common';
import { deliverJob } from './delivery';
import { supplierInput } from './inventory';
import { toWesternDigits } from './locale-format';
import { branchInput } from './platform';
import { reservationHoldRequest, staffReservationInput } from './reservations';

// CR-04: numbers typed on an Arabic keyboard (٠-٩, ۰-۹) are accepted where the API expects digits and are stored
// as 0-9, so phone links, search and codes work; free text is never rewritten.

const hold = {
  branchId: '00000000-0000-4000-8000-000000000001', date: '2026-10-20', time: '19:30', partySize: 2,
  guestName: 'منى', key: 'key-12345678',
};

describe('Western digits at the API boundary', () => {
  it('toWesternDigits converts digits only', () => {
    expect(toWesternDigits('+٢٠١٠٠١١١٢٢٩٩')).toBe('+201001112299');
    expect(toWesternDigits('۱۲۳۴')).toBe('1234');
    expect(toWesternDigits('١٬٢٥٠٫٥ شارع ٢٦ يوليو')).toBe('1٬250٫5 شارع 26 يوليو');
    expect(toWesternDigits('Table 7')).toBe('Table 7');
  });

  it('phone numbers in E.164 accept Arabic-Indic digits and store 0-9', () => {
    expect(phoneE164.parse('+٢٠١٠٠١١١٢٢٩٩')).toBe('+201001112299');
    expect(phoneE164.parse('+201001112299')).toBe('+201001112299');
    expect(phoneE164.safeParse('+20 100').success).toBe(false);
    expect(phoneE164.safeParse('٠١٠٠١١١٢٢٩٩').success).toBe(false); // still needs the country code
  });

  it('the guest booking phone and staff phones are normalised', () => {
    expect(reservationHoldRequest.parse({ ...hold, guestPhone: '+٢٠١٠٩٠٠٠١٠٠٤' }).guestPhone).toBe('+201090001004');
    expect(staffReservationInput.parse({ ...hold, guestPhone: '٠١٠٩٠٠٠١٠٠٤' }).guestPhone).toBe('01090001004');
    expect(staffReservationInput.parse({ ...hold }).guestPhone).toBeUndefined();
    expect(staffReservationInput.parse({ ...hold, guestPhone: null }).guestPhone).toBeNull();
    expect(supplierInput.parse({ name: 'Nile Farms', phone: '٠١٢ ٣٤٥' }).phone).toBe('012 345');
    expect(branchInput.parse({ name: 'Zamalek', phone: '٠٢٢٧٣٥' }).phone).toBe('022735');
  });

  it('the 4-digit delivery code typed in Arabic is accepted', () => {
    const at = { latitude: 30.05, longitude: 31.22 };
    const parsed = deliverJob.safeParse({ ...at, otp: '٤٨١٥' });
    expect(parsed.success && parsed.data.otp).toBe('4815');
    expect(deliverJob.safeParse({ ...at, otp: '48a5' }).success).toBe(false);
  });
});
