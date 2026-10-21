// AUTH-03: email-dependent flows in the session (Supabase mode, mocked supabase-js): the confirmation link keeps the
// page the user came for (an invitation), resends go to Supabase with the same return path, and /auth/callback learns
// whether a link expired, was opened in another browser, or was the first half of a secure email change.
import { createElement, act, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fakeJwt, installFakeDom, json } from './test-dom';

vi.mock('next/navigation', () => {
  const router = { replace: () => undefined, push: () => undefined, refresh: () => undefined, prefetch: () => undefined, back: () => undefined };
  return { useRouter: () => router, usePathname: () => '/auth/callback', useSearchParams: () => new URLSearchParams() };
});

const sb = {
  session: null as null | { access_token: string; user: { id: string; factors: unknown[] } },
  signUps: [] as Array<{ email: string; options: { emailRedirectTo: string } }>,
  resends: [] as unknown[],
  exchange: 'ok' as 'ok' | 'pkce' | 'expired',
  /** The signed-in user as Supabase Auth returns it (getUser): current email and the pending new one. */
  user: null as null | { id: string; email: string; new_email?: string },
};
const makeSession = () => ({ access_token: fakeJwt({ sub: 'u-link', email: 'new@olive.example', aal: 'aal1' }), user: { id: 'u-link', factors: [] } });

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: {
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      getSession: async () => ({ data: { session: sb.session }, error: null }),
      getUser: async () => ({ data: { user: sb.user }, error: sb.user ? null : Object.assign(new Error('Auth session missing!'), { name: 'AuthSessionMissingError', status: 400 }) }),
      signUp: async (p: { email: string; options: { emailRedirectTo: string } }) => { sb.signUps.push(p); return { data: { user: { id: 'u-link' }, session: null }, error: null }; },
      resend: async (p: unknown) => { sb.resends.push(p); return { data: {}, error: null }; },
      exchangeCodeForSession: async () => {
        if (sb.exchange === 'pkce') return { data: null, error: Object.assign(new Error('PKCE code verifier not found in storage.'), { name: 'AuthPKCEGrantCodeExchangeError' }) };
        if (sb.exchange === 'expired') return { data: null, error: Object.assign(new Error('Email link is invalid or has expired'), { code: 'otp_expired', status: 403 }) };
        sb.session = makeSession();
        return { data: { session: sb.session, redirectType: null }, error: null };
      },
      refreshSession: async () => ({ data: { session: sb.session }, error: null }),
      signOut: async () => ({ error: null }),
      mfa: { listFactors: async () => ({ data: { all: [], totp: [] }, error: null }) },
    },
  }),
}));

let dom: ReturnType<typeof installFakeDom>;
beforeAll(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://ref.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key');
  dom = installFakeDom('/auth/callback');
  globalThis.fetch = (async (input: string) => {
    const url = String(input);
    if (url.startsWith('https://api.pwnedpasswords.com/')) return new Response('0000000000000000000000000000000000A:1');
    if (new URL(url).pathname.endsWith('/me')) return json({ user: { id: 'u-link', email: 'new@olive.example' }, memberships: [], platformRole: null });
    return json({});
  }) as typeof fetch;
});
afterEach(() => { sb.session = null; sb.signUps = []; sb.resends = []; sb.exchange = 'ok'; sb.user = null; });

async function mount() {
  const { createRoot } = await import('react-dom/client');
  const { SessionProvider, useSession } = await import('../session');
  let session: ReturnType<typeof useSession> | null = null;
  function Probe(): ReactNode { session = useSession(); return null; }
  const root = createRoot(dom.container as unknown as Element);
  await act(async () => { root.render(createElement(SessionProvider, null, createElement(Probe))); });
  return { get: () => session!, unmount: () => act(async () => { root.unmount(); }) };
}

