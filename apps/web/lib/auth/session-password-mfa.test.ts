// AUTH-02 regression (review finding): a signed-in password change on Account > Security must work for an account
// with an authenticator. The mocked Supabase Auth follows its real rules (supabase/auth internal/api/user.go):
// - a user with a verified factor needs an aal2 session to change the password (401 insufficient_aal);
// - with "secure password change" on, a session older than 24 hours needs reauthentication (400 reauthentication_needed);
// - a password change signs out every OTHER session of the user (models.UpdatePassword -> LogoutAllExceptMe).
// Each createClient() call gets its own client and session, like supabase-js with separate storage keys.
import { createElement, act, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fakeJwt, installFakeDom, json } from './test-dom';

vi.mock('next/navigation', () => {
  const router = { replace: () => undefined, push: () => undefined, refresh: () => undefined, prefetch: () => undefined, back: () => undefined };
  return { useRouter: () => router, usePathname: () => '/account/security', useSearchParams: () => new URLSearchParams() };
});

type Listener = (event: string, session: unknown) => void;
interface Sess { id: number; access_token: string; refresh_token: string; old: boolean; user: { id: string; email: string; factors: unknown[] } }
const server = {
  password: 'Old-Current-Password-1',
  factors: [] as Array<{ id: string; status: string; factor_type: string }>,
  secureChange: false,
  live: new Set<number>(),
  next: 1,
  calls: [] as string[],
};
const aalOf = (s: Sess | null) => (s ? JSON.parse(Buffer.from(s.access_token.split('.')[1]!, 'base64url').toString()).aal : null);
const newSession = (aal: 'aal1' | 'aal2', old = false): Sess => {
  const id = server.next++;
  server.live.add(id);
  return { id, old, access_token: fakeJwt({ sub: 'u-owner', email: 'owner@olive.example', aal, session_id: id }), refresh_token: `r${id}`, user: { id: 'u-owner', email: 'owner@olive.example', factors: server.factors } };
};
const err = (message: string, code: string, status: number) => Object.assign(new Error(message), { code, status });

const clients: Array<{ key: string; state: { session: Sess | null; listeners: Listener[] } }> = [];
let mainStart: Sess | null = null;

vi.mock('@supabase/supabase-js', () => ({
  createClient: (_url: string, _key: string, opts?: { auth?: { storageKey?: string; persistSession?: boolean } }) => {
    const key = opts?.auth?.storageKey ?? 'main';
    const state = { session: key === 'main' ? mainStart : null as Sess | null, listeners: [] as Listener[] };
    clients.push({ key, state });
    const emit = (e: string) => { for (const l of state.listeners) l(e, state.session); };
    return {
      auth: {
        onAuthStateChange(cb: Listener) { state.listeners.push(cb); return { data: { subscription: { unsubscribe() { state.listeners = state.listeners.filter((l) => l !== cb); } } } }; },
        getSession: async () => ({ data: { session: state.session }, error: null }),
        getUser: async () => ({ data: { user: state.session?.user ?? null }, error: null }),
        signInWithPassword: async ({ password }: { email: string; password: string }) => {
          server.calls.push(`${key}:signInWithPassword`);
          if (password !== server.password) return { data: { session: null, user: null }, error: err('Invalid login credentials', 'invalid_credentials', 400) };
          state.session = newSession('aal1');
          emit('SIGNED_IN');
          return { data: { session: state.session, user: state.session.user }, error: null };
        },
        setSession: async (s: Sess) => { server.calls.push(`${key}:setSession`); state.session = s; emit('SIGNED_IN'); return { data: { session: s, user: s.user }, error: null }; },
        updateUser: async ({ password }: { password: string }) => {
          const s = state.session;
          server.calls.push(`${key}:updateUser@${aalOf(s)}`);
          if (!s || !server.live.has(s.id)) return { data: { user: null }, error: err('Session not found', 'session_not_found', 403) };
          if (server.factors.some((f) => f.status === 'verified') && aalOf(s) !== 'aal2') {
            return { data: { user: null }, error: err('AAL2 session is required to update email or password when MFA is enabled.', 'insufficient_aal', 401) };
          }
          if (server.secureChange && s.old) return { data: { user: null }, error: err('Password update requires reauthentication', 'reauthentication_needed', 400) };
          if (password === server.password) return { data: { user: null }, error: err('New password should be different from the old password.', 'same_password', 422) };
          server.password = password;
          for (const id of [...server.live]) if (id !== s.id) server.live.delete(id);   // LogoutAllExceptMe
          emit('USER_UPDATED');
          return { data: { user: s.user }, error: null };
        },
        refreshSession: async () => ({ data: { session: state.session }, error: null }),
        signOut: async ({ scope }: { scope?: string } = {}) => {
          server.calls.push(`${key}:signOut:${scope ?? 'global'}`);
          if (state.session) server.live.delete(state.session.id);
          state.session = null;
          emit('SIGNED_OUT');
          return { error: null };
        },
        mfa: { listFactors: async () => ({ data: { all: server.factors, totp: server.factors }, error: null }) },
      },
    };
  },
}));

