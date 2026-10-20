/**
 * In-process cache with a hard size cap (least recently used entry evicted first) and a per-entry expiry (PCL-25).
 * Every in-memory cache of the API uses it, so no cache grows with the number of tenants, users or media objects.
 * It is per instance: callers that need cross-instance coherence keep their TTL short (docs/CACHE_POLICY.md).
 */
export class BoundedCache<V> {
  private readonly map = new Map<string, { value: V; expires: number }>();

  constructor(private readonly maxEntries: number, private readonly ttlMs: number, private readonly now: () => number = Date.now) {
    if (maxEntries < 1) throw new Error('BoundedCache needs maxEntries >= 1');
  }

  get size() { return this.map.size; }

  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expires <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    // Re-insert so the Map's insertion order tracks recency.
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  /** `ttlMs` overrides the default expiry for this entry (e.g. until a signed URL expires). */
  set(key: string, value: V, ttlMs = this.ttlMs) {
    this.map.delete(key);
    this.map.set(key, { value, expires: this.now() + ttlMs });
    while (this.map.size > this.maxEntries) this.map.delete(this.map.keys().next().value as string);
  }

  delete(key: string) { this.map.delete(key); }

  /** Keys of the entries that have not expired (expired ones are dropped on the way). */
  keys(): string[] {
    const now = this.now();
    const out: string[] = [];
    for (const [k, e] of [...this.map]) if (e.expires > now) out.push(k); else this.map.delete(k);
    return out;
  }

  deleteWhere(test: (key: string) => boolean) {
    for (const k of [...this.map.keys()]) if (test(k)) this.map.delete(k);
  }

  clear() { this.map.clear(); }
}
