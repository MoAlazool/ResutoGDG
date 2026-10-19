// Client query cache for authenticated API reads (used by useApi). Framework-free so it is unit-tested directly.
//
// Policy (docs/CACHE_POLICY.md, "Browser query state"):
// - Keys are `<scope>|<path>`; scope is the signed-in user id, and the path already carries the tenant
//   (`/o/<orgId>/...`), branch, filters, pagination and locale parameters. Nothing is shared across users;
//   sign-out and user changes clear everything.
// - Memory only (never localStorage), bounded (LRU, MAX_ENTRIES).
// - Stale-while-revalidate: a remount shows the last same-key result while it refetches.
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
          cur.data = data; cur.error = undefined; cur.updatedAt = this.now(); cur.stale = false;
        }
        if (cur?.inflight?.promise === promise) cur.inflight = undefined;
        this.emit(key);
        return data;
      },
      (err) => {
        const cur = this.entries.get(key) as Entry<T> | undefined;
        if (cur && cur.gen === gen && !controller.signal.aborted) cur.error = err;
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

export const queryCache = new QueryCache();
