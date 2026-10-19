import { describe, expect, it } from 'vitest';
import {
  formatClock, formatCompact, formatDate, formatDateTime, formatNumber, formatPercent, formatTime,
  hasEasternDigits, intlLocale, isoDateIn, normalizeNumericInput,
} from './locale-format';
import { formatMoney } from './money';

// Strip bidi control marks the Arabic locale adds around numbers, so assertions read naturally.
const plain = (s: string) => s.replace(/[‎‏؜⁦-⁩]/g, '');

describe('Western digits in both languages', () => {
  it('formats plain numbers with 0-9 and Western separators', () => {
    expect(formatNumber(250, 'ar')).toBe('250');
    expect(formatNumber(1250.5, 'ar', { minimumFractionDigits: 2 })).toBe('1,250.50');
    expect(formatNumber(1250.5, 'en', { minimumFractionDigits: 2 })).toBe('1,250.50');
  });

  it('formats money with 0-9 in Arabic and keeps the currency', () => {
    const ar = plain(formatMoney(125050, 'EGP', 'ar'));
    expect(hasEasternDigits(ar)).toBe(false);
    expect(ar).toContain('1,250.50');
    expect(ar).toContain('ج.م');
    expect(plain(formatMoney(125050, 'SAR', 'ar'))).toContain('1,250.50');
    expect(formatMoney(125050, 'EGP', 'en')).toMatch(/EGP\s?1,250\.50/);
    expect(plain(formatMoney(25000, 'EGP', 'ar'))).toContain('250');
  });

  it('formats percentages and compact numbers with 0-9', () => {
    expect(plain(formatPercent(0.15, 'ar'))).toBe('15%');
    expect(formatPercent(0.15, 'en')).toBe('15%');
    expect(hasEasternDigits(formatCompact(125000, 'ar'))).toBe(false);
    expect(formatCompact(125000, 'ar')).toContain('125');
  });

  it('formats dates and times with 0-9 in the branch time zone', () => {
    const iso = '2026-10-19T06:30:00Z'; // 09:30 in Cairo (EEST, UTC+3)
    const ar = formatDateTime(iso, 'ar', 'Africa/Cairo');
    expect(hasEasternDigits(ar)).toBe(false);
    expect(ar).toContain('2026');
    expect(plain(formatTime(iso, 'ar', 'Africa/Cairo'))).toMatch(/9:30/);
    expect(formatDate(iso, 'en', 'Africa/Cairo')).toBe('19 Oct 2026');
    expect(plain(formatClock(9, 30, 'ar', 'h23'))).toBe('09:30');
    expect(formatClock(9, 30, 'en', 'h23')).toBe('09:30');
    expect(isoDateIn('2026-10-19T22:30:00Z', 'Africa/Cairo')).toBe('2026-10-20');
  });

  it('pins the Latin numbering system even for toLocaleString callers', () => {
    expect(hasEasternDigits((1234567).toLocaleString(intlLocale('ar')))).toBe(false);
    expect(hasEasternDigits(new Date('2026-10-19T06:30:00Z').toLocaleString(intlLocale('ar')))).toBe(false);
  });

  it('renders missing or invalid values as an em dash', () => {
    expect(formatNumber(null)).toBe('—');
    expect(formatNumber(Number.NaN)).toBe('—');
    expect(formatDate('not a date')).toBe('—');
    expect(formatTime(undefined)).toBe('—');
  });
});

describe('numeric input normalisation', () => {
  it('converts Arabic-Indic and Persian digits and Arabic separators', () => {
    expect(normalizeNumericInput('١٢٥٠٫٥٠')).toBe('1250.50');
    expect(normalizeNumericInput('۱۲۳')).toBe('123');
    expect(normalizeNumericInput('١٬٢٥٠')).toBe('1,250');
    expect(normalizeNumericInput('42')).toBe('42');
  });
});
