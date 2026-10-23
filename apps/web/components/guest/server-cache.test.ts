// Review of REM-A11: the forwarded guest address must not become part of a shared read's cache key. Next's fetch data
// cache hashes the request headers into its key (incremental-cache generateCacheKey), so forwarding on a fetch with
// `next.revalidate` made the menu / floor / venue / table reads one cache entry per guest address and window.
// Revalidated reads now go through unstable_cache keyed by path and tags; the forwarded address only rides on the
// API call itself (always no-store). next/cache and next/headers are replaced by small in-memory stand-ins that
// record what the real ones would key on.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  headers: new Map<string, string>(),
  cache: new Map<string, unknown>(),
  keys: [] as string[],
  options: [] as unknown[],
}));

vi.mock('next/headers', () => ({ headers: async () => ({ get: (n: string) => state.headers.get(n) ?? null }) }));
vi.mock('next/cache', () => ({
  // Same key material as Next 15's unstable_cache: the callback source, the key parts and the call arguments
  // (closures are not part of the key). Only a returned value is stored; a thrown error is not.
  unstable_cache: (cb: (...a: unknown[]) => Promise<unknown>, keyParts: string[], options: unknown) => async (...args: unknown[]) => {
    const key = `${cb.toString()}-${keyParts.join(',')}-${JSON.stringify(args)}`;
    state.keys.push(key);
    state.options.push(options);
    if (state.cache.has(key)) return state.cache.get(key);
    const value = await cb(...args);
    state.cache.set(key, value);
    return value;
  },
}));

const calls: { url: string; init: RequestInit & { next?: unknown } }[] = [];
let respond: (url: string) => Response = () => Response.json({ ok: true });
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return respond(url); }) as typeof fetch;
afterAll(() => { globalThis.fetch = realFetch; });

const SECRET = 'test-forward-secret-0123456789abcdef0123456789';
process.env.CLIENT_IP_FORWARD_SECRET = SECRET;
process.env.WEB_TRUST_PROXY = 'x-real-ip';
const { serverRead } = await import('./server');

const as = (ip: string) => state.headers.set('x-real-ip', ip);
const sent = (i: number) => (calls[i]!.init.headers as Record<string, string>)['X-Resuto-Client-IP'];

beforeEach(() => {
  state.headers.clear(); state.cache.clear(); state.keys.length = 0; state.options.length = 0; calls.length = 0;
  respond = () => Response.json({ name: 'The Olive Room' });
});

describe('guest server reads and the shared cache', () => {
  it('two guests with different addresses share one cache entry for a revalidated read', async () => {
    as('203.0.113.7');
    const a = await serverRead('/public/menu/the-olive-room', { revalidate: 30, tags: ['menu:the-olive-room'] });
    as('198.51.100.20');
    const b = await serverRead('/public/menu/the-olive-room', { revalidate: 30, tags: ['menu:the-olive-room'] });
    expect(a).toEqual({ status: 'ok', data: { name: 'The Olive Room' } });
    expect(b).toEqual(a);
    expect(state.keys).toHaveLength(2);
    expect(state.keys[0]).toBe(state.keys[1]);                    // same key for both guests
    expect(state.keys[0]).not.toContain('203.0.113.7');
    expect(state.options[0]).toEqual({ revalidate: 30, tags: ['menu:the-olive-room'] });
    // One API call (the first guest's miss), carrying that guest's address, outside Next's header-keyed fetch cache.
    expect(calls).toHaveLength(1);
    expect(sent(0)).toBe('203.0.113.7');
    expect(calls[0]!.init.cache).toBe('no-store');
    expect(calls[0]!.init.next).toBeUndefined();
  });

  it('different paths are different entries', async () => {
    as('203.0.113.7');
    await serverRead('/public/tables/qr-a', { revalidate: 15, tags: ['table:qr-a'] });
    await serverRead('/public/tables/qr-b', { revalidate: 15, tags: ['table:qr-b'] });
    expect(state.keys[0]).not.toBe(state.keys[1]);
    expect(calls).toHaveLength(2);
  });

  it('a 404 or a failure is not cached, and each miss carries the address of the guest who caused it', async () => {
    respond = () => new Response('{}', { status: 404 });
    as('203.0.113.7');
    expect(await serverRead('/public/tables/unknown', { revalidate: 15 })).toEqual({ status: 'missing' });
    as('198.51.100.20');
    expect(await serverRead('/public/tables/unknown', { revalidate: 15 })).toEqual({ status: 'missing' });
    expect(calls.map((_, i) => sent(i))).toEqual(['203.0.113.7', '198.51.100.20']);
    respond = () => new Response('{}', { status: 503 });
    expect(await serverRead('/public/tables/other', { revalidate: 15 })).toEqual({ status: 'unavailable' });
    respond = () => Response.json({ table: 'T1' });
    expect(await serverRead('/public/tables/other', { revalidate: 15 })).toEqual({ status: 'ok', data: { table: 'T1' } });
  });

  it('an uncached (no-store) read is made per guest and forwards that guest', async () => {
    as('203.0.113.7');
    await serverRead('/public/order/x/orders/ref');
    as('198.51.100.20');
    await serverRead('/public/order/x/orders/ref');
    expect(state.keys).toHaveLength(0);
    expect(calls.map((_, i) => sent(i))).toEqual(['203.0.113.7', '198.51.100.20']);
    expect(calls.every((c) => c.init.cache === 'no-store')).toBe(true);
  });

  it('forwards nothing when the edge is not trusted', async () => {
    const saved = process.env.WEB_TRUST_PROXY;
    delete process.env.WEB_TRUST_PROXY;
    try {
      as('203.0.113.7');
      await serverRead('/public/order/x/orders/ref');
      expect(sent(0)).toBeUndefined();
    } finally { process.env.WEB_TRUST_PROXY = saved; }
  });
});
