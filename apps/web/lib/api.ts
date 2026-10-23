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
const docLocale = (): 'en' | 'ar' => (typeof document !== 'undefined' && document.documentElement.lang === 'ar' ? 'ar' : 'en');
const copy = (k: keyof (typeof COPY)['en'], status = 0) => COPY[docLocale()][k].replace('{status}', String(status));

/**
 * The message for an API error in the page language (REM-W05): Arabic pages get the localised text for the error
 * code (lib/api-errors, a chunk loaded only when an error needs it); English pages keep the API's sentence (one with
 * a space), which can be more specific. Never throws: any failure keeps the API's text.
 */
async function errorText(code: string, details: unknown, message: string): Promise<string> {
  try {
    const locale = docLocale();
    return locale === 'en' && / /.test(message) ? message : await (await import('./api-errors')).localizedErrorMessage(code, details, locale, message);
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
   * Called with the raw response before its body is read (status and headers only). lib/api-conditional.ts uses it
   * to learn ETags for conditional GETs (REM-W02) without adding that machinery to every page.
   */
  onResponse?: (res: Response) => void;
}

const isJson = (contentType: string | null) => !!contentType && /\bjson\b/i.test(contentType);

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
  opts.onResponse?.(res);
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
  return [data, full];
}

/** Stable idempotency key for one user intent (reuse it when retrying that intent). */
export const newIdempotencyKey = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
