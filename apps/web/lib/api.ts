// Typed fetch wrapper for the Resuto API. All business data goes through the
// NestJS API; the browser never talks to the database directly.
import { reportConnection } from './connection';

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');

/**
 * What went wrong, independent of the endpoint. Screens choose their copy and recovery from this, never from raw
 * messages: offline → keep data and retry on reconnect; unauthorized → session recovery; forbidden/not_found → no
 * retry; validation → show the field errors; conflict → reload; rate_limited/server → retry later.
 */
export type ApiErrorKind =
  | 'offline' | 'aborted' | 'unauthorized' | 'forbidden' | 'not_found' | 'validation' | 'conflict'
  | 'rate_limited' | 'server' | 'bad_response';

export function errorKind(status: number, code?: string): ApiErrorKind {
  if (code === 'aborted') return 'aborted';
  if (status === 0) return 'offline';
  if (code === 'bad_response') return 'bad_response';
  if (status === 401) return 'unauthorized';
  if (status === 402 || status === 403) return 'forbidden';
  if (status === 404 || status === 410) return 'not_found';
  if (status === 409 || status === 412) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status === 400 || status === 422) return 'validation';
  return 'server';
}

export class ApiRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown, readonly requestId?: string) {
    super(message);
    this.name = 'ApiRequestError';
  }
  get kind(): ApiErrorKind { return errorKind(this.status, this.code); }
}

/** Localised fallback copy for failures that carry no usable server message (network, HTML error pages). */
const COPY = {
  en: {
    offline: 'Cannot reach Resuto. Check your connection and retry.',
    server: 'Resuto is temporarily unavailable (HTTP {status}). Your data is safe; retry in a moment.',
    bad_response: 'Resuto sent an unexpected response (HTTP {status}). Retry in a moment.',
    aborted: 'The request was cancelled.',
  },
  ar: {
    offline: 'تعذّر الوصول إلى ريسوتو. تحقّق من الاتصال ثم أعد المحاولة.',
    server: 'ريسوتو غير متاح مؤقتًا (HTTP {status}). بياناتك آمنة؛ أعد المحاولة بعد قليل.',
    bad_response: 'وصل رد غير متوقع من ريسوتو (HTTP {status}). أعد المحاولة بعد قليل.',
    aborted: 'تم إلغاء الطلب.',
  },
} as const;
const docLocale = (): 'en' | 'ar' => (typeof document !== 'undefined' && document?.documentElement?.lang === 'ar' ? 'ar' : 'en');
const copy = (k: keyof (typeof COPY)['en'], status = 0) => COPY[docLocale()][k].replace('{status}', String(status));

/**
 * The message for an API error in the page language (REM-W05): Arabic pages get the localised text for the error
 * code (lib/api-errors, a chunk loaded only when an error needs it); English pages keep the API's sentence, which can
 * be more specific, and use the dictionary only when the API sent no sentence.
 */
async function errorText(code: string, details: unknown, message: string): Promise<string> {
  const locale = docLocale();
  if (locale === 'en' && message && /\s/.test(message.trim())) return message;
  try {
    return await (await import('./api-errors')).localizedErrorMessage(code, details, locale, message);
  } catch {
    return message;
  }
}

export interface ApiOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  token?: string | null;
  idempotencyKey?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /**
   * Conditional GET (REM-W02, PCL-24): send the ETag of this caller's last answer for the same URL as If-None-Match;
   * a 304 then resolves to that same answer object (no body, no JSON parse, unchanged identity so nothing that
   * depends on it recomputes). Signed-in reads only (useApi): their requests are preflighted anyway, so the extra
   * header costs no OPTIONS round trip. See conditionalKey for what an answer is remembered under.
   */
  revalidate?: boolean;
}

const isJson = (contentType: string | null) => !!contentType && /\bjson\b/i.test(contentType);

/**
 * Validators of the last 200 answers to revalidating GETs (memory only, never storage; bounded LRU). An entry holds
 * the ETag and the parsed answer, keyed by the bearer token, the URL and the request headers, so one user's answer
 * is never returned to another user or to another tenant/filter. The session drops them all on sign-out or a user
 * switch (forgetValidators). Answers that were assembled from several pages (X-Resuto-List: full) are not
 * remembered: the ETag covers the first page only.
 *
 * The browser HTTP cache is not involved: staff responses stay `no-store` (PCL-03/04), and a request that carries
 * If-None-Match bypasses the HTTP cache by definition (Fetch), so the 304 reaches this code instead of a stored copy.
 */
const MAX_VALIDATORS = 100;
const validators = new Map<string, { etag: string; data: unknown }>();

/** What a revalidating answer is remembered under (exported for tests). */
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

/**
 * HTTP cache policy (PCL-03, depends on the API's PCL-04 header). `cache: 'no-store'` keeps API responses out of the
 * browser's HTTP (disk) cache, but Chromium then also skips its CORS preflight cache, so every credentialed call and
 * every poll pays an extra OPTIONS round trip. The default mode, which keeps preflights cached
 * (Access-Control-Max-Age), is therefore used only once the API has shown that it declares its own policy: a
 * response carrying `Cache-Control: … no-store …` (the hardening middleware sends `private, no-store` on every
 * response that sets no policy of its own). As soon as one response arrives with no Cache-Control header at all, the
 * API is treated as not declaring a policy for the rest of this page load and every request uses 'no-store', so
 * tenant JSON and guest data never reach the disk cache, where they would outlive sign-out.
 */
