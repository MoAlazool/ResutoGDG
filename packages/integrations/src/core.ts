// Shared provider-adapter infrastructure. Every external integration in Resuto
// implements one of the category interfaces below and reports an honest
// readiness level; sandbox implementations are labelled, never presented as live.
import { createHmac, timingSafeEqual } from 'node:crypto';

export type ProviderCategory = 'pos' | 'payments' | 'accounting' | 'messaging' | 'ads' | 'delivery' | 'tax' | 'billing' | 'ai';

/**
 * implemented_unverified: real API client written against provider docs, not yet
 *   exercised with real credentials.
 * sandbox_verified: exercised against the provider's sandbox with real credentials.
 * live_verified: exercised in production.
 * simulated: local simulation only (no provider involved).
 */
export type Readiness = 'simulated' | 'implemented_unverified' | 'sandbox_verified' | 'live_verified';

export interface ProviderDescriptor {
  id: string;
  name: string;
  category: ProviderCategory;
  countries: Array<'EG' | 'SA'>;
  authType: 'oauth' | 'api_key' | 'webhook_secret' | 'none';
  readiness: Readiness;
  /** Exact steps/credentials required before live activation. */
  activation: string[];
  docsUrl?: string;
  capabilities: string[];
}

export interface AdapterContext {
  environment: 'sandbox' | 'live';
  credentials: Record<string, string>;
  config: Record<string, unknown>;
  fetch: typeof fetch;
}

export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(`${provider}: ${message}`);
  }
}

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | URLSearchParams;
  timeoutMs?: number;
  retries?: number;
  idempotencyKey?: string;
}

/** JSON HTTP call with timeout, bounded retries on 429/5xx and Retry-After support. */
export async function providerRequest<T>(provider: string, ctx: Pick<AdapterContext, 'fetch'>, url: string, opts: HttpOptions = {}): Promise<T> {
  const retries = opts.retries ?? 2;
  let lastError: ProviderError | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res: Response;
    try {
      res = await ctx.fetch(url, {
        method: opts.method ?? 'GET',
        headers: { Accept: 'application/json', ...(opts.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : {}), ...opts.headers },
        body: opts.body,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      });
    } catch (error) {
      lastError = new ProviderError(provider, `network error: ${(error as Error).message}`, true);
      await backoff(attempt);
      continue;
    }
    const text = await res.text();
    if (res.ok) return (text ? JSON.parse(text) : {}) as T;
    const retryAfter = Number(res.headers.get('retry-after')) * 1000 || undefined;
    const retryable = res.status === 429 || res.status >= 500;
    lastError = new ProviderError(provider, `HTTP ${res.status}: ${text.slice(0, 300)}`, retryable, res.status, retryAfter);
    if (!retryable || attempt === retries) break;
    await backoff(attempt, retryAfter);
  }
  throw lastError!;
}

const backoff = (attempt: number, override?: number) =>
  new Promise((r) => setTimeout(r, Math.min(override ?? 250 * 2 ** attempt, 5_000)));

export function hmacHex(algorithm: 'sha256' | 'sha512', secret: string, payload: string | Buffer): string {
  return createHmac(algorithm, secret).update(payload).digest('hex');
}

export function constantTimeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The provider account a credential set belongs to, as reported by the provider (shown so the owner can confirm it is theirs). */
export interface AccountIdentity {
  id?: string | null;
  name?: string | null;
  country?: string | null;
  currency?: string | null;
}

/**
 * Result of an adapter health check: a cheap authenticated call proving the
 * credentials work. `environment` is the mode the provider evidence shows
 * (key prefix or account response); a mismatch with the connection fails the check.
 */
export interface HealthCheckResult {
  ok: boolean;
  details?: Record<string, unknown>;
  account?: AccountIdentity | null;
  environment?: 'sandbox' | 'live' | null;
}

/** Result of verifying and parsing an inbound webhook. */
export interface VerifiedWebhook<T = unknown> {
  valid: boolean;
  /** Provider-unique event key for deduplication in webhook_inbox. */
  eventKey: string;
  event: T | null;
  reason?: string;
}
