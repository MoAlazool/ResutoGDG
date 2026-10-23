import { describe, expect, it } from 'vitest';
import { hasEasternDigits } from '@resuto/contracts';
import { ApiRequestError } from '@/lib/api';
import { formatMessage } from '@/lib/i18n/format-message';
import { messagesFor } from '@/lib/i18n/messages';
import { opsStatusLabel, replayFailure } from './replay';

// REM-W07: the admin Operations page replays dead/failed/stuck handler runs (with a reason). A 409 run_in_progress
// (a timed-out run may still hold its lease) says when to retry, in the page language, as a warning.

const tFor = (locale: 'en' | 'ar') => {
  const m = messagesFor(locale, 'staff');
  return (key: string, vars?: Record<string, string | number>) => formatMessage(m[key] ?? key, locale, vars);
};
const busy = (details: unknown) => new ApiRequestError(409, 'run_in_progress', 'A timed-out run may still be in progress; retry after 2026-10-23T14:05:00.000Z', details, 'req-1');
const s = { failed: 'failed', dead: 'dead', rejected: 'rejected' };

describe('replay refused while a timed-out run may still be working', () => {
  it('shows the retry time from details.retryAfter as a warning (EN and AR, Western digits)', () => {
    const en = replayFailure(busy({ retryAfter: '2026-10-23T14:05:00Z', retryAfterSeconds: 90 }), tFor('en'), 'en');
    expect(en.tone).toBe('warn');
    expect(en.text).toMatch(/Try again after .*\d{1,2}:05/);
    const ar = replayFailure(busy({ retryAfter: '2026-10-23T14:05:00Z' }), tFor('ar'), 'ar');
    expect(ar.tone).toBe('warn');
    expect(ar.text).toMatch(/[؀-ۿ]/);
    expect(ar.text).toMatch(/\d{1,2}:05/);
    expect(hasEasternDigits(ar.text)).toBe(false);
  });

  it('falls back to Retry-After seconds, and other failures stay errors with the API message', () => {
    const now = Date.parse('2026-10-23T14:00:00Z');
    expect(replayFailure(busy({ retryAfterSeconds: 300 }), tFor('en'), 'en', now).text).toMatch(/:05/);
    const other = replayFailure(new ApiRequestError(409, 'not_replayable', 'Only dead-lettered, failed or stuck handler runs can be replayed'), tFor('en'), 'en');
    expect(other).toEqual({ tone: 'danger', text: 'Only dead-lettered, failed or stuck handler runs can be replayed' });
  });
});

describe('status words instead of codes', () => {
  it('handlers, webhooks and jobs', () => {
    const t = tFor('ar');
    expect(opsStatusLabel('running', s, t, 'handler')).toBe(t('ops.admin.stuck'));
    expect(opsStatusLabel('dead', s, t, 'handler')).toBe('dead');
    expect(opsStatusLabel('succeeded', s, t, 'job')).toMatch(/[؀-ۿ]/);
    expect(opsStatusLabel('running', s, t, 'job')).toMatch(/[؀-ۿ]/);
    expect(opsStatusLabel('mystery', s, t, 'job')).toBe('mystery');
  });
});