let dom: ReturnType<typeof installFakeDom>;
beforeAll(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://ref.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key');
  dom = installFakeDom('/account/security');
  globalThis.fetch = (async (input: string) => {
    const url = String(input);
    if (url.startsWith('https://api.pwnedpasswords.com/')) return new Response('0000000000000000000000000000000000A:0');
    if (new URL(url).pathname.endsWith('/me')) return json({ user: { id: 'u-owner', email: 'owner@olive.example' }, memberships: [], platformRole: null });
    return json({});
  }) as typeof fetch;
});
afterEach(() => {
  server.password = 'Old-Current-Password-1';
  server.factors = [];
  server.secureChange = false;
  server.calls = [];
});

/** The app's (main) client state; clients are created once per module (lazy singletons), so look them up by key. */
const main = () => clients.find((c) => c.key === 'main')!.state;

async function mount(start: Sess) {
  mainStart = start;
  const existing = clients.find((c) => c.key === 'main');
  if (existing) existing.state.session = start;
  const { createRoot } = await import('react-dom/client');
  const { SessionProvider, useSession } = await import('../session');
  let session: ReturnType<typeof useSession> | null = null;
  function Probe(): ReactNode { session = useSession(); return null; }
  const root = createRoot(dom.container as unknown as Element);
  await act(async () => { root.render(createElement(SessionProvider, null, createElement(Probe))); });
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  return { get: () => session!, unmount: () => act(async () => { root.unmount(); }) };
}

const enrol = () => { server.factors = [{ id: 'f-1', status: 'verified', factor_type: 'totp' }]; };

describe('AUTH-02 signed-in password change keeps the session', () => {
  it('an account with an authenticator (aal2) changes its password; the token and the code step are untouched', async () => {
    enrol();
    const s = await mount(newSession('aal2'));
    const before = s.get().token;
    expect(before).not.toBeNull();
    expect(s.get().mfaRequired).toBe(false);
    await act(async () => { await s.get().updatePassword('Quiet-Orchard-Lamp-7319', 'Old-Current-Password-1'); });
    expect(server.password).toBe('Quiet-Orchard-Lamp-7319');
    // The current password was checked on the separate client; the app's aal2 session made the change.
    expect(server.calls).toEqual(['resuto-password-reverify:signInWithPassword', 'main:updateUser@aal2']);
    expect(s.get().token).toBe(before);
    expect(s.get().mfaRequired).toBe(false);
    expect(server.live.has(main().session!.id)).toBe(true);   // the app's session survives the change
    await s.unmount();
  });

  it('a wrong current password changes nothing and keeps the session', async () => {
    enrol();
    const s = await mount(newSession('aal2'));
    const before = s.get().token;
    await expect(s.get().updatePassword('Quiet-Orchard-Lamp-7319', 'Wrong-Password-99')).rejects.toMatchObject({ code: 'current_password_incorrect' });
    expect(server.calls).toEqual(['resuto-password-reverify:signInWithPassword']);
    expect(server.password).toBe('Old-Current-Password-1');
    expect(s.get().token).toBe(before);
    expect(s.get().mfaRequired).toBe(false);
    await s.unmount();
  });

  it('a refused change ends the check\'s own session (no stray session left on the server)', async () => {
    const s = await mount(newSession('aal1'));
    await expect(s.get().updatePassword('Old-Current-Password-1', 'Old-Current-Password-1')).rejects.toMatchObject({ code: 'same_password' });
    expect(server.calls).toEqual(['resuto-password-reverify:signInWithPassword', 'main:updateUser@aal1', 'resuto-password-reverify:signOut:local']);
    expect(server.live.has(main().session!.id)).toBe(true);
    await s.unmount();
  });

  it('secure password change, session over 24h, no authenticator: continues on the fresh sign-in', async () => {
    server.secureChange = true;
    const s = await mount(newSession('aal1', true));
    await act(async () => { await s.get().updatePassword('Quiet-Orchard-Lamp-7319', 'Old-Current-Password-1'); });
    expect(server.password).toBe('Quiet-Orchard-Lamp-7319');
    expect(server.calls).toEqual([
      'resuto-password-reverify:signInWithPassword', 'main:updateUser@aal1', 'main:setSession', 'main:updateUser@aal1',
    ]);
    expect(s.get().token).not.toBeNull();
    expect(s.get().mfaRequired).toBe(false);
    await s.unmount();
  });

  it('secure password change, session over 24h, with an authenticator: asks to sign in again, keeps the session', async () => {
    enrol();
    server.secureChange = true;
    const s = await mount(newSession('aal2', true));
    const before = s.get().token;
    await expect(s.get().updatePassword('Quiet-Orchard-Lamp-7319', 'Old-Current-Password-1')).rejects.toMatchObject({ code: 'password_change_sign_in_again' });
    expect(server.calls).toEqual(['resuto-password-reverify:signInWithPassword', 'main:updateUser@aal2', 'resuto-password-reverify:signOut:local']);
    expect(server.password).toBe('Old-Current-Password-1');
    expect(s.get().token).toBe(before);
    expect(s.get().mfaRequired).toBe(false);
    await s.unmount();
  });
});
