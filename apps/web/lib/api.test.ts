import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, apiCacheMode, ApiRequestError, errorKind, noteServerCachePolicy, resetServerCachePolicy } from './api';

const respond = (status: number, body: string, contentType?: string) =>
  vi.fn(async (_url: string, _init?: RequestInit) => new Response(body, { status, headers: contentType ? { 'content-type': contentType, 'x-request-id': 'req-1' } : { 'x-request-id': 'req-1' } }));

afterEach(() => { vi.unstubAllGlobals(); });

describe('api()', () => {
  it('turns an HTML error page into a typed server error instead of a JSON SyntaxError', async () => {
    vi.stubGlobal('fetch', respond(503, '<html><body><h1>503 Service Unavailable</h1></body></html>', 'text/html'));
    const err = await api('/o/1/orders').catch((e) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err.name).toBe('ApiRequestError');
    expect(err.status).toBe(503);
    expect(err.kind).toBe('server');
    expect(err.requestId).toBe('req-1');
    expect(String(err.message)).not.toMatch(/SyntaxError|Unexpected token/);
  });

  it('keeps the API error envelope (code, message, details, request id)', async () => {
    vi.stubGlobal('fetch', respond(422, JSON.stringify({ error: { code: 'validation_failed', message: 'Bad input', details: { f: 1 }, requestId: 'r-9' } }), 'application/json; charset=utf-8'));
    const err = await api('/x', { body: {} }).catch((e) => e);
    expect(err).toMatchObject({ status: 422, code: 'validation_failed', message: 'Bad input', requestId: 'r-9', details: { f: 1 } });
    expect(err.kind).toBe('validation');
  });

  it('distinguishes offline from a cancelled request', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    expect((await api('/x').catch((e) => e)).kind).toBe('offline');
    const ctl = new AbortController();
    ctl.abort();
    vi.stubGlobal('fetch', vi.fn(async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }));
    expect((await api('/x', { signal: ctl.signal }).catch((e) => e)).kind).toBe('aborted');
  });

  it('rejects a successful response whose body is not JSON', async () => {
    vi.stubGlobal('fetch', respond(200, '<html>login portal</html>', 'text/html'));
    const err = await api('/x').catch((e) => e);
    expect(err.kind).toBe('bad_response');
  });

  it('returns JSON and null for empty bodies', async () => {
    vi.stubGlobal('fetch', respond(200, JSON.stringify({ ok: true }), 'application/json'));
    expect(await api('/x')).toEqual({ ok: true });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    expect(await api('/x', { method: 'DELETE' })).toBeNull();
  });

  it("starts in 'no-store' mode and sends the bearer token", async () => {
    resetServerCachePolicy();
    const f = respond(200, '{}', 'application/json');
    vi.stubGlobal('fetch', f);
    await api('/x', { token: 't' });
    const init = f.mock.calls[0]![1]!;
    expect(init.cache).toBe('no-store');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer t');
  });
});

describe('HTTP cache policy (PCL-03 without leaking tenant data into the disk cache)', () => {
  const withCacheControl = (cc: string | null) => vi.fn(async (_url: string, _init?: RequestInit) =>
    new Response('{}', { status: 200, headers: { 'content-type': 'application/json', ...(cc ? { 'cache-control': cc } : {}) } }));
  const modes = (f: ReturnType<typeof withCacheControl>) => f.mock.calls.map((c) => c[1]!.cache);
  afterEach(() => resetServerCachePolicy());

  it("keeps 'no-store' while the API declares no policy (this branch without PCL-04)", async () => {
    resetServerCachePolicy();
    const f = withCacheControl(null);
    vi.stubGlobal('fetch', f);
    for (let i = 0; i < 3; i++) await api('/o/1/orders', { token: 't' });
    expect(modes(f)).toEqual(['no-store', 'no-store', 'no-store']);
  });

  it('switches to the default mode once the API sends private, no-store, so preflights are cached', async () => {
    resetServerCachePolicy();
    const f = withCacheControl('private, no-store');
    vi.stubGlobal('fetch', f);
    for (let i = 0; i < 3; i++) await api('/o/1/orders', { token: 't' });
    expect(modes(f)).toEqual(['no-store', undefined, undefined]);
  });

  it('falls back to no-store for the rest of the page load when a response has no Cache-Control', async () => {
    resetServerCachePolicy();
    noteServerCachePolicy('private, no-store');
    expect(apiCacheMode()).toBeUndefined();
    noteServerCachePolicy(null);
    expect(apiCacheMode()).toBe('no-store');
    noteServerCachePolicy('private, no-store');
    expect(apiCacheMode()).toBe('no-store');
  });

  it('does not treat a cacheable public policy as a no-store declaration', () => {
    resetServerCachePolicy();
    noteServerCachePolicy('public, max-age=30, stale-while-revalidate=120');
    expect(apiCacheMode()).toBe('no-store');
    noteServerCachePolicy('no-store-ish');
    expect(apiCacheMode()).toBe('no-store');
    noteServerCachePolicy('No-Store');
    expect(apiCacheMode()).toBeUndefined();
  });
});

describe('errorKind', () => {
  it('maps statuses to the taxonomy', () => {
    expect(errorKind(0)).toBe('offline');
    expect(errorKind(401)).toBe('unauthorized');
    expect(errorKind(403)).toBe('forbidden');
    expect(errorKind(404)).toBe('not_found');
    expect(errorKind(409)).toBe('conflict');
    expect(errorKind(429)).toBe('rate_limited');
    expect(errorKind(400)).toBe('validation');
    expect(errorKind(502)).toBe('server');
  });
});

describe('api() full lists (PS-22)', () => {
  const page = (items: number[], nextCursor: string | null, full = true) => new Response(JSON.stringify({ items, nextCursor }), {
    status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store', ...(full ? { 'x-resuto-list': 'full' } : {}) },
  });

  it('follows nextCursor on lists marked X-Resuto-List: full and returns every row', async () => {
    const fetch = vi.fn(async (url: string) => {
      const c = new URL(url).searchParams.get('cursor');
      return c === null ? page([1, 2], 'c1') : c === 'c1' ? page([3, 4], 'c2') : page([5], null);
    });
    vi.stubGlobal('fetch', fetch);
    expect(await api('/o/1/inventory/items?q=oil')).toEqual({ items: [1, 2, 3, 4, 5], nextCursor: null });
    expect(fetch.mock.calls.map(([u]) => new URL(u).search)).toEqual(['?q=oil', '?q=oil&cursor=c1', '?q=oil&cursor=c2']);
  });

  it('returns one page when the list is not marked full, or the caller asked for a page', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => page([1], 'c1', false)));
    expect(await api('/o/1/orders')).toEqual({ items: [1], nextCursor: 'c1' });
    const fetch = vi.fn(async () => page([1], 'c1'));
    vi.stubGlobal('fetch', fetch);
    expect(await api('/o/1/inventory/items?limit=1')).toEqual({ items: [1], nextCursor: 'c1' });
    expect(await api('/o/1/inventory/items?cursor=c0')).toEqual({ items: [1], nextCursor: 'c1' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('stops at the page cap and on a repeated cursor instead of looping', async () => {
    const fetch = vi.fn(async () => page([1], 'same'));
    vi.stubGlobal('fetch', fetch);
    const r = await api('/o/1/marketing/segments');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(r).toEqual({ items: [1, 1], nextCursor: null });
  });
});
