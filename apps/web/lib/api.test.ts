import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiRequestError, errorKind } from './api';

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

  it('uses the default cache mode so the browser can reuse CORS preflights (no cache: no-store)', async () => {
    const f = respond(200, '{}', 'application/json');
    vi.stubGlobal('fetch', f);
    await api('/x', { token: 't' });
    const init = f.mock.calls[0]![1]!;
    expect(init.cache).toBeUndefined();
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer t');
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
