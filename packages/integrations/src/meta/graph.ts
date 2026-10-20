// Shared Meta Graph API pieces for every Meta capability in Resuto: WhatsApp Cloud API, Marketing API (ads, custom
// audiences), Messenger Platform / Instagram Messaging, Conversions API and Page / Instagram publishing.
//
// ONE version constant (audit INT-12). Sources, checked 2026-10-20:
//   - Graph API versions:   https://developers.facebook.com/docs/graph-api/changelog/versions
//       v26.0 released 2026-07-29 (expiry TBD); v25.0 until 2028-07-29; v24.0 until 2028-02-18; v23.0 until 2027-10-08.
//   - Marketing API:        https://developers.facebook.com/docs/marketing-api/marketing-api-changelog
//       v26.0 released 2026-07-29 (available until TBD); v25.0 until 2027-02-23; v24.0 until 2026-11-10; v23.0 is no
//       longer listed (the versions page gives 2026-06-09), so the previous pin had already expired for ads calls.
//   - The Embedded Signup, Conversions API and Messenger Send API pages all show v26.0 in their current examples.
// metaVersionWarnings() turns the table below into a failing unit test 60 days before a pinned version's known
// end-of-life, so a release cannot ship with an expiring pin (update the table when Meta publishes the v26.0 dates).
import { constantTimeEqual, hmacHex, ProviderError, type AdapterContext } from '../core';

export const META_GRAPH_VERSION = 'v26.0';
export const GRAPH_HOST = 'https://graph.facebook.com';
export const FACEBOOK_WWW = 'https://www.facebook.com';

export interface MetaVersionSupport {
  version: string;
  releasedOn: string;
  /** Last day the version is served, or null while Meta lists it as "TBD". */
  availableUntil: string | null;
  source: string;
}

export const META_VERSION_SUPPORT: { graph: MetaVersionSupport; marketing: MetaVersionSupport } = {
  graph: { version: META_GRAPH_VERSION, releasedOn: '2026-07-29', availableUntil: null, source: 'https://developers.facebook.com/docs/graph-api/changelog/versions' },
  marketing: { version: META_GRAPH_VERSION, releasedOn: '2026-07-29', availableUntil: null, source: 'https://developers.facebook.com/docs/marketing-api/marketing-api-changelog' },
};

/** Warnings when a pinned Meta version reaches its end-of-life within `windowDays` (empty when all is well). */
export function metaVersionWarnings(now = new Date(), windowDays = 60, table = META_VERSION_SUPPORT): string[] {
  const out: string[] = [];
  for (const [api, v] of Object.entries(table)) {
    if (!v.availableUntil) continue;
    const days = Math.floor((new Date(`${v.availableUntil}T00:00:00Z`).getTime() - now.getTime()) / 86_400_000);
    if (days <= windowDays) out.push(`Meta ${api} API ${v.version} ${days < 0 ? 'expired' : `expires in ${days} day(s)`} (${v.availableUntil}); move to the current version (${v.source}).`);
  }
  return out;
}

/** `appsecret_proof` = hex HMAC-SHA256 of the access token keyed with the app secret (https://developers.facebook.com/docs/graph-api/securing-requests). */
export const appSecretProof = (accessToken: string, appSecret: string) => hmacHex('sha256', appSecret, accessToken);

/**
 * Verifies `X-Hub-Signature-256: sha256=<hex>` (HMAC-SHA256 of the exact raw body with the app secret). The same
 * scheme signs WhatsApp, Messenger, Instagram and Page webhooks
 * (https://developers.facebook.com/docs/graph-api/webhooks/getting-started). Must run before JSON parsing.
 */
export function verifyMetaSignature(rawBody: Buffer | string | undefined | null, header: string | string[] | undefined | null, appSecret: string | undefined | null): boolean {
  if (!rawBody || !appSecret) return false;
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || !value.startsWith('sha256=')) return false;
  const expected = `sha256=${hmacHex('sha256', appSecret, rawBody)}`;
  return constantTimeEqual(expected, value.trim().toLowerCase());
}

