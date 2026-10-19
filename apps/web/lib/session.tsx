'use client';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { MeResponse } from '@resuto/contracts';
import { api, type ApiOptions } from './api';
import { queryCache, tenantPrefix } from './query-cache';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
/** Supabase Auth when configured; otherwise the API's local development issuer. */
export const AUTH_MODE: 'supabase' | 'dev' = SUPABASE_URL && SUPABASE_ANON_KEY ? 'supabase' : 'dev';
const STORAGE_KEY = 'resuto_session';

let supabase: SupabaseClient | null = null;
const sb = () => (supabase ??= createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, { auth: { persistSession: true } }));

interface StoredSession { accessToken: string; expiresAt: number; email: string }

interface SessionValue {
  ready: boolean;
  token: string | null;
  me: MeResponse | null;
  signIn(email: string, password: string): Promise<void>;
  signUp(email: string, password: string, fullName?: string): Promise<void>;
  signOut(): Promise<void>;
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

export function SessionProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [ready, setReady] = useState(false);
  // Always the latest token: callbacks created before sign-in (e.g. refreshMe called
  // right after signIn) must not read a stale null token from their closure.
  const tokenRef = useRef<string | null>(null);
  const applyToken = useCallback((t: string | null) => { tokenRef.current = t; setToken(t); }, []);

  const loadMe = useCallback(async (t: string | null) => {
    if (!t) { setMe(null); return null; }
    try {
      const m = await api<MeResponse>('/me', { token: t });
      setMe(m);
      return m;
    } catch {
      setMe(null);
      return null;
    }
  }, []);

  useEffect(() => {
    (async () => {
      let t: string | null = null;
      if (AUTH_MODE === 'supabase') {
        const { data } = await sb().auth.getSession();
        t = data.session?.access_token ?? null;
        sb().auth.onAuthStateChange((e, s) => {
          if (e === 'SIGNED_OUT' || !s) queryCache.clear();
          applyToken(s?.access_token ?? null);
        });
      } else {
        t = readStored()?.accessToken ?? null;
      }
      applyToken(t);
      await loadMe(t);
      setReady(true);
    })();
  }, [loadMe]);

  const value = useMemo<SessionValue>(() => ({
    ready, token, me,
    async signIn(email, password) {
      let t: string;
      if (AUTH_MODE === 'supabase') {
        const { data, error } = await sb().auth.signInWithPassword({ email, password });
        if (error || !data.session) throw new Error(error?.message ?? 'Sign-in failed');
        t = data.session.access_token;
      } else {
        const r = await api<{ accessToken: string; expiresIn: number }>('/auth/dev/login', { body: { email, password } });
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ accessToken: r.accessToken, expiresAt: Date.now() + r.expiresIn * 1000, email }));
        t = r.accessToken;
      }
      applyToken(t);
      await loadMe(t);
    },
    async signUp(email, password, fullName) {
      if (AUTH_MODE === 'supabase') {
        const { data, error } = await sb().auth.signUp({ email, password, options: { data: { full_name: fullName } } });
        if (error) throw new Error(error.message);
        if (!data.session) throw new Error('Check your email to confirm your account, then sign in.');
        applyToken(data.session.access_token);
        await loadMe(data.session.access_token);
        return;
      }
      const r = await api<{ accessToken: string; expiresIn: number }>('/auth/dev/signup', { body: { email, password, fullName } });
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ accessToken: r.accessToken, expiresAt: Date.now() + r.expiresIn * 1000, email }));
      applyToken(r.accessToken);
      await loadMe(r.accessToken);
    },
    async signOut() {
      if (AUTH_MODE === 'supabase') await sb().auth.signOut();
      localStorage.removeItem(STORAGE_KEY);
      queryCache.clear();
      applyToken(null);
      setMe(null);
    },
    refreshMe: () => loadMe(tokenRef.current),
    call: async (path, opts) => {
      const result = await api(path, { ...opts, token: tokenRef.current });
      const method = opts?.method ?? (opts?.body !== undefined ? 'POST' : 'GET');
      if (method !== 'GET') invalidateAfterMutation(path);
      return result;
    },
  }), [ready, token, me, loadMe, applyToken]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const v = useContext(SessionContext);
  if (!v) throw new Error('useSession must be used inside SessionProvider');
  return v;
}
