import { describe, expect, it } from 'vitest';
import { applyBasisPoints, formatMoney, parseMajor, splitEvenly, sum, taxFromInclusive } from './money';
import { canTransitionOrder, derivePaymentStatus } from './state-machines';
import { assignableRoles, can } from './permissions';

describe('money', () => {
  it('parses decimals without floating point drift', () => {
    expect(parseMajor('145.50', 'EGP')).toBe(14550);
    expect(parseMajor('0.1', 'SAR')).toBe(10);
    expect(parseMajor(19.99, 'EGP')).toBe(1999);
    expect(() => parseMajor('1.234', 'EGP')).toThrow();
  });
  it('splits evenly and always sums to the total', () => {
    for (const [total, parts] of [[10000, 3], [1, 4], [99999, 7], [0, 2]] as const) {
      const shares = splitEvenly(total, parts);
      expect(shares).toHaveLength(parts);
      expect(sum(shares)).toBe(total);
      expect(Math.max(...shares) - Math.min(...shares)).toBeLessThanOrEqual(1);
    }
  });
  it('computes VAT deterministically', () => {
    expect(applyBasisPoints(10000, 1500)).toBe(1500);
    expect(taxFromInclusive(11500, 1500)).toBe(1500);
    expect(taxFromInclusive(11400, 1400)).toBe(1400);
    expect(taxFromInclusive(999, 1500)).toBe(130); // 130.30 → 130
  });
});

describe('money display (VP-26)', () => {
  it('drops .00 on whole amounts by default and keeps the minor digits when asked (guest-facing prices)', () => {
    expect(formatMoney(14500, 'EGP', 'en')).toMatch(/EGP\s?145$/);
    expect(formatMoney(14550, 'EGP', 'en')).toMatch(/EGP\s?145\.50$/);
    expect(formatMoney(14500, 'EGP', 'en', { decimals: 'always' })).toMatch(/EGP\s?145\.00$/);
    expect(formatMoney(14500, 'EGP', 'ar', { decimals: 'always' })).toMatch(/145[.٫]00/);
    expect(formatMoney(14500, 'EGP', 'ar', { decimals: 'always' })).not.toMatch(/[٠-٩]/);
  });
});

describe('state machines', () => {
  it('only allows the fulfillment-appropriate terminal status', () => {
    expect(canTransitionOrder('ready', 'served', 'dine_in')).toBe(true);
    expect(canTransitionOrder('ready', 'served', 'pickup')).toBe(false);
    expect(canTransitionOrder('ready', 'picked_up', 'pickup')).toBe(true);
    expect(canTransitionOrder('served', 'preparing', 'dine_in')).toBe(false);
    expect(canTransitionOrder('awaiting_payment', 'preparing', 'delivery')).toBe(false);
  });
  it('derives payment status from amounts', () => {
    expect(derivePaymentStatus(1000, 0, 0)).toBe('unpaid');
    expect(derivePaymentStatus(1000, 400, 0)).toBe('partially_paid');
    expect(derivePaymentStatus(1000, 1000, 0)).toBe('paid');
    expect(derivePaymentStatus(1000, 1000, 200)).toBe('partially_refunded');
    expect(derivePaymentStatus(1000, 1000, 1000)).toBe('refunded');
  });
});

describe('permissions', () => {
  it('keeps privilege boundaries', () => {
    expect(can('kitchen', 'payments:refund')).toBe(false);
    expect(can('driver', 'orders:read')).toBe(false);
    expect(can('manager', 'billing:manage')).toBe(false);
    expect(can('owner', 'billing:manage')).toBe(true);
    expect(assignableRoles('admin')).not.toContain('owner');
    expect(assignableRoles('manager')).toEqual([]);
  });
});
