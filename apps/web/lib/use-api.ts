'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiRequestError } from './api';
import { useSession } from './session';

export interface ApiState<T> {
  data: T | undefined;
  error: ApiRequestError | null;
  loading: boolean;
  reload(): Promise<void>;
  setData(next: T): void;
}

/**
 * Loads an authenticated API resource. `path` null skips loading.
 * `pollMs` re-fetches in the background (kitchen, dispatch, inbox screens),
 * pausing while the tab is hidden.
 */
export function useApi<T = any>(path: string | null, opts: { pollMs?: number } = {}): ApiState<T> {
  const { call, token, ready } = useSession();
  const [data, setData] = useState<T>();
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [loading, setLoading] = useState(!!path);
  const seq = useRef(0);

  const load = useCallback(async (background = false) => {
    if (!path || !ready || !token) return;
    const id = ++seq.current;
    if (!background) setLoading(true);
    try {
      const result = await call<T>(path);
      if (id === seq.current) { setData(result); setError(null); }
    } catch (e) {
      if (id === seq.current) setError(e instanceof ApiRequestError ? e : new ApiRequestError(0, 'unknown', String(e)));
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, [path, call, ready, token]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!opts.pollMs) return;
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void load(true); }, opts.pollMs);
    return () => clearInterval(timer);
  }, [load, opts.pollMs]);

  return { data, error, loading, reload: () => load(true), setData };
}
