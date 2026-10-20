'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { formatTime } from '@resuto/contracts';
import type { UiLocale } from './overlays';

// Loading, refresh and failure states shared by every screen (docs/ui/LOADING_STATES.md):
// - initial load: layout-matched skeletons with stable geometry (no spinners, no fake progress);
// - background refresh: data stays visible, a small freshness line says it is updating;
// - failure: data is kept, the kind of failure is named (offline, signed out, no access, not in plan,
//   validation, server/provider), and a controlled retry is offered.

const T = {
  en: {
    updating: 'Updating…', updated: 'Updated', retry: 'Retry', retrying: 'Retrying…',
    offline: 'You appear to be offline. Showing what was last loaded; it will refresh when you reconnect.',
    offlineTitle: 'No connection',
    offlineEmpty: 'You appear to be offline. Reconnect, then retry.',
    unreachableTitle: 'Cannot reach Resuto', unreachable: 'Resuto is not responding right now. Your data is safe; retry in a moment.',
    unreachableStale: 'Cannot reach Resuto. Showing data from', session: 'Your session has ended. Sign in again to continue.', sessionTitle: 'Signed out',
    forbidden: 'Your role does not have access to this.', forbiddenTitle: 'No access',
    plan: 'This module is not included in the restaurant’s plan.', planTitle: 'Not in your plan',
    notFound: 'This item no longer exists or was moved.', notFoundTitle: 'Not found',
    conflict: 'Someone else changed this at the same time. Reload to see the latest version.', conflictTitle: 'Changed elsewhere',
    rate: 'Too many requests. Wait a moment and retry.', rateTitle: 'Slow down',
    server: 'Something went wrong on our side. Your data is safe; retry in a moment.', serverTitle: 'Could not load',
    refreshFailed: 'Could not refresh. Showing data from', reference: 'Reference',
  },
  ar: {
    updating: 'جارٍ التحديث…', updated: 'آخر تحديث', retry: 'إعادة المحاولة', retrying: 'جارٍ إعادة المحاولة…',
    offline: 'يبدو أنك غير متصل. نعرض آخر ما تم تحميله، وسيتم التحديث عند عودة الاتصال.',
    offlineTitle: 'لا يوجد اتصال',
    offlineEmpty: 'يبدو أنك غير متصل. أعد الاتصال ثم أعد المحاولة.',
    unreachableTitle: 'تعذّر الوصول إلى ريسوتو', unreachable: 'ريسوتو لا يستجيب الآن. بياناتك آمنة؛ أعد المحاولة بعد قليل.',
    unreachableStale: 'تعذّر الوصول إلى ريسوتو. نعرض بيانات من', session: 'انتهت جلستك. سجّل الدخول مرة أخرى للمتابعة.', sessionTitle: 'تم تسجيل الخروج',
    forbidden: 'دورك لا يتيح الوصول إلى هذا.', forbiddenTitle: 'لا توجد صلاحية',
    plan: 'هذه الوحدة غير مشمولة في باقة المطعم.', planTitle: 'غير مشمول في باقتك',
    notFound: 'هذا العنصر لم يعد موجودًا أو تم نقله.', notFoundTitle: 'غير موجود',
    conflict: 'غيّر شخص آخر هذا في الوقت نفسه. أعد التحميل لرؤية أحدث نسخة.', conflictTitle: 'تم التغيير من مكان آخر',
    rate: 'طلبات كثيرة. انتظر قليلًا ثم أعد المحاولة.', rateTitle: 'تمهّل',
    server: 'حدث خطأ من جهتنا. بياناتك آمنة؛ أعد المحاولة بعد قليل.', serverTitle: 'تعذّر التحميل',
    refreshFailed: 'تعذّر التحديث. نعرض بيانات من', reference: 'المرجع',
  },
} as const;

/** The parts of an API error the states need (ApiRequestError satisfies it). */
export interface UiError { status: number; code?: string; message: string; details?: unknown; requestId?: string }

export type FailureKind = 'offline' | 'session' | 'forbidden' | 'plan' | 'notFound' | 'conflict' | 'validation' | 'rate' | 'server';

export function failureKind(e: UiError): FailureKind {
  if (e.status === 0 || e.code === 'network_error') return 'offline';
  if (e.status === 401) return 'session';
  if (e.status === 402 || e.code === 'module_not_entitled' || e.code === 'plan_limit') return 'plan';
  if (e.status === 403) return 'forbidden';
  if (e.status === 404) return 'notFound';
  if (e.status === 409) return 'conflict';
  if (e.status === 429) return 'rate';
  if (e.status === 400 || e.status === 422) return 'validation';
  return 'server';
}

const requestIdOf = (e: UiError) => {
  const d = e.details as { requestId?: string } | undefined;
  return e.requestId ?? (typeof d?.requestId === 'string' ? d.requestId : null);
};

// --- Skeletons -------------------------------------------------------------------------------------
export function SkeletonBlock({ width = '100%', height = 16, radius }: { width?: number | string; height?: number | string; radius?: number }) {
  return <span className="skeleton" aria-hidden="true" style={{ display: 'block', width, height, borderRadius: radius }} />;
}

/** KPI tiles row (overview, finance, analytics). */
export function SkeletonStats({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-4" aria-busy="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="card stat"><SkeletonBlock width="45%" height={12} /><SkeletonBlock width="70%" height={28} /><SkeletonBlock width="35%" height={10} /></div>
      ))}
    </div>
  );
}

