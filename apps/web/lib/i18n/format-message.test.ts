import { describe, expect, it } from 'vitest';
import { formatMessage } from './format-message';

describe('formatMessage', () => {
  it('interpolates {name} and leaves unknown placeholders visible', () => {
    expect(formatMessage('Hi {name}, table {t}', 'en', { name: 'Mona' })).toBe('Hi Mona, table {t}');
    expect(formatMessage('No vars {x}', 'en')).toBe('No vars {x}');
  });

  it('selects English plural forms', () => {
    const m = '{n, plural, one {# booking} other {# bookings}} · {covers, plural, one {# cover} other {# covers}}';
    expect(formatMessage(m, 'en', { n: 1, covers: 3 })).toBe('1 booking · 3 covers');
    expect(formatMessage(m, 'en', { n: 2, covers: 1 })).toBe('2 bookings · 1 cover');
    expect(formatMessage(m, 'en', { n: 1250, covers: 0 })).toBe('1,250 bookings · 0 covers');
  });

  it('selects the six Arabic plural forms with Western digits', () => {
    const m = '{n, plural, =0 {لا حجوزات} one {حجز واحد} two {حجزان} few {# حجوزات} many {# حجزًا} other {# حجز}}';
    expect([0, 1, 2, 3, 11, 100].map((n) => formatMessage(m, 'ar', { n }))).toEqual(['لا حجوزات', 'حجز واحد', 'حجزان', '3 حجوزات', '11 حجزًا', '100 حجز']);
    expect(formatMessage(m, 'ar', { n: 1500 })).toBe('1,500 حجز');
    expect(formatMessage(m, 'ar', { n: 1500 })).not.toMatch(/[٠-٩]/);
  });

  it('formats nested placeholders inside a branch and accepts numeric strings', () => {
    expect(formatMessage('{n, plural, one {# order at {table}} other {# orders at {table}}}', 'en', { n: '2', table: 'T4' })).toBe('2 orders at T4');
  });

  it('keeps the template visible when the count is missing', () => {
    const m = '{n, plural, one {# item} other {# items}}';
    expect(formatMessage(m, 'en', {})).toBe(m);
  });

  // Callers sometimes pass a count they already formatted. The raw plural syntax must never reach the screen.
  it('accepts pre-formatted counts and uses the other form for non-numeric text', () => {
    const m = '{n, plural, one {# item} other {# items}}';
    expect(formatMessage(m, 'en', { n: '1,234' })).toBe('1,234 items');
    expect(formatMessage(m, 'en', { n: '1' })).toBe('1 item');
    expect(formatMessage(m, 'en', { n: '—' })).toBe('— items');
  });
});