/** Meta's GET verification handshake: returns hub.challenge when hub.verify_token matches, else null. */
export function verifyMetaSubscription(query: Record<string, unknown>, verifyToken: string | undefined | null): string | null {
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];
  if (!verifyToken || mode !== 'subscribe' || typeof token !== 'string' || typeof challenge !== 'string') return null;
  return constantTimeEqual(token, verifyToken) ? challenge : null;
}

/** A Graph API error with Meta's error code/subcode (https://developers.facebook.com/docs/graph-api/guides/error-handling). */
export class MetaApiError extends ProviderError {
  constructor(provider: string, message: string, retryable: boolean, status: number | undefined, readonly code: number | null,
    readonly subcode: number | null, readonly fbtraceId: string | null, retryAfterMs?: number) {
    super(provider, message, retryable, status, retryAfterMs);
  }
  /** OAuthException 190: the token is invalid, expired or revoked. */
  get tokenInvalid() { return this.code === 190 || this.code === 102; }
  /** Permission / not-found family: the token cannot see this object (wrong owner, not shared, deleted). */
  get noAccess() { return this.code === 100 || this.code === 10 || this.code === 200 || (this.code !== null && this.code >= 200 && this.code < 300) || this.code === 803; }
}

/**
 * Throttling codes — retryable after a pause. Graph/Marketing API: https://developers.facebook.com/docs/graph-api/overview/rate-limiting;
 * WhatsApp (returned with HTTP 400): 130429 throughput reached, 131056 pair rate limit ("wait and retry")
 * per https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes. 131048 (spam
 * restriction on the number) is NOT here: retrying does not help.
 */
const RATE_LIMIT_CODES = new Set([4, 17, 32, 341, 613, 80000, 80001, 80002, 80003, 80004, 80005, 80006, 80008, 80009, 80014, 130429, 131056]);
/** Temporary server-side errors (code 1 unknown, 2 service unavailable). */
const TRANSIENT_CODES = new Set([1, 2]);

export interface GraphRequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  /** Access token, sent as `Authorization: Bearer` (or as the access_token parameter with tokenInQuery). */
  token?: string | null;
  tokenInQuery?: boolean;
  /** When set, appsecret_proof is added (only for tokens issued to the app whose secret this is). */
  appSecret?: string | null;
  query?: Record<string, string | number | boolean | undefined | null>;
  json?: unknown;
  form?: Record<string, string>;
  retries?: number;
  timeoutMs?: number;
  version?: string;
}

/**
 * Meta echoes the offending token in some error messages ("Malformed access token EAAG…"). Error text is logged, stored
 * (connection logs, CAPI diagnostics) and shown to staff, so the request's token and anything token-shaped are removed.
 */
export function scrubMetaMessage(message: string, token?: string | null): string {
  let m = token && token.length >= 6 ? message.split(token).join('[token]') : message;
  m = m.replace(/\bEA[A-Za-z0-9]{2}[A-Za-z0-9_-]{8,}/g, '[token]').replace(/\b[0-9]{6,}\|[A-Za-z0-9_-]{16,}/g, '[token]');
  return m;
}

/** `path` relative to the pinned version ("123/messages"), or an absolute Graph URL (paging.next links). */
export function graphUrl(path: string, opts: Pick<GraphRequestOptions, 'query' | 'version'> = {}): URL {
  const u = /^https:\/\//.test(path) ? new URL(path) : new URL(`${GRAPH_HOST}/${opts.version ?? META_GRAPH_VERSION}/${path.replace(/^\//, '')}`);
  if (u.origin !== GRAPH_HOST) throw new ProviderError('meta', 'refusing a non-Graph URL', false);
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  return u;
}

const backoff = (attempt: number, override?: number) => new Promise((r) => setTimeout(r, Math.min(override ?? 250 * 2 ** attempt, 5_000)));

