import { moneyNumberFormat } from './locale-format';
// Integer minor-unit money helpers. All amounts are integers (piastres/halalas);
// floating point never touches persisted money.
import type { z } from 'zod';
import type { currencyCode } from './common';

export type Currency = z.infer<typeof currencyCode>;

const MINOR_DIGITS: Record<Currency, number> = { EGP: 2, SAR: 2, USD: 2 };

export function assertMinor(value: number, label = 'amount'): number {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${label} must be an integer number of minor units`);
  return value;
}

/** Parses a decimal string like "145.50" into minor units without floating point. */
export function parseMajor(value: string | number, currency: Currency): number {
  const digits = MINOR_DIGITS[currency];
  const s = typeof value === 'number' ? value.toFixed(digits) : value.trim();
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new RangeError(`Invalid amount: ${value}`);
  const frac = (m[3] ?? '').padEnd(digits, '0');
  if (frac.length > digits) throw new RangeError(`Too many decimals for ${currency}: ${value}`);
  const result = Number(m[2]) * 10 ** digits + Number(frac || '0');
  return assertMinor(m[1] ? -result : result);
}

export function formatMoney(amountMinor: number, currency: Currency, locale: 'en' | 'ar' = 'en'): string {
  const digits = MINOR_DIGITS[currency];
  return moneyNumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: amountMinor % 10 ** digits === 0 ? 0 : digits,
    maximumFractionDigits: digits,
  }).format(amountMinor / 10 ** digits);
}

/** Rounds half away from zero: deterministic and easy to audit. */
function roundDiv(numerator: number, denominator: number): number {
  const q = Math.trunc(numerator / denominator);
  const r = numerator - q * denominator;
  return Math.abs(r) * 2 >= denominator ? q + Math.sign(numerator) : q;
}

/** amount × basis points (1500 = 15%). */
export function applyBasisPoints(amountMinor: number, bp: number): number {
  assertMinor(amountMinor);
  return roundDiv(amountMinor * bp, 10_000);
}

/** Tax contained in a tax-inclusive gross amount. */
export function taxFromInclusive(grossMinor: number, rateBp: number): number {
  assertMinor(grossMinor);
  return roundDiv(grossMinor * rateBp, 10_000 + rateBp);
}

/** Splits a total into `parts` integer shares that always sum to the total. */
export function splitEvenly(totalMinor: number, parts: number): number[] {
  assertMinor(totalMinor);
  if (!Number.isInteger(parts) || parts < 1) throw new RangeError('parts must be a positive integer');
  const base = Math.floor(totalMinor / parts);
  const remainder = totalMinor - base * parts;
  return Array.from({ length: parts }, (_, i) => base + (i < remainder ? 1 : 0));
}

export function sum(values: readonly number[]): number {
  return values.reduce((a, b) => a + assertMinor(b), 0);
}
