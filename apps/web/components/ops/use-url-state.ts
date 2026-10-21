'use client';
// Page state that survives a reload and can be shared as a link (PCL-20): tabs, views and list filters live in the
// URL search params (router.replace, no scroll, no history spam) instead of component state.
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback } from 'react';

/** Reads one search param, falling back when it is missing or not one of `allowed`. */
export function pickParam<T extends string>(value: string | null, fallback: T, allowed?: readonly T[]): T {
  if (value === null || value === '') return fallback;
  if (allowed && !allowed.includes(value as T)) return fallback;
  return value as T;
}

/** Returns the URL with `patch` applied (null or the fallback value removes the key). */
export function withParams(current: string, patch: Record<string, string | null>, fallbacks: Record<string, string> = {}): string {
  const q = new URLSearchParams(current);
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === '' || v === fallbacks[k]) q.delete(k);
    else q.set(k, v);
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

/**
 * One URL-backed value. `set` replaces the current history entry, so Back still leaves the page. The value is
 * removed from the URL when it equals the fallback, keeping plain links clean.
 */
export function useUrlParam<T extends string>(name: string, fallback: T, allowed?: readonly T[]): [T, (v: T) => void] {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const value = pickParam(params.get(name), fallback, allowed);
  const set = useCallback((v: T) => {
    const next = withParams(window.location.search, { [name]: v }, { [name]: fallback });
    router.replace(`${pathname}${next}`, { scroll: false });
  }, [name, fallback, pathname, router]);
  return [value, set];
}
