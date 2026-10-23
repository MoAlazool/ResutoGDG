'use client';
import { useCallback, useEffect, useReducer, useRef } from 'react';
import { ApiRequestError } from './api';
import { revalidatingCall } from './api-conditional';
import { interactionPaused } from './live-pause';
import { nextPollDelay, queryCache, resourceOf, SECOND, staleTimeFor } from './query-cache';
import { useSession } from './session';

export interface ApiState<T> {
  data: T | undefined;
  error: ApiRequestError | null;
  /** True only while there is nothing to show yet (render a layout-matched skeleton). */
  loading: boolean;
  /** True while a background refresh runs and the current data stays visible. */
  refreshing: boolean;
  /**
   * True while the PREVIOUS filter's or page's result is shown because the new one is still loading: mark the list
   * busy (DataTable `busy`) so stale rows are not mistaken for the new result. Background polls never set it.
   */
  pending: boolean;
  /** When `data` was fetched (ms epoch), 0 when unknown. */
  updatedAt: number;
  reload(): Promise<void>;
  setData(next: T): void;
}

const asError = (e: unknown) => (e instanceof ApiRequestError ? e : new ApiRequestError(0, 'unexpected', (e as Error)?.message ?? String(e)));
const online = () => typeof navigator === 'undefined' || navigator.onLine !== false;
/** While polling is paused for an interaction, how often to check whether it ended. */
const PAUSE_RECHECK_MS = 750;

/**
 * Loads an authenticated API resource through the shared query cache (lib/query-cache.ts). `path` null skips loading.
 * - Reads start as soon as the stored session token is known (in parallel with /me), keyed by the token's user.
 * - Same-key data is shown immediately on remount and revalidated in the background (`refreshing`) once it is older
 *   than its resource class's stale time (staleTimeFor; override with `staleMs`).
 * - Changing filters or pages of the same resource keeps the previous result visible until the new one arrives;
 *   a different resource, tenant or user never shows another key's data.
 * - `pollMs` refreshes in the background while the tab is visible and the browser is online, backing off
 *   exponentially while requests fail; it catches up once when the tab becomes visible or the network returns.
 * - Polls hold still while staff type in a field, work in an open dialog or drag a ticket (lib/live-pause.ts, VS-20)
 *   and catch up as soon as that ends; `pauseWhileEditing: false` opts out (a dialog's own live data).
 * - A poll that returns the same content keeps the previous object (query-cache structural sharing), so an
 *   unchanged revision does not re-render the screen.
 * - Without polling, a stale entry is refreshed when the tab regains focus.
 * - Requests are shared between components, cancelled when nothing needs them, and mutations made through
 *   `useSession().call` invalidate the tenant's queries. A 401 is recovered (or sends the user to sign in) by the
 *   session, not here.
 */
export function useApi<T = any>(path: string | null, opts: { pollMs?: number; staleMs?: number; pauseWhileEditing?: boolean } = {}): ApiState<T> {
  const { call, token, tokenReady, scope } = useSession();
  const [, force] = useReducer((x: number) => x + 1, 0);
  const key = path && tokenReady && token && scope ? `${scope}|${path}` : null;
  // Polls and revisits send the last ETag; an unchanged answer (304) keeps the same object (REM-W02). The memory is
  // partitioned by the signed-in user (scope), which a token refresh does not change.
  const fetcher = useCallback((signal: AbortSignal) => revalidatingCall<T>(call, path!, scope, { signal }), [call, path, scope]);
  const staleMs = opts.staleMs ?? (path ? staleTimeFor(path) : 0);

  useEffect(() => {
    if (!key) return;
    const unsubscribe = queryCache.subscribe(key, force, fetcher);
    const e = queryCache.get(key);
    if (!e || e.stale || !e.updatedAt || Date.now() - e.updatedAt >= staleMs) queryCache.fetch(key, fetcher).catch(() => undefined);
    else force();
    return unsubscribe;
  }, [key, fetcher, staleMs]);

  // Polling with backoff (live operations) or refresh-on-focus (everything else).
  useEffect(() => {
    if (!key) return;
    const pollMs = opts.pollMs;
    const pausable = opts.pauseWhileEditing !== false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const age = () => Date.now() - (queryCache.get(key)?.updatedAt ?? 0);
    const refresh = () => queryCache.fetch(key, fetcher).catch(() => undefined);
    const schedule = () => {
      if (stopped || !pollMs) return;
      clearTimeout(timer);
      const due = nextPollDelay(pollMs, queryCache.get(key)?.failures ?? 0);
      timer = setTimeout(async () => {
        if (pausable && interactionPaused()) {
          // Check again shortly and refresh as soon as the interaction ends (the data may be due by then).
          clearTimeout(timer);
          timer = setTimeout(function wait() {
            if (stopped) return;
            if (interactionPaused()) { timer = setTimeout(wait, PAUSE_RECHECK_MS); return; }
            void (async () => { if (document.visibilityState === 'visible' && online() && age() >= pollMs) await refresh(); schedule(); })();
          }, PAUSE_RECHECK_MS);
          return;
        }
        if (document.visibilityState === 'visible' && online()) await refresh();
        schedule();
      }, due);
    };
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || !online()) return;
      if (pollMs) { if (age() >= pollMs) void refresh().then(schedule); return; }
      // Focus refresh for non-polled reads: only when stale, and not more than every 30 s (quick tab switches).
      if (age() >= Math.max(30 * SECOND, Math.min(staleMs || 30 * SECOND, 60 * SECOND))) void refresh();
    };
    schedule();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [key, fetcher, opts.pollMs, opts.pauseWhileEditing, staleMs]);

  const entry = key ? queryCache.get<T>(key) : undefined;
  // Previous result of the same resource and scope (filter/page change): stays visible while the new one loads.
  const last = useRef<{ key: string; data: T } | null>(null);
  if (key && entry?.data !== undefined) last.current = { key, data: entry.data };
  const sameResource = !!(key && last.current && last.current.key !== key && scope && last.current.key.startsWith(`${scope}|`)
    && resourceOf(last.current.key) === resourceOf(key));
  const data = entry?.data !== undefined ? entry.data : sameResource ? last.current!.data : undefined;
  const inflight = !!entry?.inflight;
  const error = entry?.error && !inflight ? asError(entry.error) : null;

  return {
    data,
    error,
    loading: !!path && data === undefined && !error,
    refreshing: data !== undefined && (inflight || (entry?.data === undefined && sameResource)),
    pending: data !== undefined && entry?.data === undefined && sameResource,
    updatedAt: entry?.updatedAt ?? 0,
    reload: async () => { if (key) await queryCache.refetch(key, fetcher).then(() => undefined, () => undefined); },
    setData: (next: T) => { if (key) queryCache.set(key, next); },
  };
}
