// DF-13: every poller and the KDS board must not restart (or blank) when the session token changes, as it does on
// a Supabase TOKEN_REFRESHED event. `useSession().call` must keep its identity across token changes (KitchenBoard's
// polling effect depends on it), and useApi's polling effect must not be torn down and set up again.
//
// The web workspace has no DOM test environment, so this renders the real SessionProvider and useApi with react-dom
// into a minimal stand-in for the DOM: the components under test render nothing, and the polling effect's
// `document.addEventListener('visibilitychange', …)` is counted to see how often it is set up.
import * as React from 'react';
import { createElement, act, type ReactNode } from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => {
  const router = { replace: () => undefined, push: () => undefined, refresh: () => undefined, prefetch: () => undefined, back: () => undefined };
  return { useRouter: () => router, usePathname: () => '/dashboard/org-1/orders', useSearchParams: () => new URLSearchParams() };
});

const listeners = new Map<string, number>();
const noop = () => undefined;
const fakeDocument = {
  visibilityState: 'visible',
  activeElement: null,
  querySelector: () => null,
  addEventListener: (type: string) => { listeners.set(type, (listeners.get(type) ?? 0) + 1); },
  removeEventListener: noop,
};
const container = { nodeType: 1, nodeName: 'DIV', tagName: 'DIV', localName: 'div', namespaceURI: 'http://www.w3.org/1999/xhtml', ownerDocument: fakeDocument, addEventListener: noop, removeEventListener: noop };
const store = new Map<string, string>();
const jwt = (sub: string, n: number) => `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub, n })).toString('base64url')}.sig${n}`;
const TOKEN_A = jwt('user-1', 1);
const TOKEN_B = jwt('user-1', 2);   // same user, refreshed token
const seenTokens: string[] = [];
let ordersServed = 0;

beforeAll(() => {
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    React,   // the provider's JSX compiles to React.createElement without the Next.js toolchain
    document: fakeDocument,
    window: { HTMLIFrameElement: class {}, addEventListener: noop, removeEventListener: noop, location: { pathname: '/dashboard/org-1/orders', search: '', origin: 'http://app.test' } },
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); }, key: () => null, length: 0 },
    sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  });
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
  store.set('resuto_session', JSON.stringify({ accessToken: TOKEN_A, expiresAt: Date.now() + 3600_000, email: 'owner@example.test' }));
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    seenTokens.push(auth.replace(/^Bearer /, ''));
    const path = new URL(url).pathname;
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (path.endsWith('/auth/dev/login')) return json({ accessToken: TOKEN_B, expiresIn: 3600 });
    if (path.endsWith('/me')) return json({ user: { id: 'user-1', email: 'owner@example.test' }, memberships: [] });
    ordersServed++;
    return json({ items: [{ id: `order-${ordersServed}` }] });
  }) as typeof fetch;
});
afterAll(() => { vi.useRealTimers(); });

describe('session token refresh keeps pollers running (DF-13)', () => {
  it('keeps `call` stable, does not recreate the polling effect and never blanks the data', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const { createRoot } = await import('react-dom/client');
    const { SessionProvider, useSession } = await import('./session');
    const { useApi } = await import('./use-api');

    const calls: unknown[] = [];
    const tokens: Array<string | null> = [];
    const data: unknown[] = [];
    let session: ReturnType<typeof useSession> | null = null;
    function Probe(): ReactNode {
      session = useSession();
      calls.push(session.call);
      tokens.push(session.token);
      const orders = useApi<{ items: Array<{ id: string }> }>('/o/org-1/orders', { pollMs: 5000 });
      data.push(orders.data);
      return null;
    }

    const root = createRoot(container as unknown as Element);
    await act(async () => { root.render(createElement(SessionProvider, null, createElement(Probe))); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(session!.token).toBe(TOKEN_A);
    expect(data.at(-1)).toBeDefined();
    const pollSetups = listeners.get('visibilitychange') ?? 0;
    expect(pollSetups).toBe(1);
    const callBefore = session!.call;
    const servedBefore = ordersServed;

    // The token changes (dev issuer: a new sign-in; Supabase: TOKEN_REFRESHED) for the same user.
    await act(async () => { await session!.signIn('owner@example.test', 'correct-horse-battery'); });
    expect(session!.token).toBe(TOKEN_B);
    expect(tokens).toContain(TOKEN_A);
    expect(session!.call).toBe(callBefore);                                   // KitchenBoard's load() keeps its identity
    expect(listeners.get('visibilitychange')).toBe(pollSetups);               // useApi's polling effect was not recreated
    expect(ordersServed).toBe(servedBefore);                                  // no foreground reload on a token change
    expect(data.slice(data.findIndex((d) => d !== undefined)).every((d) => d !== undefined)).toBe(true);   // never blanked

    // The next scheduled poll runs on time and already uses the new token.
    await act(async () => { await vi.advanceTimersByTimeAsync(5_100); });
    expect(ordersServed).toBe(servedBefore + 1);
    expect(seenTokens.at(-1)).toBe(TOKEN_B);
    expect(new Set(calls).size).toBe(1);
    await act(async () => { root.unmount(); });
  });
});
