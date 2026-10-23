// Conditional GET for signed-in reads (REM-W02, PCL-24). useApi's fetcher goes through revalidatingCall: it sends the
// ETag of the caller's last answer for the same URL as If-None-Match, and a 304 resolves to that same answer object (no
// body, no JSON parse, unchanged identity so nothing that depends on it recomputes). Staff bundles only: lib/api.ts
// carries just the onResponse hook.
//
// Validators live in memory only (never storage; bounded LRU), keyed by the bearer token, the URL and the request
// headers, so one user's answer is never returned to another user or to another tenant/filter. The session drops them
// all on sign-out or a user switch (forgetValidators). Answers assembled from several pages (X-Resuto-List: full) are
// not remembered: the ETag covers the first page only.
//
// The browser HTTP cache is not involved: staff responses stay `no-store` (PCL-03/04), and a request that carries
// If-None-Match bypasses the HTTP cache by definition (Fetch), so the 304 reaches this code instead of a stored copy.
// Cross-origin, the browser can read ETag only when the API lists it in Access-Control-Expose-Headers; without it
// these stay plain GETs.
import { ApiRequestError, type ApiOptions } from './api';

const MAX_VALIDATORS = 100;
const validators = new Map<string, { etag: string; data: unknown }>();

/** What a revalidating answer is remembered under. */
export const conditionalKey = (path: string, token: string | null | undefined, headers: Record<string, string> | undefined) =>
  `${token ?? ''}\n${path}\n${JSON.stringify(Object.entries(headers ?? {}).sort(([a], [b]) => a.localeCompare(b)))}`;

/** Drops every remembered validator (sign-out, user switch; tests). */
export function forgetValidators() { validators.clear(); }

/** Number of remembered validators (tests, probes). */
export const validatorCount = () => validators.size;

function remember(key: string, etag: string, data: unknown) {
  validators.delete(key);
  validators.set(key, { etag, data });
  while (validators.size > MAX_VALIDATORS) validators.delete(validators.keys().next().value!);
}

type Call = <T>(path: string, opts?: Omit<ApiOptions, 'token'>) => Promise<T>;

/**
 * A GET through `call` (useSession().call: auth recovery included) that revalidates with the last ETag. `token`
 * partitions the memory per user; without a token the read is a plain GET.
 */
export async function revalidatingCall<T>(call: Call, path: string, token: string | null, opts: Omit<ApiOptions, 'token' | 'onResponse'> = {}): Promise<T> {
  if (!token) return call<T>(path, opts);
  const key = conditionalKey(path, token, opts.headers);
  const known = validators.get(key);
  let first: { etag: string | null; full: boolean } | null = null;
  const headers = known
    // A request with If-None-Match runs in fetch's "no-store" mode, and fetch then adds `Cache-Control: no-cache`
    // unless the request has its own Cache-Control. Express (its `fresh` check) treats no-cache as a forced reload and
    // never answers 304; `max-age=0` asks for the same end-to-end revalidation without that effect.
    ? { ...opts.headers, 'If-None-Match': known.etag, 'Cache-Control': 'max-age=0' }
    : opts.headers;
  const onResponse = (res: Response) => {
    // Only the first page's headers count (a full list fetches more pages through the same options).
    if (!first) first = { etag: res.headers.get('etag'), full: res.headers.get('x-resuto-list') === 'full' };
  };
  try {
    const data = await call<T>(path, { ...opts, headers, onResponse } as Omit<ApiOptions, 'token'>);
    const r = first as { etag: string | null; full: boolean } | null;
    if (r?.etag && !r.full) remember(key, r.etag, data);
    else validators.delete(key);
    return data;
  } catch (e) {
    if (known && e instanceof ApiRequestError && e.status === 304) {
      // Unchanged since the remembered answer: hand back that same object.
      remember(key, known.etag, known.data);
      return known.data as T;
    }
    throw e;
  }
}
