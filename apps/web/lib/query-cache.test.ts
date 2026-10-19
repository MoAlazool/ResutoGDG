import { describe, expect, it, vi } from 'vitest';
import { QueryCache, resourceOf, tenantPrefix } from './query-cache';

const deferred = <T,>() => {
  let resolve!: (v: T) => void; let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

describe('QueryCache', () => {
  it('shares one in-flight request between readers of the same key', async () => {
    const c = new QueryCache();
    const fetcher = vi.fn(async () => 'v1');
    const [a, b] = await Promise.all([c.fetch('u1|/o/a/orders', fetcher), c.fetch('u1|/o/a/orders', fetcher)]);
    expect([a, b]).toEqual(['v1', 'v1']);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(c.get('u1|/o/a/orders')?.data).toBe('v1');
  });

  it('keeps users apart: keys are scoped and clear() drops everything, including in-flight reads', async () => {
    const c = new QueryCache();
    await c.fetch('u1|/o/a/finance', async () => 'tenant A revenue');
    expect(c.get('u2|/o/a/finance')).toBeUndefined();
    const slow = deferred<string>();
    const p = c.fetch('u1|/o/a/orders', () => slow.promise);
    c.clear();
    slow.resolve('late');
    await p;
    expect(c.get('u1|/o/a/finance')).toBeUndefined();
    expect(c.get('u1|/o/a/orders')).toBeUndefined();
  });

  it('an older response cannot overwrite data after the key was invalidated', async () => {
    const c = new QueryCache();
    const first = deferred<string>();
    const listener = vi.fn();
    let n = 0;
    const fetcher = vi.fn(() => (++n === 1 ? first.promise : Promise.resolve('fresh')));
    c.subscribe('u1|/o/a/stock', listener, fetcher);
    const old = c.fetch('u1|/o/a/stock', fetcher);
    c.invalidate((p) => p.startsWith('/o/a/')); // a mutation happened; mounted query refetches
    await vi.waitFor(() => expect(c.get('u1|/o/a/stock')?.data).toBe('fresh'));
    first.resolve('stale');
    await old;
    expect(c.get('u1|/o/a/stock')?.data).toBe('fresh');
  });

  it('set() writes an authoritative result that an in-flight read cannot replace', async () => {
    const c = new QueryCache();
    const slow = deferred<string>();
    const p = c.fetch('u1|/o/a/order/1', () => slow.promise);
    c.set('u1|/o/a/order/1', 'from mutation');
    slow.resolve('older read');
    await p;
    expect(c.get('u1|/o/a/order/1')?.data).toBe('from mutation');
  });

  it('invalidate() refetches mounted keys of the tenant only and marks the rest stale', async () => {
    const c = new QueryCache();
    const mounted = vi.fn(async () => 'm');
    await c.fetch('u1|/o/a/orders', mounted);
    await c.fetch('u1|/o/a/inventory', async () => 'i');
    await c.fetch('u1|/o/b/orders', async () => 'b');
    c.subscribe('u1|/o/a/orders', () => undefined, mounted);
    expect(c.invalidate((p) => p.startsWith('/o/a/'))).toBe(2);
    await vi.waitFor(() => expect(mounted).toHaveBeenCalledTimes(2));
    expect(c.get('u1|/o/a/inventory')?.stale).toBe(true);
    expect(c.get('u1|/o/b/orders')?.stale).toBe(false);
  });

  it('keeps the previous data and records the error when a refresh fails', async () => {
    const c = new QueryCache();
    await c.fetch('u1|/o/a/kds', async () => 'tickets');
    await expect(c.refetch('u1|/o/a/kds', async () => { throw new Error('offline'); })).rejects.toThrow('offline');
    const e = c.get('u1|/o/a/kds');
    expect(e?.data).toBe('tickets');
    expect((e?.error as Error).message).toBe('offline');
  });

  it('cancels the request when the last subscriber leaves', async () => {
    const c = new QueryCache();
    let signal: AbortSignal | undefined;
    const fetcher = (s: AbortSignal) => { signal = s; return new Promise<string>(() => undefined); };
    const off = c.subscribe('u1|/o/a/report', () => undefined, fetcher);
    void c.fetch('u1|/o/a/report', fetcher);
    off();
    expect(signal?.aborted).toBe(true);
  });

  it('is bounded and evicts the least recently used unsubscribed entry', async () => {
    const c = new QueryCache(3);
    for (const k of ['a', 'b', 'c']) await c.fetch(`u|/${k}`, async () => k);
    c.get('u|/a'); // touch
    await c.fetch('u|/d', async () => 'd');
    expect(c.size).toBe(3);
    expect(c.get('u|/b')).toBeUndefined();
    expect(c.get('u|/a')?.data).toBe('a');
  });
});

describe('path helpers', () => {
  it('extracts the tenant prefix and the resource', () => {
    expect(tenantPrefix('/o/123/orders?status=open')).toBe('/o/123/');
    expect(tenantPrefix('/admin/operations')).toBeNull();
    expect(resourceOf('/o/1/orders?cursor=abc')).toBe('/o/1/orders');
  });
});
