// Typed fetch wrapper for the Resuto API. All business data goes through the
// NestJS API; the browser never talks to the database directly.
export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');

export class ApiRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
  }
}

export interface ApiOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  token?: string | null;
  idempotencyKey?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export async function api<T = any>(path: string, opts: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers };
  if (opts.body !== undefined && !(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  let res: Response;
  try {
    res = await fetch(`${API_URL}/v1${path}`, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers,
      body: opts.body === undefined ? undefined : opts.body instanceof FormData ? opts.body : JSON.stringify(opts.body),
      signal: opts.signal,
      cache: 'no-store',
    });
  } catch {
    throw new ApiRequestError(0, 'network_error', 'Cannot reach Resuto. Check your connection and retry.');
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = data?.error ?? {};
    throw new ApiRequestError(res.status, e.code ?? 'http_error', e.message ?? res.statusText, e.details);
  }
  return data as T;
}

/** Stable idempotency key for one user intent (reuse it when retrying that intent). */
export const newIdempotencyKey = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