type ServerCachePolicy = 'unknown' | 'declared' | 'absent';
let serverCachePolicy: ServerCachePolicy = 'unknown';

/** The fetch cache mode for the next API request (exported for tests and probes). */
export const apiCacheMode = (): RequestCache | undefined => (serverCachePolicy === 'declared' ? undefined : 'no-store');

/** Learns the API's cache policy from a response. 'absent' is sticky for the page load; it only fails safe. */
export function noteServerCachePolicy(cacheControl: string | null): void {
  if (!cacheControl) serverCachePolicy = 'absent';
  else if (serverCachePolicy === 'unknown' && /(^|[\s,])no-store([\s,;]|$)/i.test(cacheControl)) serverCachePolicy = 'declared';
}

/** Test hook: forget what was learned (a new page load). */
export const resetServerCachePolicy = () => { serverCachePolicy = 'unknown'; };

export async function api<T = any>(path: string, opts: ApiOptions = {}): Promise<T> {
  return (await apiPage(path, opts))[0];
}

/**
 * api() for staff screens (useSession().call). Lists the dashboard shows whole (PS-22) are bounded pages marked
 * `X-Resuto-List: full`; for those the remaining pages are fetched by lib/api-pages.ts, a separate chunk loaded only
 * when needed, so guest bundles stay as they were.
 */
export async function apiAll<T = any>(path: string, opts: ApiOptions = {}): Promise<T> {
  const [data, full] = await apiPage(path, opts);
  return full ? (await import('./api-pages')).followPages(data, path, opts, apiPage) : data;
}

export async function apiPage(path: string, opts: ApiOptions): Promise<[any, boolean]> {
  const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers };
  if (opts.body !== undefined && !(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  const method = opts.method ?? (opts.body !== undefined ? 'POST' : 'GET');
  const conditional = !!opts.revalidate && method === 'GET' && !!opts.token;
  const ckey = conditional ? conditionalKey(path, opts.token, opts.headers) : '';
  const known = conditional ? validators.get(ckey) : undefined;
  if (known) headers['If-None-Match'] = known.etag;
  let res: Response;
  try {
    res = await fetch(`${API_URL}/v1${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : opts.body instanceof FormData ? opts.body : JSON.stringify(opts.body),
      signal: opts.signal,
      cache: apiCacheMode(),
    });
  } catch (e) {
    if (opts.signal?.aborted || (e as Error)?.name === 'AbortError') throw new ApiRequestError(0, 'aborted', copy('aborted'));
    reportConnection(false);
    throw new ApiRequestError(0, 'network_error', copy('offline'));
  }
  // Topbar connection status: a gateway/server outage means "reconnecting"; any other answer means the API is reachable.
  reportConnection(!(res.status === 502 || res.status === 503 || res.status === 504));
  if (res.status === 304) {
    // Unchanged since the remembered answer: hand back that same object (no body to read or parse).
    if (known && res.headers.get('x-resuto-list') !== 'full') { remember(ckey, known.etag, known.data); return [known.data, false]; }
    // A 304 this caller cannot answer from memory (not expected): forget the validator and ask once more without it.
    validators.delete(ckey);
    return apiPage(path, { ...opts, revalidate: false });
  }
  noteServerCachePolicy(res.headers.get('cache-control'));
  const requestId = res.headers.get('x-request-id') ?? undefined;
  const text = await res.text().catch(() => '');
  let data: any = null;
  // Error bodies are only read as JSON when they say so: a proxy/CDN HTML error page must never surface as
  // "Unexpected token <". Successful bodies are parsed even without the header (the API always sends JSON).
  if (text && (isJson(res.headers.get('content-type')) || res.ok)) {
    try { data = JSON.parse(text); } catch { data = undefined; }
  } else if (text) data = undefined;
  if (!res.ok) {
    const e = data?.error;
    if (!e) throw new ApiRequestError(res.status, res.status >= 500 ? 'service_unavailable' : 'http_error', copy('server', res.status), undefined, requestId);
    const code: string = e.code ?? 'http_error';
    throw new ApiRequestError(res.status, code, await errorText(code, e.details, e.message ?? res.statusText), e.details, e.requestId ?? requestId);
  }
  if (data === undefined) throw new ApiRequestError(res.status, 'bad_response', copy('bad_response', res.status), undefined, requestId);
  const full = method === 'GET' && !/[?&](cursor|limit)=/.test(path) && res.headers.get('x-resuto-list') === 'full';
  if (conditional) {
    // The API must list ETag in Access-Control-Expose-Headers for a cross-origin page to read it; without it this
    // stays a plain GET.
    const etag = res.headers.get('etag');
    if (etag && !full) remember(ckey, etag, data);
    else validators.delete(ckey);
  }
  return [data, full];
}

/** Stable idempotency key for one user intent (reuse it when retrying that intent). */
export const newIdempotencyKey = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
