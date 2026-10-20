import { describe, expect, it } from 'vitest';
import { webOrderRequest } from './orders';
import { guestPhone, normalizePhone } from './phone';
import { reservationHoldRequest } from './reservations';

// CR-06: guests type their number the way they know it. Legacy accepted any contact text; the new stack rejected
// everything but +E.164 with an English message. Local Egyptian and Saudi forms, separators and Arabic-Indic digits
// are now accepted and normalised to E.164 with the restaurant's country.

describe('normalizePhone', () => {
  it('Egyptian local, spaced, dashed, bracketed, Arabic-Indic and international forms', () => {
    for (const typed of ['01001234567', '010 0123 4567', '010-0123-4567', '(010) 01234567', '٠١٠٠١٢٣٤٥٦٧', '۰۱۰۰۱۲۳۴۵۶۷',
      '+201001234567', '+٢٠١٠٠١٢٣٤٥٦٧', '00201001234567', '201001234567', '1001234567', '⁦+20 100 123 4567⁩']) {
      expect(normalizePhone(typed, 'EG'), typed).toBe('+201001234567');
    }
    expect(normalizePhone('0227354321', 'EG')).toBe('+20227354321'); // Cairo landline
    expect(normalizePhone('034876543', 'EG')).toBe('+2034876543'); // Alexandria landline
    expect(normalizePhone('01501234567', 'EG')).toBe('+201501234567');
  });

  it('Saudi local and international forms', () => {
    for (const typed of ['0501234567', '050 123 4567', '٠٥٠١٢٣٤٥٦٧', '501234567', '+966501234567', '00966501234567', '966501234567']) {
      expect(normalizePhone(typed, 'SA'), typed).toBe('+966501234567');
    }
    expect(normalizePhone('0112345678', 'SA')).toBe('+966112345678'); // Riyadh landline
  });

  it('international numbers keep their own country; junk is rejected', () => {
    expect(normalizePhone('+966501234567', 'EG')).toBe('+966501234567');
    expect(normalizePhone('+447700900123', 'SA')).toBe('+447700900123');
    for (const bad of ['', '123', 'call me', '+0123456789', '0100123', '01301234567', '05012345', '+20 100']) {
      expect(normalizePhone(bad, 'EG'), bad).toBeNull();
    }
    expect(normalizePhone('01001234567', 'SA')).toBeNull(); // an Egyptian mobile is not a Saudi local number
  });
});

describe('guest phone request fields', () => {
  const base = { branchId: '00000000-0000-4000-8000-000000000001', fulfillment: 'pickup', payment: 'pay_at_pickup',
    lines: [{ productId: '00000000-0000-4000-8000-000000000002', quantity: 1 }] };
  it('accept local forms and Arabic-Indic digits (compacted, Western digits)', () => {
    const p = webOrderRequest.parse({ ...base, customer: { name: 'منى', phone: '٠١٠ ٠١٢٣ ٤٥٦٧' } });
    expect(p.customer.phone).toBe('01001234567');
    const hold = { branchId: base.branchId, date: '2026-10-20', time: '19:30', partySize: 2, guestName: 'Mona', key: 'key-12345678' };
    expect(reservationHoldRequest.parse({ ...hold, guestPhone: '050 123 4567' }).guestPhone).toBe('0501234567');
    expect(guestPhone.safeParse('call me').success).toBe(false);
    expect(guestPhone.safeParse('12').error?.issues[0]?.message).toBe('phone_invalid');
  });
});
