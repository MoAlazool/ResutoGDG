// AUTH-02: the SessionProvider in Supabase mode, with a mocked supabase-js client. A password session of an account
// with a verified authenticator never reaches the app (token null, no /me) until the code is verified; accounts
// without one sign in as before; a 403 mfa_required from the API turns into the code step, also in a new provider.
import { createElement, act, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fakeJwt, installFakeDom, json } from './test-dom';

vi.mock('next/navigation', () => {
  const router = { replace: () => undefined, push: () => undefined, refresh: () => undefined, prefetch: () => undefined, back: () => undefined };
  return { useRouter: () => router, usePathname: () => '/login', useSearchParams: () => new URLSearchParams() };
});

type Listener = (event: string, session: unknown) => void;
const sb = {
  session: null as null | { access_token: string; user: { id: string; email: string; factors: unknown[] } },
  factors: [] as Array<{ id: string; status: string; factor_type: string }>,
  /** What the session's user object lists (stale when a factor was added elsewhere). */
  sessionFactors: null as null | unknown[],
  listeners: [] as Listener[],
  calls: [] as string[],
  code: '246810',
};
const makeSession = (aal: 'aal1' | 'aal2', factors = sb.sessionFactors ?? sb.factors) =>
  ({ access_token: fakeJwt({ sub: 'u-mfa', email: 'owner@olive.example', aal, n: Math.random() }), user: { id: 'u-mfa', email: 'owner@olive.example', factors } });
const emit = (event: string) => { for (const l of sb.listeners) l(event, sb.session); };

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: {
      onAuthStateChange(cb: Listener) { sb.listeners.push(cb); return { data: { subscription: { unsubscribe() { sb.listeners = sb.listeners.filter((l) => l !== cb); } } } }; },
      getSession: async () => ({ data: { session: sb.session }, error: null }),
      signInWithPassword: async () => { sb.calls.push('password'); sb.session = makeSession('aal1'); emit('SIGNED_IN'); return { data: { session: sb.session, user: sb.session.user }, error: null }; },
      refreshSession: async () => {
        sb.calls.push('refresh');
        const aal = sb.session && JSON.parse(Buffer.from(sb.session.access_token.split('.')[1]!, 'base64url').toString()).aal;
        sb.sessionFactors = null;   // the token endpoint returns the fresh user (with its factors)
        sb.session = sb.session ? makeSession(aal, sb.factors) : null;
        emit('TOKEN_REFRESHED');
        return { data: { session: sb.session }, error: null };
      },
      signOut: async () => { sb.session = null; emit('SIGNED_OUT'); return { error: null }; },
      exchangeCodeForSession: async () => { sb.session = makeSession('aal1'); emit('SIGNED_IN'); return { data: { session: sb.session, redirectType: null }, error: null }; },
      mfa: {
        listFactors: async () => ({ data: { all: sb.factors, totp: sb.factors.filter((f) => f.status === 'verified') }, error: null }),
        challengeAndVerify: async ({ code }: { code: string }) => {
          sb.calls.push(`verify:${code}`);
          if (code !== sb.code) return { data: null, error: Object.assign(new Error('Invalid TOTP code entered'), { code: 'mfa_verification_failed', status: 422 }) };
          sb.session = makeSession('aal2', sb.factors);
          emit('MFA_CHALLENGE_VERIFIED');
          return { data: {}, error: null };
        },
        enroll: async () => ({ data: null, error: new Error('not used') }),
        unenroll: async () => ({ data: {}, error: null }),
      },
    },
  }),
}));

const apiCalls: Array<{ path: string; aal: unknown }> = [];
let dom: ReturnType<typeof installFakeDom>;

beforeAll(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://ref.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key');
  dom = installFakeDom('/login');
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const tok = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '') ?? '';
    const aal = tok ? JSON.parse(Buffer.from(tok.split('.')[1]!, 'base64url').toString()).aal : null;
    apiCalls.push({ path, aal });
    if (path.endsWith('/me')) return json({ user: { id: 'u-mfa', email: 'owner@olive.example' }, memberships: [], platformRole: null });
    if (path.endsWith('/invitations') && aal !== 'aal2') {
      return json({ error: { code: 'mfa_required', message: 'Enter the code from your authenticator app to continue', details: { requiredAal: 'aal2' }, requestId: 'r1' } }, 403);
    }
    return json({ ok: true });
  }) as typeof fetch;
});

afterEach(() => {
  sb.session = null; sb.factors = []; sb.sessionFactors = null; sb.calls = []; apiCalls.length = 0;
  dom.session.clear();
});

async function mount() {
  const { createRoot } = await import('react-dom/client');
  const { SessionProvider, useSession } = await import('../session');
  let session: ReturnType<typeof useSession> | null = null;
  function Probe(): ReactNode { session = useSession(); return null; }
  const root = createRoot(dom.container as unknown as Element);
  await act(async () => { root.render(createElement(SessionProvider, null, createElement(Probe))); });
  return { get: () => session!, unmount: () => act(async () => { root.unmount(); }) };
}

