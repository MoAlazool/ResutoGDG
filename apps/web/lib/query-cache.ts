// Client query cache for authenticated API reads (used by useApi). Framework-free so it is unit-tested directly.
//
// Policy ("browser query state"; the server side of the cache policy lives with the API):
// - Keys are `<scope>|<path>`; scope is the signed-in user (the token subject), and the path already carries the
//   tenant (`/o/<orgId>/...`), branch, filters, pagination and locale parameters. Nothing is shared across users;
//   sign-out and user changes clear everything.
// - Memory only (never localStorage), bounded (LRU, MAX_ENTRIES).
// - Stale-while-revalidate: a remount shows the last same-key result and refetches when it is older than the
//   resource class's stale time (staleTimeFor): live operations 0 (always revalidate, polled), reference data and
//   analytics 60 s, the signed-in user / restaurant / plan 5 min (plus a refetch when the tab regains focus).
// - Polls back off exponentially while they fail (nextPollDelay) and resume their normal rate after a success.
// - Concurrent reads of one key share one request; a read whose key is invalidated while in flight cannot write
//   its (older) result back (generation check).
// - After a successful mutation the tenant's queries are invalidated: mounted ones refetch, others are marked stale.
//   The server stays authoritative for prices, stock, permissions and payment state; the cache only avoids
//   blank screens and duplicate requests.

export interface Entry<T = unknown> {
  data?: T;
  error?: unknown;
  updatedAt: number;
  stale: boolean;
  gen: number;
  /** Consecutive failed reads (0 after a success); drives poll backoff. */
  failures?: number;
  inflight?: { promise: Promise<T>; gen: number; controller: AbortController };
}

type Listener = () => void;

export class QueryCache {
  private entries = new Map<string, Entry>();
  private listeners = new Map<string, Set<Listener>>();
  private fetchers = new Map<string, (signal: AbortSignal) => Promise<unknown>>();

  constructor(private readonly maxEntries = 200, private readonly now: () => number = Date.now) {}

  get<T>(key: string): Entry<T> | undefined {
    const e = this.entries.get(key) as Entry<T> | undefined;
    if (e) { this.entries.delete(key); this.entries.set(key, e); } // LRU touch
    return e;
  }

  subscribe(key: string, listener: Listener, fetcher: (signal: AbortSignal) => Promise<unknown>): () => void {
    let set = this.listeners.get(key);
    if (!set) this.listeners.set(key, (set = new Set()));
    set.add(listener);
    this.fetchers.set(key, fetcher);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) {
        this.listeners.delete(key);
        this.fetchers.delete(key);
        // Nobody is waiting for this result any more: cancel the request.
        const e = this.entries.get(key);
        if (e?.inflight) { e.inflight.controller.abort(); e.inflight = undefined; }
      }
    };
  }

  private emit(key: string) {
    for (const l of this.listeners.get(key) ?? []) l();
  }

  private ensure(key: string): Entry {
    let e = this.entries.get(key);
    if (!e) {
      e = { updatedAt: 0, stale: true, gen: 0 };
      this.entries.set(key, e);
      while (this.entries.size > this.maxEntries) {
        // Evict the least recently used entry nobody is subscribed to.
        const victim = [...this.entries.keys()].find((k) => !this.listeners.has(k));
        if (!victim) break;
        this.entries.delete(victim);
      }
    }
    return e;
  }

  /** Fetches `key` (sharing an in-flight request) and stores the result unless the key was invalidated meanwhile. */
  fetch<T>(key: string, fetcher: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const e = this.ensure(key) as Entry<T>;
    if (e.inflight && e.inflight.gen === e.gen) return e.inflight.promise;
    const controller = new AbortController();
    const gen = e.gen;
    const promise = fetcher(controller.signal).then(
      (data) => {
        const cur = this.entries.get(key) as Entry<T> | undefined;
        if (cur && cur.gen === gen && !controller.signal.aborted) {
          cur.data = data; cur.error = undefined; cur.updatedAt = this.now(); cur.stale = false; cur.failures = 0;
        }
        if (cur?.inflight?.promise === promise) cur.inflight = undefined;
        this.emit(key);
        return data;
      },
      (err) => {
        const cur = this.entries.get(key) as Entry<T> | undefined;
        if (cur && cur.gen === gen && !controller.signal.aborted) { cur.error = err; cur.failures = (cur.failures ?? 0) + 1; }
        if (cur?.inflight?.promise === promise) cur.inflight = undefined;
        this.emit(key);
        throw err;
      },
    );
    e.inflight = { promise, gen, controller };
    this.emit(key);
    return promise;
  }

  /** Forces a fresh read of `key`, discarding any in-flight one. */
  refetch<T>(key: string, fetcher: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const e = this.ensure(key) as Entry<T>;
    e.gen++;
    if (e.inflight) { e.inflight.controller.abort(); e.inflight = undefined; }
    return this.fetch(key, fetcher);
  }

  /** Replaces the cached value with an authoritative result (e.g. the response of a mutation). */
  set<T>(key: string, data: T) {
    const e = this.ensure(key) as Entry<T>;
    e.gen++; // an older in-flight read must not overwrite this
    if (e.inflight) { e.inflight.controller.abort(); e.inflight = undefined; }
    e.data = data; e.error = undefined; e.updatedAt = this.now(); e.stale = false;
    this.emit(key);
  }

  /** Marks matching keys stale; mounted ones refetch now. Returns the number of keys invalidated. */
  invalidate(match: (path: string, key: string) => boolean): number {
    let n = 0;
    for (const [key, e] of this.entries) {
      const path = key.slice(key.indexOf('|') + 1);
      if (!match(path, key)) continue;
      n++;
      e.stale = true;
      e.gen++;
      if (e.inflight) { e.inflight.controller.abort(); e.inflight = undefined; }
      const fetcher = this.fetchers.get(key);
      if (fetcher) this.fetch(key, fetcher).catch(() => undefined);
    }
    return n;
  }

  /** Drops everything (sign-out, user switch). In-flight reads are cancelled and cannot repopulate. */
  clear() {
    for (const e of this.entries.values()) e.inflight?.controller.abort();
    this.entries.clear();
    for (const key of this.listeners.keys()) this.emit(key);
  }

  get size() { return this.entries.size; }
}