/**
 * One Graph API call with timeout, bounded retries (5xx, throttling) and Meta error parsing. Error messages carry
 * Meta's code and message (never the token or the request body).
 */
export async function graphRequest<T>(provider: string, ctx: Pick<AdapterContext, 'fetch'>, path: string, opts: GraphRequestOptions = {}): Promise<T> {
  const u = graphUrl(path, opts);
  if (opts.token && opts.tokenInQuery) u.searchParams.set('access_token', opts.token);
  if (opts.token && opts.appSecret) u.searchParams.set('appsecret_proof', appSecretProof(opts.token, opts.appSecret));
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.token && !opts.tokenInQuery) headers.Authorization = `Bearer ${opts.token}`;
  let body: string | undefined;
  if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.json); }
  else if (opts.form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(opts.form).toString(); }
  const retries = opts.retries ?? 0;
  let last: ProviderError | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res: Response;
    try {
      res = await ctx.fetch(u.toString(), { method: opts.method ?? (body ? 'POST' : 'GET'), headers, body, signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000) });
    } catch (error) {
      last = new ProviderError(provider, `network error: ${(error as Error).message}`, true);
      if (attempt < retries) await backoff(attempt);
      continue;
    }
    const text = await res.text();
    let parsed: any = null;
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = null; }
    if (res.ok && parsed && !parsed.error) return parsed as T;
    const err = parsed?.error ?? {};
    const code = typeof err.code === 'number' ? err.code : null;
    const subcode = typeof err.error_subcode === 'number' ? err.error_subcode : null;
    const rateLimited = res.status === 429 || (code !== null && RATE_LIMIT_CODES.has(code));
    const retryable = rateLimited || res.status >= 500 || (code !== null && TRANSIENT_CODES.has(code));
    const retryAfter = Number(res.headers.get('retry-after')) * 1000 || undefined;
    const status = code === 190 ? 401 : rateLimited ? 429 : res.status;
    const msg = parsed ? `HTTP ${res.status}${code !== null ? ` code ${code}${subcode ? `/${subcode}` : ''}` : ''}: ${scrubMetaMessage(String(err.message ?? 'error'), opts.token).slice(0, 200)}` : `HTTP ${res.status}: unexpected response`;
    last = new MetaApiError(provider, msg, retryable, status, code, subcode, typeof err.fbtrace_id === 'string' ? err.fbtrace_id : null, retryAfter);
    if (!retryable || attempt === retries) break;
    await backoff(attempt, retryAfter);
  }
  throw last!;
}

/** Follows `paging.next` for list edges, at most `maxPages` pages. */
export async function graphList<T>(provider: string, ctx: Pick<AdapterContext, 'fetch'>, path: string, opts: GraphRequestOptions & { maxPages?: number } = {}): Promise<T[]> {
  const out: T[] = [];
  let next: string | null = path;
  for (let page = 0; next && page < (opts.maxPages ?? 10); page++) {
    const res: { data?: T[]; paging?: { next?: string } } = await graphRequest(provider, ctx, next, page === 0 ? opts : { ...opts, query: undefined });
    out.push(...(res.data ?? []));
    next = res.paging?.next ?? null;
  }
  return out;
}

/**
 * The Meta credentials an adapter call uses: the token plus, when the token was issued to an app whose secret Resuto
 * knows (the platform app, or a merchant's own app with its secret on the connection), that secret for
 * appsecret_proof. Tokens pasted from an unknown app carry no secret and are sent without a proof.
 */
export function metaAuth(provider: string, ctx: AdapterContext, tokenKey = 'accessToken'): { token: string; appSecret: string | null } {
  const token = ctx.credentials[tokenKey];
  if (!token) throw new ProviderError(provider, `missing credential ${tokenKey}`, false);
  return { token, appSecret: ctx.credentials.appSecret || null };
}
