import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/** The outbox handler execution a piece of work belongs to (see onceForEvent in common/events/effects.ts). */
export interface HandlingContext {
  eventId: string;
  handler: string;
  orgId: string | null;
}

/**
 * Correlation context for one unit of work: an HTTP request, an outbox handler run or a scheduled job run. Carried with
 * AsyncLocalStorage so that DB transactions (app.request_id → audit_logs/outbox_events.request_id), logs and outbound
 * HTTP calls (X-Request-Id) all name the same id without threading it through every signature (audit PS-15).
 */
export interface RequestContextStore {
  requestId: string;
  source: 'api' | 'worker' | 'job';
  handling?: HandlingContext;
}

const storage = new AsyncLocalStorage<RequestContextStore>();

/** Accepted caller correlation ids: echoed in headers and logs, so only a safe shape. */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,64}$/;

export const requestContext = {
  run<T>(store: RequestContextStore, fn: () => T): T {
    return storage.run(store, fn);
  },
  get(): RequestContextStore | undefined {
    return storage.getStore();
  },
  requestId(): string | undefined {
    return storage.getStore()?.requestId;
  },
};

/** The caller's X-Request-Id when it has a safe shape, otherwise a fresh UUID. */
export function acceptRequestId(given: unknown): string {
  return typeof given === 'string' && REQUEST_ID_PATTERN.test(given) ? given : randomUUID();
}

/** A correlation id for background work, trimmed to the 64 characters the columns accept. */
export const workerRequestId = (prefix: 'evt' | 'job', id: string) => `${prefix}:${id}`.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 64);

let outboundInstalled = false;

/**
 * Adds X-Request-Id to every outbound fetch made while a request context is active (provider adapters, the AI service,
 * Supabase Storage), unless the caller set one. Installed once per process by the API and worker entrypoints.
 */
export function installOutboundRequestId(options: { force?: boolean } = {}): void {
  if ((outboundInstalled && !options.force) || typeof globalThis.fetch !== 'function') return;
  outboundInstalled = true;
  const original = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const id = storage.getStore()?.requestId;
    if (!id) return original(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!headers.has('x-request-id')) headers.set('X-Request-Id', id);
    return original(input, { ...init, headers });
  }) as typeof fetch;
}