/** Tenant prefix of an API path (`/o/<orgId>/`), or null for non-tenant paths. */
export const tenantPrefix = (path: string) => /^\/o\/[^/?]+\//.exec(path)?.[0] ?? null;

/** Path without its query string: the "resource" a filter/page change stays within. */
export const resourceOf = (path: string) => path.split('?')[0];

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
/** Reference data: edited rarely, read often (menu editor, team, settings, integrations, branches, plan). */
const REFERENCE = /^\/o\/[^/]+\/(menu|team|members|settings|integrations|branches|billing\/(plans|subscription|invoices)|tax-profile|compliance\/profile|studio\/(site|templates|media)|mcp\/clients|roles|invites)(\/|$)/;
/** Analytics and reports: aggregates that change slowly and are expensive to compute. */
const ANALYTICS = /^\/o\/[^/]+\/(analytics|reports|insights|intelligence|finance\/(pnl|summary|overview))(\/|$)/;
/** The signed-in user, the restaurant and its plan: needed by every screen, change very rarely. */
const IDENTITY = /^(\/me|\/o\/[^/]+|\/o\/[^/]+\/billing\/entitlements)$/;

/**
 * How long a cached result counts as fresh for a path (the CACHE POLICY's resource classes). Live operations
 * (orders, KDS, floor, inbox, payments, deliveries) are always revalidated and use polling; the server stays
 * authoritative for prices, stock, permissions and payment state in every class.
 */
export function staleTimeFor(path: string): number {
  const p = resourceOf(path);
  if (IDENTITY.test(p)) return 5 * MINUTE;
  if (ANALYTICS.test(p)) return MINUTE;
  if (REFERENCE.test(p)) return MINUTE;
  return 0;
}

/** Delay before the next poll: the normal interval, doubled per consecutive failure, capped at 5 min. */
export function nextPollDelay(pollMs: number, failures: number): number {
  if (!failures) return pollMs;
  return Math.min(pollMs * 2 ** Math.min(failures, 5), Math.max(pollMs, 5 * MINUTE));
}

/**
 * Stable cache scope for a bearer token: its subject (`sub`), read without verification (the server verifies;
 * this only partitions the browser cache per user). Falls back to the token's tail when it is not a JWT.
 */
export function scopeOfToken(token: string | null | undefined): string | null {
  if (!token) return null;
  try {
    const part = token.split('.')[1];
    if (part) {
      const json = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=')));
      if (typeof json?.sub === 'string' && json.sub) return `u:${json.sub}`;
    }
  } catch { /* not a JWT */ }
  return `t:${token.slice(-24)}`;
}

export const queryCache = new QueryCache();
