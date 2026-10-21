// AUTH-01: the session's sign-up and change-password run Resuto's compensating password checks BEFORE anything is sent
// to the auth service, and an unreachable breach service does not block.
import { createHash } from 'node:crypto';
import { createElement, act, type ReactNode } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fakeJwt, installFakeDom, json } from './test-dom';

vi.mock('next/navigation', () => {
  const router = { replace: () => undefined, push: () => undefined, refresh: () => undefined, prefetch: () => undefined, back: () => undefined };
  return { useRouter: () => router, usePathname: () => '/signup', useSearchParams: () => new URLSearchParams() };
});

const BREACHED = 'Copper-Lantern-Harbor-11';
const FRESH = 'Copper-Lantern-Harbor-58';
const sha1 = (s: string) => createHash('sha1').update(s).digest('hex').toUpperCase();
const sent: string[] = [];
let pwnedDown = false;
let dom: ReturnType<typeof installFakeDom>;

beforeAll(() => {
  dom = installFakeDom('/signup');
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const url = String(input);
    sent.push(url);
    if (url.startsWith('https://api.pwnedpasswords.com/range/')) {
      if (pwnedDown) throw new TypeError('Failed to fetch');
      const h = sha1(BREACHED);
      return new Response(url.endsWith(h.slice(0, 5)) ? `${h.slice(5)}:31\r\n0000000000000000000000000000000000A:0` : '0000000000000000000000000000000000A:2');
    }
    const path = new URL(url).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (path.endsWith('/auth/dev/signup')) return json({ accessToken: fakeJwt({ sub: 'u-new', email: body.email }), expiresIn: 3600 });
    if (path.endsWith('/auth/dev/login')) return json({ accessToken: fakeJwt({ sub: 'u-1', email: body.email }), expiresIn: 3600 });
    if (path.endsWith('/auth/dev/password')) return json({ ok: true });
    if (path.endsWith('/me')) return json({ user: { id: 'u-1', email: 'nadia.owner@olive.example' }, memberships: [], platformRole: null });
    return json({});
  }) as typeof fetch;
});

async function mount() {
  const { createRoot } = await import('react-dom/client');
  const { SessionProvider, useSession } = await import('../session');
  let session: ReturnType<typeof useSession> | null = null;
  function Probe(): ReactNode { session = useSession(); return null; }
  const root = createRoot(dom.container as unknown as Element);
  await act(async () => { root.render(createElement(SessionProvider, null, createElement(Probe))); });
  return { get: () => session!, root };
}

describe('AUTH-01 password checks in the session (dev issuer)', () => {
  it('refuses a common or breached password on sign-up without creating the account; accepts a fresh one', async () => {
    const { get, root } = await mount();
    sent.length = 0;
    await expect(get().signUp('nadia.owner@olive.example', 'Password12345')).rejects.toMatchObject({ code: 'password_common' });
    await expect(get().signUp('nadia.owner@olive.example', 'nadia.owner-2026!')).rejects.toMatchObject({ code: 'password_contains_email' });
    expect(sent).toEqual([]);   // local rules need no network at all
    await expect(get().signUp('nadia.owner@olive.example', BREACHED)).rejects.toMatchObject({ code: 'password_breached' });
    expect(sent.some((u) => u.includes('/auth/dev/signup'))).toBe(false);
    expect(sent.every((u) => !u.includes(BREACHED))).toBe(true);
    await act(async () => { await get().signUp('nadia.owner@olive.example', FRESH); });
    expect(sent.some((u) => u.includes('/auth/dev/signup'))).toBe(true);
    await act(async () => { root.unmount(); });
  });

  it('checks the new password (with the signed-in email) before changing it, and allows it when the breach service is down', async () => {
    const { get, root } = await mount();
    await act(async () => { await get().signIn('nadia.owner@olive.example', FRESH); });
    sent.length = 0;
    await expect(get().updatePassword('NADIA.OWNER-kitchen-9', FRESH)).rejects.toMatchObject({ code: 'password_contains_email' });
    await expect(get().updatePassword(BREACHED, FRESH)).rejects.toMatchObject({ code: 'password_breached' });
    expect(sent.some((u) => u.includes('/auth/dev/password'))).toBe(false);
    pwnedDown = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await act(async () => { await get().updatePassword('Quiet-Olive-Terrace-404', FRESH); });
    expect(warn).toHaveBeenCalled();
    expect(sent.some((u) => u.includes('/auth/dev/password'))).toBe(true);
    warn.mockRestore();
    pwnedDown = false;
    await act(async () => { root.unmount(); });
  });
});
