// REM-W02 (PCL-24): a poll the API answers with 304 (or with the same content) must not render the screen. The cache
// notifies when a request starts and ends; useApi renders only when data, error, loading or pending change.
// (The error branch is covered by the pure visibleOf/sameVisible test below.)
//
// Same harness as session-stability.test.ts: the real SessionProvider and useApi rendered with react-dom into a minimal
// stand-in for the DOM (the web workspace has no DOM test environment).
import * as React from 'react';
import { createElement, act, type ReactNode } from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => {
  const router = { replace: () => undefined, push: () => undefined, refresh: () => undefined, prefetch: () => undefined, back: () => undefined };
  return { useRouter: () => router, usePathname: () => '/dashboard/org-1/orders', useSearchParams: () => new URLSearchParams() };
});

const noop = () => undefined;
const fakeDocument = { documentElement: { lang: 'en' }, visibilityState: 'visible', activeElement: null, querySelector: () => null, addEventListener: noop, removeEventListener: noop };
const container = { nodeType: 1, nodeName: 'DIV', tagName: 'DIV', localName: 'div', namespaceURI: 'http://www.w3.org/1999/xhtml', ownerDocument: fakeDocument, addEventListener: noop, removeEventListener: noop };
const store = new Map<string, string>();
const jwt = (sub: string) => `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.sig`;

/** What the fake API serves for the orders list, and how it answered each orders request. */
let revision = 1;
const answers: Array<{ status: number; ifNoneMatch: string | null }> = [];

beforeAll(() => {
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    React,
    document: fakeDocument,
    window: { HTMLIFrameElement: class {}, addEventListener: noop, removeEventListener: noop, location: { pathname: '/dashboard/org-1/orders', search: '', origin: 'http://app.test' } },
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); }, key: () => null, length: 0 },
    sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  });
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
  store.set('resuto_session', JSON.stringify({ accessToken: jwt('user-1'), expiresAt: Date.now() + 3600_000, email: 'owner@example.test' }));
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const headers = new Headers(init?.headers);
    const json = (body: unknown, h: Record<string, string> = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...h } });
    if (path.endsWith('/me')) return json({ user: { id: 'user-1', email: 'owner@example.test' }, memberships: [] });
    const etag = `W/"orders-${revision}"`;
    const ifNoneMatch = headers.get('if-none-match');
    if (ifNoneMatch === etag) { answers.push({ status: 304, ifNoneMatch }); return new Response(null, { status: 304, headers: { etag } }); }
    answers.push({ status: 200, ifNoneMatch });
    return json({ items: [{ id: 'order-1', revision }] }, { etag });
  }) as typeof fetch;
});
afterAll(() => { vi.useRealTimers(); });

describe('useApi renders only when what the screen shows changes (REM-W02)', () => {
  it('304 polls keep the same object and do not render; a change does', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const { createRoot } = await import('react-dom/client');
    const { SessionProvider } = await import('./session');
    const { useApi } = await import('./use-api');

    const renders: Array<{ data: unknown; error: unknown }> = [];
    function Probe(): ReactNode {
      const orders = useApi<{ items: Array<{ id: string; revision: number }> }>('/o/org-1/orders', { pollMs: 5000 });
      renders.push({ data: orders.data, error: orders.error });
      return null;
    }

    const root = createRoot(container as unknown as Element);
    await act(async () => { root.render(createElement(SessionProvider, null, createElement(Probe))); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    const first = renders.at(-1)!.data;
    expect(first).toMatchObject({ items: [{ revision: 1 }] });
    const afterLoad = renders.length;

    // Several polls (5 s plus jitter), each revalidated with the remembered ETag and answered 304: no render at all.
    const before = answers.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    const polls = answers.slice(before);
    expect(polls.length).toBeGreaterThanOrEqual(3);
    expect(polls).toEqual(polls.map(() => ({ status: 304, ifNoneMatch: 'W/"orders-1"' })));
    expect(renders.length).toBe(afterLoad);

    // The list changes: the next poll gets 200 with the new content and renders it.
    revision = 2;
    for (let i = 0; i < 10 && renders.at(-1)!.data === first; i++) await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(answers.at(-1)).toEqual({ status: 200, ifNoneMatch: 'W/"orders-1"' });
    expect(renders.at(-1)!.data).toMatchObject({ items: [{ revision: 2 }] });
    const afterChange = renders.length;
    expect(afterChange).toBeGreaterThan(afterLoad);

    const changed = renders.length;

    // Unchanged again: quiet.
    const quiet = answers.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(14_000); });
    expect(answers.length).toBeGreaterThan(quiet);
    expect(answers.slice(quiet).every((a) => a.status === 304)).toBe(true);
    expect(renders.length).toBe(changed);
    await act(async () => { root.unmount(); });
  });
});

describe('which cache changes reach the screen', () => {
  it('data, errors and loading do; a background refresh start/end alone does not', async () => {
    const { sameVisible, visibleOf } = await import('./use-api');
    const data = { items: [] };
    const err = new Error('down');
    const idle = visibleOf({ data });
    expect(sameVisible(idle, visibleOf({ data, inflight: {} }))).toBe(true);                // poll started: quiet
    expect(sameVisible(idle, visibleOf({ data: { items: [] } }))).toBe(false);              // new content
    expect(sameVisible(idle, visibleOf({ data, error: err }))).toBe(false);                 // a failure is shown
    const failed = visibleOf({ data, error: err });
    expect(sameVisible(failed, visibleOf({ data, error: err, inflight: {} }))).toBe(false);  // the error hides while retrying
    expect(sameVisible(visibleOf(undefined), visibleOf({ inflight: {} }))).toBe(false);      // first load: loading
    expect(sameVisible(null, idle)).toBe(false);                                             // nothing rendered yet
  });
});