describe('AUTH-02 sign-in code step (Supabase mode)', () => {
  it('holds an aal1 session of an enrolled account back until a valid code; the app is entered at aal2', async () => {
    sb.factors = [{ id: 'f1', status: 'verified', factor_type: 'totp' }];
    const s = await mount();
    let r: { mfaRequired: boolean } | undefined;
    await act(async () => { r = await s.get().signIn('owner@olive.example', 'Copper-Lantern-Harbor-58'); });
    expect(r).toEqual({ mfaRequired: true });
    expect(s.get().mfaRequired).toBe(true);
    expect(s.get().token).toBeNull();
    expect(apiCalls).toEqual([]);                                   // nothing of the app was loaded at aal1

    await act(async () => { await expect(s.get().verifyMfa('111111')).rejects.toMatchObject({ code: 'mfa_verification_failed' }); });
    await act(async () => { await expect(s.get().verifyMfa('12')).rejects.toMatchObject({ code: 'mfa_code_format' }); });
    expect(s.get().token).toBeNull();

    await act(async () => { await s.get().verifyMfa('٢٤٦٨١٠'); });   // Arabic-Indic digits
    expect(s.get().mfaRequired).toBe(false);
    expect(s.get().token).not.toBeNull();
    expect(s.get().me?.user.email).toBe('owner@olive.example');
    expect(apiCalls.every((c) => c.aal === 'aal2')).toBe(true);
    await s.unmount();
  });

  it('accounts without a verified authenticator sign in directly (demo accounts keep working)', async () => {
    sb.factors = [{ id: 'f0', status: 'unverified', factor_type: 'totp' }];
    const s = await mount();
    let r: { mfaRequired: boolean } | undefined;
    await act(async () => { r = await s.get().signIn('owner@olive.example', 'Copper-Lantern-Harbor-58'); });
    expect(r).toEqual({ mfaRequired: false });
    expect(s.get().mfaRequired).toBe(false);
    expect(s.get().token).not.toBeNull();
    await s.unmount();
  });

  it('a stored aal1 session of an enrolled account (tab reopened mid-sign-in) also starts at the code step', async () => {
    sb.factors = [{ id: 'f1', status: 'verified', factor_type: 'totp' }];
    sb.session = makeSession('aal1');
    const s = await mount();
    expect(s.get().ready).toBe(true);
    expect(s.get().mfaRequired).toBe(true);
    expect(s.get().token).toBeNull();
    expect(apiCalls).toEqual([]);
    await s.unmount();
  });

  it('an email link (recovery, confirmation) at aal1 owes the code too', async () => {
    sb.factors = [{ id: 'f1', status: 'verified', factor_type: 'totp' }];
    const s = await mount();
    let r: { mfaRequired: boolean } | undefined;
    await act(async () => { r = await s.get().completeAuthLink('http://app.test/auth/callback?code=abc&next=%2Freset-password'); });
    expect(r).toEqual({ mfaRequired: true });
    expect(s.get().token).toBeNull();
    await s.unmount();
  });
});

describe('AUTH-02 403 mfa_required from the API', () => {
  it('turns into the code step (token held back, session refreshed) and survives a new provider with a stale session', async () => {
    // Signed in at aal1 before a factor existed; then a factor is added on another device.
    sb.session = makeSession('aal1', []);
    const s = await mount();
    expect(s.get().token).not.toBeNull();
    sb.factors = [{ id: 'f9', status: 'verified', factor_type: 'totp' }];
    sb.sessionFactors = [];                                         // this tab's user object does not list it yet
    await act(async () => {
      await expect(s.get().call('/o/org-1/invitations', { body: { email: 'x@y.example', role: 'waiter' } })).rejects.toMatchObject({ code: 'mfa_required', status: 403 });
    });
    expect(s.get().mfaRequired).toBe(true);
    expect(s.get().token).toBeNull();
    expect(sb.calls).toContain('refresh');
    await s.unmount();

    // The sign-in page mounts its own provider; even with a stale aal1 session it shows the code step.
    sb.session = makeSession('aal1', []);
    const again = await mount();
    expect(again.get().mfaRequired).toBe(true);
    expect(again.get().token).toBeNull();
    await act(async () => { await again.get().verifyMfa(sb.code); });
    expect(again.get().mfaRequired).toBe(false);
    await act(async () => { await again.get().call('/o/org-1/invitations', { body: { email: 'x@y.example', role: 'waiter' } }); });
    expect(apiCalls.at(-1)).toEqual({ path: '/v1/o/org-1/invitations', aal: 'aal2' });
    await again.unmount();
  });
});