describe('AUTH-03 sign-up confirmation keeps where the user was going', () => {
  it('returns the confirmation link to the invitation (validated), never to another site', async () => {
    const s = await mount();
    let r: { confirmationRequired: boolean } | undefined;
    await act(async () => { r = await s.get().signUp('new@olive.example', 'Copper-Lantern-Harbor-58', 'Nadia', '/invite/tok123'); });
    expect(r).toEqual({ confirmationRequired: true });
    expect(s.get().token).toBeNull();                                   // never auto-confirmed / signed in
    expect(sb.signUps[0]!.options.emailRedirectTo).toBe('http://app.test/auth/callback?next=%2Finvite%2Ftok123');
    await act(async () => { await s.get().signUp('new@olive.example', 'Copper-Lantern-Harbor-58', 'Nadia', 'https://evil.example/x'); });
    expect(sb.signUps[1]!.options.emailRedirectTo).toBe('http://app.test/auth/callback?next=%2Fonboarding');
    await s.unmount();
  });

  it('resends the confirmation (and email-change) link through Supabase with the same return path', async () => {
    const s = await mount();
    await act(async () => { await s.get().resendEmail('signup', ' New@Olive.example ', '/invite/tok123'); });
    // Review finding: Supabase Auth (internal/api/resend.go) finds the user by the CURRENT email; the new address
    // matches nobody and gets a silent 200 with no email. The session sends the current address.
    sb.user = { id: 'u-link', email: 'Current@Olive.example', new_email: 'next@olive.example' };
    await act(async () => { await s.get().resendEmail('email_change'); });
    expect(sb.resends).toEqual([
      { type: 'signup', email: 'new@olive.example', options: { emailRedirectTo: 'http://app.test/auth/callback?next=%2Finvite%2Ftok123' } },
      { type: 'email_change', email: 'current@olive.example', options: { emailRedirectTo: 'http://app.test/auth/callback?next=%2Faccount%2Fsecurity' } },
    ]);
    await s.unmount();
  });

  it('with no email change pending, "send again" fails honestly instead of claiming a send', async () => {
    const s = await mount();
    sb.user = { id: 'u-link', email: 'current@olive.example' };
    await expect(s.get().resendEmail('email_change')).rejects.toMatchObject({ code: 'email_change_none' });
    sb.user = null;
    await expect(s.get().resendEmail('email_change')).rejects.toMatchObject({ name: 'AuthSessionMissingError' });
    expect(sb.resends).toEqual([]);
    await s.unmount();
  });
});

describe('AUTH-03 /auth/callback outcomes', () => {
  const CB = 'http://app.test/auth/callback?next=%2Fonboarding';

  it('an expired or used link is "link_expired"; other link errors are "link_invalid"', async () => {
    const s = await mount();
    await expect(s.get().completeAuthLink(`${CB}#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired`))
      .rejects.toMatchObject({ code: 'link_expired' });
    await expect(s.get().completeAuthLink(`${CB}#error=server_error&error_description=Database+error`)).rejects.toMatchObject({ code: 'link_invalid' });
    sb.exchange = 'expired';
    await expect(s.get().completeAuthLink(`${CB}&code=abc`)).rejects.toMatchObject({ code: 'otp_expired' });
    await s.unmount();
  });

  it('a PKCE link opened in another browser says so', async () => {
    const s = await mount();
    sb.exchange = 'pkce';
    await expect(s.get().completeAuthLink(`${CB}&code=abc`)).rejects.toMatchObject({ code: 'link_other_browser' });
    await s.unmount();
  });

  it('the first secure-email-change link is reported as half done (no session needed); the second as changed', async () => {
    const s = await mount();
    let r: unknown;
    await act(async () => { r = await s.get().completeAuthLink('http://app.test/auth/callback?next=%2Faccount%2Fsecurity#message=Confirmation+link+accepted.+Please+proceed+to+confirm+link+sent+to+the+other+email'); });
    expect(r).toEqual({ mfaRequired: false, notice: 'email_change_half' });
    sb.session = makeSession();
    await act(async () => { r = await s.get().completeAuthLink('http://app.test/auth/callback?next=%2Faccount%2Fsecurity#access_token=x&type=email_change'); });
    expect(r).toEqual({ mfaRequired: false, notice: 'email_changed' });
    expect(s.get().token).not.toBeNull();
    await s.unmount();
  });

  it('a valid sign-up confirmation signs the user in', async () => {
    const s = await mount();
    let r: unknown;
    await act(async () => { r = await s.get().completeAuthLink(`${CB}&code=good`); });
    expect(r).toEqual({ mfaRequired: false, notice: undefined });
    expect(s.get().me?.user.email).toBe('new@olive.example');
    await s.unmount();
  });
});