/** Table body placeholder with the real column count, so the layout does not jump when rows arrive. */
export function SkeletonTable({ rows = 6, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="table-wrap" aria-busy="true">
      <table className="table">
        <tbody>
          {Array.from({ length: rows }, (_, r) => (
            <tr key={r}>{Array.from({ length: cols }, (_, c) => <td key={c}><SkeletonBlock width={c === 0 ? '70%' : `${40 + ((r + c) % 3) * 15}%`} height={14} /></td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Card grid placeholder (menu, integrations, KDS columns). */
export function SkeletonCards({ count = 6, height = 120 }: { count?: number; height?: number }) {
  return (
    <div className="grid grid-3" aria-busy="true">
      {Array.from({ length: count }, (_, i) => <div key={i} className="card"><SkeletonBlock height={height} radius={10} /></div>)}
    </div>
  );
}

// --- Freshness ---------------------------------------------------------------------------------------
/** Subtle "Updating… / Updated 09:30" line for background refreshes. Never blanks the data. */
export function Freshness({ refreshing, updatedAt, locale = 'en', timeZone }: { refreshing: boolean; updatedAt: number; locale?: UiLocale; timeZone?: string }) {
  const s = T[locale];
  return (
    <span className="freshness muted" role="status" aria-live="polite" data-refreshing={refreshing || undefined}>
      {refreshing ? s.updating : updatedAt ? <>{s.updated} <bdi>{formatTime(updatedAt, locale, timeZone)}</bdi></> : null}
    </span>
  );
}

// --- Failure ------------------------------------------------------------------------------------------
function RetryButton({ onRetry, locale }: { onRetry: () => Promise<unknown> | void; locale: UiLocale }) {
  const [busy, setBusy] = useState(false);
  const s = T[locale];
  return (
    <button type="button" className="btn btn-sm" disabled={busy} aria-busy={busy}
      onClick={async () => { if (busy) return; setBusy(true); try { await onRetry(); } finally { setBusy(false); } }}>
      {busy ? s.retrying : s.retry}
    </button>
  );
}

/**
 * Copy for a request that got no answer, by cause: the device reports no network ('device'), or the device is online
 * and Resuto itself did not answer ('api'). `hasData` says whether earlier data is still on screen; only then may the
 * copy say "showing what was last loaded".
 */
export function noAnswerCopy(locale: UiLocale, online: boolean, hasData: boolean): { title: string; body: string } {
  const s = T[locale];
  if (!online) return { title: s.offlineTitle, body: hasData ? s.offline : s.offlineEmpty };
  return { title: s.unreachableTitle, body: s.unreachable };
}

/** Full failure state for a section that has nothing to show. */
export function ErrorState({ error, onRetry, locale = 'en' }: { error: UiError; onRetry?: () => Promise<unknown> | void; locale?: UiLocale }) {
  const s = T[locale];
  const online = useOnline();
  const kind = failureKind(error);
  const noAnswer = kind === 'offline' ? noAnswerCopy(locale, online, false) : null;
  const title = noAnswer ? noAnswer.title : kind === 'validation' ? s.serverTitle : s[`${kind}Title` as const];
  const body = noAnswer ? noAnswer.body : kind === 'validation' ? error.message : s[kind];
  const ref = requestIdOf(error);
  const retryable = kind === 'offline' || kind === 'server' || kind === 'rate' || kind === 'conflict';
  return (
    <div className="empty error-state" role="alert" data-kind={kind} data-cause={noAnswer ? (online ? 'unreachable' : 'device-offline') : undefined}>
      <strong>{title}</strong>
      <p>{body}</p>
      {ref && <small className="muted">{s.reference}: <bdi dir="ltr">{ref}</bdi></small>}
      {onRetry && retryable && <RetryButton onRetry={onRetry} locale={locale} />}
    </div>
  );
}

/** Inline notice when a refresh failed but earlier data is still shown. */
export function StaleNotice({ error, updatedAt, onRetry, locale = 'en', timeZone }: { error: UiError; updatedAt: number; onRetry?: () => Promise<unknown> | void; locale?: UiLocale; timeZone?: string }) {
  const s = T[locale];
  const online = useOnline();
  const kind = failureKind(error);
  const since = <bdi>{formatTime(updatedAt, locale, timeZone)}</bdi>;
  return (
    <div className="notice notice-warn stale-notice" role="status" data-kind={kind}>
      <span>{kind === 'offline' && !online ? s.offline : <>{kind === 'offline' ? s.unreachableStale : s.refreshFailed} {since}.</>}</span>
      {onRetry && <RetryButton onRetry={onRetry} locale={locale} />}
    </div>
  );
}

export interface LoadState<T> { data: T | undefined; error: UiError | null; loading: boolean; refreshing?: boolean; updatedAt?: number; reload?: () => Promise<void> }

/**
 * Renders a query's state consistently: skeleton while nothing is available, the failure state when loading failed,
 * an empty state when the data is empty, otherwise the content (with a stale notice if a refresh failed).
 */
export function Loadable<T>({ state, skeleton, isEmpty, empty, children, locale = 'en', timeZone }: {
  state: LoadState<T>; skeleton: ReactNode; isEmpty?: (data: T) => boolean; empty?: ReactNode;
  children: (data: T) => ReactNode; locale?: UiLocale; timeZone?: string;
}) {
  const { data, error, reload } = state;
  if (data === undefined) {
    if (error) return <ErrorState error={error} onRetry={reload} locale={locale} />;
    return <>{skeleton}</>;
  }
  return (
    <>
      {error && <StaleNotice error={error} updatedAt={state.updatedAt ?? 0} onRetry={reload} locale={locale} timeZone={timeZone} />}
      {isEmpty?.(data) && empty !== undefined ? empty : children(data)}
    </>
  );
}

/** True while the browser reports no network; used to pause polling and explain stale data. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  return online;
}
