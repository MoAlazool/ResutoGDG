'use client';
import { useCallback, useEffect, useReducer, useRef } from 'react';
import { ApiRequestError } from './api';
import { queryCache, resourceOf } from './query-cache';
import { useSession } from './session';

export interface ApiState<T> {
  data: T | undefined;
  error: ApiRequestError | null;
  /** True only while there is nothing to show yet (render a layout-matched skeleton). */
  loading: boolean;
  /** True while a background refresh runs and the current data stays visible. */
  refreshing: boolean;
  /** When `data` was fetched (ms epoch), 0 when unknown. */
  updatedAt: number;
  reload(): Promise<void>;
  setData(next: T): void;
}

const asError = (e: unknown) => (e instanceof ApiRequestError ? e : new ApiRequestError(0, 'unknown', String(e)));

/**
 * Loads an authenticated API resource through the shared query cache (lib/query-cache.ts). `path` null skips loading.
 * - Same-key data is shown immediately on remount and revalidated in the background (`refreshing`).
 * - Changing filters or pages of the same resource keeps the previous result visible until the new one arrives;
 *   a different resource, tenant or user never shows another key's data.
 * - `pollMs` refreshes in the background while the tab is visible, and once when it becomes visible again.
 * - Requests are shared between components, cancelled when nothing needs them, and mutations made through
 *   `useSession().call` invalidate the tenant's queries.
 */
export function useApi<T = any>(path: string | null, opts: { pollMs?: number; staleMs?: number } = {}): ApiState<T> {
  const { call, token, ready, me } = useSession();
  const [, force] = useReducer((x: number) => x + 1, 0);
  const scope = me?.user?.id ?? (token ? `t:${token.slice(-24)}` : null);
  const key = path && ready && token && scope ? `${scope}|${path}` : null;
  const fetcher = useCallback((signal: AbortSignal) => call<T>(path!, { signal }), [call, path]);
  const staleMs = opts.staleMs ?? 0;

  useEffect(() => {
    if (!key) return;
    const unsubscribe = queryCache.subscribe(key, force, fetcher);
    const e = queryCache.get(key);
    if (!e || e.stale || !e.updatedAt || Date.now() - e.updatedAt >= staleMs) queryCache.fetch(key, fetcher).catch(() => undefined);
    else force();
    return unsubscribe;
  }, [key, fetcher, staleMs]);

  useEffect(() => {
    if (!key || !opts.pollMs) return;
    const pollMs = opts.pollMs;
    const tick = () => { if (document.visibilityState === 'visible') queryCache.fetch(key, fetcher).catch(() => undefined); };
    const timer = setInterval(tick, pollMs);
    const onVisible = () => {
      const e = queryCache.get(key);
      if (document.visibilityState === 'visible' && (!e || Date.now() - e.updatedAt >= pollMs)) tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [key, fetcher, opts.pollMs]);

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
    updatedAt: entry?.updatedAt ?? 0,
    reload: async () => { if (key) await queryCache.refetch(key, fetcher).then(() => undefined, () => undefined); },
    setData: (next: T) => { if (key) queryCache.set(key, next); },
  };
}
