'use client';
import type { SupabaseClient } from '@supabase/supabase-js';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { MeResponse } from '@resuto/contracts';
import { api, ApiRequestError, type ApiOptions } from './api';
import { createAuthRunner } from './auth-recovery';
import { queryCache, scopeOfToken, tenantPrefix } from './query-cache';
import { claimUserStorage, clearUserStorage } from './user-storage';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
/** Supabase Auth when configured; otherwise the API's local development issuer. */
export const AUTH_MODE: 'supabase' | 'dev' = SUPABASE_URL && SUPABASE_ANON_KEY ? 'supabase' : 'dev';
/** "Continue with Google" is offered only when Supabase Auth has the Google provider enabled for this deployment. */
export const GOOGLE_AUTH = AUTH_MODE === 'supabase' && process.env.NEXT_PUBLIC_AUTH_GOOGLE === 'true';
const STORAGE_KEY = 'resuto_session';

// supabase-js (~50 KB gzip) is loaded only in Supabase mode and only by staff routes (SessionProvider is not in the
// root layout), so guest pages and dev-auth builds never download it.
let supabase: Promise<SupabaseClient> | null = null;
const sb = () => (supabase ??= import('@supabase/supabase-js').then(({ createClient }) =>
  createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, { auth: { persistSession: true } })));

interface StoredSession { accessToken: string; expiresAt: number; email: string }

export interface SessionValue {
  /** The stored token was read and /me answered (or failed). */
  ready: boolean;
  /** The stored token was read (before /me): authenticated reads may start. */
  tokenReady: boolean;
  token: string | null;
  /** Cache/storage partition for the signed-in user (token subject); null when signed out. */
  scope: string | null;
  me: MeResponse | null;
  /** /me failed for a reason other than an expired session (offline, server error). */
  meError: ApiRequestError | null;
  signIn(email: string, password: string): Promise<void>;
  signUp(email: string, password: string, fullName?: string): Promise<void>;
  signOut(): Promise<void>;
  /** Google sign-in through Supabase Auth (redirects away; only when GOOGLE_AUTH). Returns to /login?next=… */
  signInWithGoogle(next?: string | null): Promise<void>;
  refreshMe(): Promise<MeResponse | null>;
  call<T = any>(path: string, opts?: Omit<ApiOptions, 'token'>): Promise<T>;
}

const SessionContext = createContext<SessionValue | null>(null);

/**
 * After a successful mutation, refresh what it may have changed. Orders touch inventory, availability, customers,
 * finance, analytics and insights, so the whole tenant's queries are invalidated (mounted ones refetch; the rest
 * refetch when next shown). Non-tenant writes invalidate their top-level resource (e.g. `/admin`, `/me`).
 */
function invalidateAfterMutation(path: string) {
  const prefix = tenantPrefix(path) ?? `/${path.split(/[/?]/)[1] ?? ''}`;
  queryCache.invalidate((p) => p.startsWith(prefix));
}

function readStored(): StoredSession | null {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as StoredSession | null;
    return s && s.expiresAt > Date.now() + 30_000 ? s : null;
  } catch {
    return null;
  }
}
const writeStored = (s: StoredSession) => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* private mode */ } };
const keepSession = (k: string) => k === STORAGE_KEY || /^sb-[a-z0-9]+-auth-token/.test(k);
const AUTH_PAGES = /^\/(login|signup)(\/|$)/;

export const loginUrl = (next?: string | null, reason?: 'expired') => {
  const q = new URLSearchParams();
  if (next && next.startsWith('/') && !next.startsWith('//') && !AUTH_PAGES.test(next)) q.set('next', next);
  if (reason) q.set('reason', reason);
  const s = q.toString();
  return `/login${s ? `?${s}` : ''}`;
};

/**
 * Session for staff routes ((auth), dashboard, kitchen, driver, admin, onboarding, invite). `requireAuth` sends a
 * signed-out visitor to /login?next=<this page> instead of leaving a dead-end screen.
 */
