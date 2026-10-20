import { describe, expect, it } from 'vitest';
import { formatElapsed, formatElapsedMs, formatWhen } from './format';

const MIN = 60_000;
const EASTERN = /[٠-٩۰-۹]/;

describe('formatElapsedMs (VS-30)', () => {
  it('switches unit as durations grow instead of printing thousands of minutes', () => {
    expect(formatElapsedMs(14 * MIN, 'en')).toMatch(/^14 min/);
    expect(formatElapsedMs(185 * MIN, 'en')).toBe('3h 5m');
    expect(formatElapsedMs(120 * MIN, 'en')).toBe('2 hours');
    expect(formatElapsedMs(20382 * MIN, 'en')).toBe('14 days');
  });

  it('uses Arabic units with Western digits', () => {
    for (const ms of [14 * MIN, 185 * MIN, 20382 * MIN]) {
      const s = formatElapsedMs(ms, 'ar');
      expect(s).not.toMatch(EASTERN);
      expect(s).toMatch(/[0-9]/);
      expect(s).toMatch(/[؀-ۿ]/);
    }
  });

  it('never goes negative and handles missing values', () => {
    expect(formatElapsedMs(-5 * MIN, 'en')).toMatch(/^0 min/);
    expect(formatElapsedMs(null, 'en')).toBe('—');
    expect(formatElapsed(null, 'en')).toBe('—');
    expect(formatElapsed('2026-10-20T10:00:00Z', 'en', Date.parse('2026-10-20T10:30:00Z'))).toMatch(/^30 min/);
  });
});

describe('formatWhen (VS-30)', () => {
  const now = Date.parse('2026-10-20T12:00:00Z');
  const tz = 'UTC'; // deterministic; the restaurant time zone is passed the same way
  it('shows the time for today, "Yesterday" plus time, a weekday within the week, otherwise the date', () => {
    expect(formatWhen('2026-10-20T08:05:00Z', 'en', tz, now)).toBe('08:05');
    expect(formatWhen('2026-10-19T22:05:00Z', 'en', tz, now)).toBe('Yesterday 22:05');
    expect(formatWhen('2026-10-17T22:05:00Z', 'en', tz, now)).toBe('Sat 22:05');
    expect(formatWhen('2026-10-01T20:05:00Z', 'en', tz, now)).toMatch(/1 Oct 2026/);
  });

  it('is Arabic with Western digits', () => {
    const y = formatWhen('2026-10-19T22:05:00Z', 'ar', tz, now);
    expect(y).toContain('أمس');
    expect(y).toContain('10:05');
    expect(y).not.toMatch(EASTERN);
    expect(formatWhen('2026-10-01T20:05:00Z', 'ar', tz, now)).not.toMatch(EASTERN);
  });
});
