import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiAll, apiCacheMode, type ApiOptions } from './api';
import { conditionalKey, forgetValidators, revalidatingCall, validatorCount } from './api-conditional';
import { QueryCache } from './query-cache';

// REM-W02 (PCL-24 web side): revalidating reads send the last ETag; a 304 resolves to the same answer object, without
// a body, a JSON parse or a structural compare, and nothing is shared across users, tenants or filters.

const json = (body: unknown, etag: string | null, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), {
  status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store', ...(etag ? { etag } : {}), ...extra },
});
const notModified = (extra: Record<string, string> = {}) => new Response(null, { status: 304, headers: { 'cache-control': 'private, no-store', ...extra } });
const sent = (f: ReturnType<typeof vi.fn>, call: number, header: string) => new Headers((f.mock.calls[call]![1] as RequestInit).headers).get(header);
const sentINM = (f: ReturnType<typeof vi.fn>, call: number) => sent(f, call, 'if-none-match');
/** useSession().call for a signed-in user (the token travels inside call, as in the app). */
const callAs = (token: string) => (<T,>(path: string, opts?: Omit<ApiOptions, 'token'>) => apiAll<T>(path, { ...opts, token })) as <T>(path: string, opts?: Omit<ApiOptions, 'token'>) => Promise<T>;
const read = (user: string, path: string) => revalidatingCall(callAs(`tok-${user}`), path, `u:${user}`);

beforeEach(() => forgetValidators());
afterEach(() => { vi.unstubAllGlobals(); forgetValidators(); });

describe('conditional GET for signed-in reads', () => {
  it('sends If-None-Match from the last answer and returns the same object on 304', async () => {
    const f = vi.fn().mockResolvedValueOnce(json({ orders: [1, 2] }, 'W/"a1"')).mockResolvedValueOnce(notModified());
    vi.stubGlobal('fetch', f);
    const first = await read('A', '/o/1/orders?status=open');
    const second = await read('A', '/o/1/orders?status=open');
    expect(sentINM(f, 0)).toBeNull();
    expect(sentINM(f, 1)).toBe('W/"a1"');
    // Without its own Cache-Control, fetch would add "no-cache" and Express would never answer 304.
    expect(sent(f, 1, 'cache-control')).toBe('max-age=0');
    expect(sent(f, 0, 'cache-control')).toBeNull();
    expect(second).toBe(first); // identity: an unchanged poll changes nothing downstream
  });

  it('a changed answer (200) replaces the remembered one and its ETag', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(json({ v: 1 }, 'W/"1"'))
      .mockResolvedValueOnce(json({ v: 2 }, 'W/"2"'))
      .mockResolvedValueOnce(notModified());
    vi.stubGlobal('fetch', f);
    await read('A', '/o/1/kds');
    expect(await read('A', '/o/1/kds')).toEqual({ v: 2 });
    expect(await read('A', '/o/1/kds')).toEqual({ v: 2 });
    expect(sentINM(f, 2)).toBe('W/"2"');
  });

  it('never answers one user, tenant or filter from another one\'s validator', async () => {
    const f = vi.fn(async () => json({ x: 1 }, 'W/"same"'));
    vi.stubGlobal('fetch', f);
    await read('A', '/o/1/orders');
    await read('B', '/o/1/orders');
    await read('A', '/o/2/orders');
    await read('A', '/o/1/orders?status=done');
    expect([1, 2, 3].map((i) => sentINM(f, i))).toEqual([null, null, null]);
    expect(conditionalKey('/o/1/orders', 'u:A', undefined)).not.toBe(conditionalKey('/o/1/orders', 'u:B', undefined));
  });

  it('forgets everything on sign-out (forgetValidators)', async () => {
    const f = vi.fn(async () => json({ x: 1 }, 'W/"e"'));
    vi.stubGlobal('fetch', f);
    await read('A', '/me');
    expect(validatorCount()).toBe(1);
    forgetValidators();
    await read('A', '/me');
    expect(sentINM(f, 1)).toBeNull();
  });

  it('plain api() reads (guest pages) and reads without a signed-in user send no validator', async () => {
    const f = vi.fn(async () => json({ ok: true }, 'W/"g"'));
    vi.stubGlobal('fetch', f);
    await apiAll('/public/order/x/track/1');
    await apiAll('/public/order/x/track/1');
    await revalidatingCall(callAs('t'), '/o/1/orders', null);
    await revalidatingCall(callAs('t'), '/o/1/orders', null);
    expect(f.mock.calls.map((_, i) => sentINM(f, i))).toEqual([null, null, null, null]);
    expect(validatorCount()).toBe(0);
  });

  it('does not remember multi-page lists (the ETag covers the first page only)', async () => {
    const f = vi.fn(async (url: string) => (new URL(url).searchParams.get('cursor') === null
      ? json({ items: [1], nextCursor: 'c1' }, 'W/"p1"', { 'x-resuto-list': 'full' }) : json({ items: [2], nextCursor: null }, 'W/"p2"')));
    vi.stubGlobal('fetch', f);
    expect(await read('A', '/o/1/inventory/items')).toEqual({ items: [1, 2], nextCursor: null });
    await read('A', '/o/1/inventory/items');
    expect(sentINM(f, 2)).toBeNull();
    expect(validatorCount()).toBe(0);
  });

  it('without a readable ETag (API does not expose it cross-origin) the read stays a plain GET', async () => {
    const f = vi.fn(async () => json({ x: 1 }, null));
    vi.stubGlobal('fetch', f);
    await read('A', '/o/1/orders');
    await read('A', '/o/1/orders');
    expect(sentINM(f, 1)).toBeNull();
  });

  it('keeps the authenticated-response cache rule: the request mode is unchanged (never stored on disk)', async () => {
    const f = vi.fn().mockResolvedValueOnce(json({ v: 1 }, 'W/"1"')).mockResolvedValueOnce(notModified());
    vi.stubGlobal('fetch', f);
    await read('A', '/o/1/x');
    await read('A', '/o/1/x');
    expect((f.mock.calls[1]![1] as RequestInit).cache).toBe(apiCacheMode());
  });

  it('other failures still fail', async () => {
    const f = vi.fn().mockResolvedValueOnce(json({ v: 1 }, 'W/"1"'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'forbidden', message: 'No' } }), { status: 403, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', f);
    await read('A', '/o/1/x');
    await expect(read('A', '/o/1/x')).rejects.toMatchObject({ status: 403 });
  });

  it('bounded: at most 100 remembered answers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ x: 1 }, 'W/"x"')));
    for (let i = 0; i < 130; i++) await read('A', `/o/1/items/${i}`);
    expect(validatorCount()).toBe(100);
  });
});

describe('query cache with a 304 poll', () => {
  it('keeps the entry\'s data object and refreshes its time (no new data for the screen)', async () => {
    let now = 1000;
    const qc = new QueryCache(50, () => now);
    const f = vi.fn().mockResolvedValueOnce(json({ tickets: [1] }, 'W/"k"')).mockResolvedValueOnce(notModified());
    vi.stubGlobal('fetch', f);
    const fetcher = () => read('A', '/o/1/kds');
    await qc.fetch('u|/o/1/kds', fetcher);
    const before = qc.get('u|/o/1/kds')!.data;
    now = 6000;
    await qc.fetch('u|/o/1/kds', fetcher);
    const after = qc.get('u|/o/1/kds')!;
    expect(after.data).toBe(before);
    expect(after.updatedAt).toBe(6000);
  });
});