export function SessionProvider({ children, requireAuth = false }: { children: ReactNode; requireAuth?: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const [token, setToken] = useState<string | null>(null);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [meError, setMeError] = useState<ApiRequestError | null>(null);
  const [ready, setReady] = useState(false);
  const [tokenReady, setTokenReady] = useState(false);
  // Always the latest token: callbacks created before sign-in (e.g. refreshMe called
  // right after signIn) must not read a stale null token from their closure.
  const tokenRef = useRef<string | null>(null);
  const expiring = useRef(false);
  const pathRef = useRef(pathname);
  pathRef.current = pathname;

  const applyToken = useCallback((t: string | null) => {
    const scope = scopeOfToken(t);
    // A different user on this browser: drop the previous user's cached reads and stored per-user state.
    if (scope && claimUserStorage(scope, keepSession)) queryCache.clear();
    tokenRef.current = t;
    setToken(t);
  }, []);

  /** Clears everything the signed-in user had in this tab. */
  const dropSession = useCallback(() => {
    clearUserStorage();
    queryCache.clear();
    tokenRef.current = null;
    setToken(null);
    setMe(null);
  }, []);

  /** The session can no longer be used: clear it and continue at the sign-in page, back here afterwards. */
  const expire = useCallback(() => {
    if (expiring.current) return;
    expiring.current = true;
    dropSession();
    if (AUTH_MODE === 'supabase') void sb().then((c) => c.auth.signOut({ scope: 'local' })).catch(() => undefined);
    const here = typeof window !== 'undefined' ? window.location.pathname + window.location.search : pathRef.current;
    if (!AUTH_PAGES.test(pathRef.current ?? '')) router.replace(loginUrl(here, 'expired'));
    setTimeout(() => { expiring.current = false; }, 1000);
  }, [dropSession, router]);

  /** Runs a request; on 401 refreshes the session once (shared) and retries, otherwise expires the session. */
  const withAuth = useMemo(() => createAuthRunner({
    getToken: () => tokenRef.current,
    refresh: async () => {
      if (AUTH_MODE !== 'supabase') return null; // the dev issuer has no refresh tokens
      const { data } = await (await sb()).auth.refreshSession();
      const t = data.session?.access_token ?? null;
      if (t) applyToken(t);
      return t;
    },
    expire,
  }), [applyToken, expire]);

  const loadMe = useCallback(async (t: string | null) => {
    if (!t) { setMe(null); setMeError(null); return null; }
    try {
      const m = await withAuth((tok) => api<MeResponse>('/me', { token: tok }));
      setMe(m);
      setMeError(null);
      return m;
    } catch (e) {
      setMe(null);
      setMeError(e instanceof ApiRequestError && e.status !== 401 ? e : null);
      return null;
    }
  }, [withAuth]);

  useEffect(() => {
    let off: (() => void) | undefined;
    (async () => {
      let t: string | null = null;
      if (AUTH_MODE === 'supabase') {
        const client = await sb();
        const { data } = await client.auth.getSession();
        t = data.session?.access_token ?? null;
        const sub = client.auth.onAuthStateChange((e, s) => {
          if (e === 'SIGNED_OUT' || !s) { clearUserStorage({ keep: keepSession }); queryCache.clear(); }
          applyToken(s?.access_token ?? null);
        });
        off = () => sub.data.subscription.unsubscribe();
      } else {
        t = readStored()?.accessToken ?? null;
      }
      applyToken(t);
      setTokenReady(true);
      await loadMe(t);
      setReady(true);
    })();
    return () => off?.();
  }, [loadMe, applyToken]);

  // Staff routes: a signed-out visitor goes to the sign-in page and comes back here afterwards.
  useEffect(() => {
    if (!requireAuth || !ready || token || AUTH_PAGES.test(pathname ?? '')) return;
    router.replace(loginUrl(window.location.pathname + window.location.search));
  }, [requireAuth, ready, token, pathname, router]);

  const call = useCallback(async <T,>(path: string, opts?: Omit<ApiOptions, 'token'>): Promise<T> => {
    const result = await withAuth((t) => api<T>(path, { ...opts, token: t }));
    const method = opts?.method ?? (opts?.body !== undefined ? 'POST' : 'GET');
    if (method !== 'GET') invalidateAfterMutation(path);
    return result;
  }, [withAuth]);

  const signIn = useCallback(async (email: string, password: string) => {
    let t: string;
    if (AUTH_MODE === 'supabase') {
      const { data, error } = await (await sb()).auth.signInWithPassword({ email, password });
      if (error || !data.session) throw new Error(error?.message ?? 'Sign-in failed');
      t = data.session.access_token;
    } else {
      const r = await api<{ accessToken: string; expiresIn: number }>('/auth/dev/login', { body: { email, password } });
      writeStored({ accessToken: r.accessToken, expiresAt: Date.now() + r.expiresIn * 1000, email });
      t = r.accessToken;
    }
    applyToken(t);
    await loadMe(t);
  }, [applyToken, loadMe]);

  const signUp = useCallback(async (email: string, password: string, fullName?: string) => {
    if (AUTH_MODE === 'supabase') {
      const { data, error } = await (await sb()).auth.signUp({ email, password, options: { data: { full_name: fullName } } });
      if (error) throw new Error(error.message);
      if (!data.session) throw new Error('Check your email to confirm your account, then sign in.');
      applyToken(data.session.access_token);
      await loadMe(data.session.access_token);
      return;
    }
    const r = await api<{ accessToken: string; expiresIn: number }>('/auth/dev/signup', { body: { email, password, fullName } });
    writeStored({ accessToken: r.accessToken, expiresAt: Date.now() + r.expiresIn * 1000, email });
    applyToken(r.accessToken);
    await loadMe(r.accessToken);
  }, [applyToken, loadMe]);

  const signOut = useCallback(async () => {
    if (AUTH_MODE === 'supabase') { try { await (await sb()).auth.signOut(); } catch { /* local clear below */ } }
    dropSession();
  }, [dropSession]);

  const signInWithGoogle = useCallback(async (next?: string | null) => {
    if (!GOOGLE_AUTH) throw new Error('Google sign-in is not enabled.');
    const back = new URL('/login', window.location.origin);
    if (next && next.startsWith('/') && !next.startsWith('//')) back.searchParams.set('next', next);
    const { error } = await (await sb()).auth.signInWithOAuth({ provider: 'google', options: { redirectTo: back.toString() } });
    if (error) throw new Error(error.message);
  }, []);

  const refreshMe = useCallback(() => loadMe(tokenRef.current), [loadMe]);

  const value = useMemo<SessionValue>(() => ({
    ready, tokenReady, token, scope: scopeOfToken(token), me, meError, signIn, signUp, signOut, signInWithGoogle, refreshMe, call,
  }), [ready, tokenReady, token, me, meError, signIn, signUp, signOut, signInWithGoogle, refreshMe, call]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const v = useContext(SessionContext);
  if (!v) throw new Error('useSession must be used inside SessionProvider');
  return v;
}
