import { describe, expect, it } from 'vitest';
import { fixTime } from './location';

describe('fixTime', () => {
  const now = Date.parse('2026-10-24T13:00:00.000Z');

  it('keeps a plausible fix timestamp', () => {
    expect(fixTime(now - 5_000, now)).toBe('2026-10-24T12:59:55.000Z');
  });

  it('uses the arrival time for a timestamp that is not epoch milliseconds or is skewed', () => {
    expect(fixTime(1_792_825_158_000_000, now)).toBe('2026-10-24T13:00:00.000Z'); // WebKit emulation (year 58783)
    expect(fixTime(now - 2 * 3_600_000, now)).toBe('2026-10-24T13:00:00.000Z');
    expect(fixTime(now + 10 * 60_000, now)).toBe('2026-10-24T13:00:00.000Z');
    expect(fixTime(Number.NaN, now)).toBe('2026-10-24T13:00:00.000Z');
  });
});
