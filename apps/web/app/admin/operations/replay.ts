// Admin operations: what a refused handler replay tells the operator, and status words instead of codes (REM-W07).
import { ApiRequestError } from '@/lib/api';
import { dateTime } from '@/lib/format';
import type { Locale } from '@/lib/i18n';

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/**
 * A replay the API refused. 409 run_in_progress means a timed-out run may still hold its lease: say when it can be
 * replayed (details.retryAfter, else the Retry-After seconds) as a warning, not a failure. Anything else is an error.
 */
export function replayFailure(e: unknown, t: Translate, locale: Locale, now = Date.now()): { tone: 'warn' | 'danger'; text: string } {
  if (e instanceof ApiRequestError && e.code === 'run_in_progress') {
    const d = (e.details ?? {}) as { retryAfter?: string; retryAfterSeconds?: number };
    const at = typeof d.retryAfter === 'string' && !Number.isNaN(Date.parse(d.retryAfter)) ? d.retryAfter
      : typeof d.retryAfterSeconds === 'number' ? new Date(now + d.retryAfterSeconds * 1000).toISOString() : null;
    if (at) return { tone: 'warn', text: t('ops.admin.replayLater', { time: dateTime(at, locale) }) };
  }
  return { tone: 'danger', text: (e as Error)?.message ?? String(e) };
}

/** Handler, webhook and job status codes as words ("running" handler runs are the stuck ones). */
export function opsStatusLabel(status: string, s: { failed: string; dead: string; rejected: string }, t: Translate, kind: 'handler' | 'webhook' | 'job'): string {
  if (kind === 'handler' && status === 'running') return t('ops.admin.stuck');
  if (status === 'failed') return s.failed;
  if (status === 'dead') return s.dead;
  if (status === 'rejected') return s.rejected;
  const key = `ops.admin.job.${status}`;
  const v = t(key);
  return v === key ? status : v;
}
