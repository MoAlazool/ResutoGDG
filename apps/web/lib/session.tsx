'use client';
import type { SupabaseClient } from '@supabase/supabase-js';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { MeResponse } from '@resuto/contracts';
import { api, ApiRequestError, type ApiOptions } from './api';
import { AuthFlowError } from './auth-errors';
import { checkNewPassword } from './auth/password-policy';
import {
  assuranceOf, cancelTotpEnrolment, jwtClaims, listTotp, removeTotp, startTotpEnrolment, verifySignInCode, verifyTotp,
  type MfaClient, type MfaSession, type TotpEnrolment, type TotpFactors,
} from './auth/mfa';
import { createAuthRunner } from './auth-recovery';
import { queryCache, scopeOfToken, tenantPrefix } from './query-cache';
import { googleReturnUrl, loginUrl } from './safe-next';
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
/**
 * CR-05: a password may be set without the current one only right after a recovery link (Supabase reports
 * PASSWORD_RECOVERY), within 15 minutes, in this tab. Any other signed-in session must re-enter the current password.
 */
const RECOVERY_KEY = 'resuto.auth.recovery';
const RECOVERY_TTL_MS = 15 * 60_000;
export function markRecovery() { try { sessionStorage.setItem(RECOVERY_KEY, String(Date.now())); } catch { /* storage blocked: no recovery */ } }
export function clearRecovery() { try { sessionStorage.removeItem(RECOVERY_KEY); } catch { /* ignore */ } }
export function recoveryPending(now = Date.now()): boolean {
  try {
    const at = Number(sessionStorage.getItem(RECOVERY_KEY));
    return Number.isFinite(at) && at > 0 && now - at < RECOVERY_TTL_MS;
  } catch { return false; }
}

const sb = () => (supabase ??= import('@supabase/supabase-js').then(({ createClient }) =>
  createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, { auth: { persistSession: true } })));

interface StoredSession { accessToken: string; expiresAt: number; email: string }

/**
 * AUTH-02: TOTP two-step verification (Supabase Auth MFA). Only in Supabase mode; the local dev issuer has no MFA.
 * Enrolment and removal live on Account > Security; the code step after sign-in is `verifyMfa`.
 */
export interface MfaControls {
  available: boolean;
  list(): Promise<TotpFactors>;
  /** Starts adding an authenticator app: QR code and secret to scan or type. */
  start(): Promise<TotpEnrolment>;
  /** Verifies the first code of a new authenticator; the session becomes aal2. */
  confirm(factorId: string, code: string): Promise<void>;
  /** Abandons an enrolment that was never verified. */
  cancel(factorId: string): Promise<void>;
  /** Removes a verified authenticator after re-verifying a fresh code from it. */
  remove(factorId: string, code: string): Promise<void>;
}

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
  /** Resolves `mfaRequired` when the account has a verified authenticator: the code step (`verifyMfa`) comes next. */
  signIn(email: string, password: string): Promise<{ mfaRequired: boolean }>;
  /** Resolves `confirmationRequired` when Supabase sent a confirmation email instead of starting a session (CR-05). */
  signUp(email: string, password: string, fullName?: string): Promise<{ confirmationRequired: boolean }>;
  /** CR-05: sends a reset link (Supabase Auth) that returns through /auth/callback to /reset-password. */
  requestPasswordReset(email: string): Promise<void>;
  /** CR-05: sets a new password. `currentPassword` is required to change it while signed in (re-verified first). */
  updatePassword(newPassword: string, currentPassword?: string): Promise<void>;
  /** CR-05: asks Supabase Auth to change the email (confirmed through a link to the new address). */
  updateEmail(email: string): Promise<void>;
  /** CR-05: finishes an email link (confirmation, recovery, email change, OAuth code) on /auth/callback. */
  completeAuthLink(url: string): Promise<{ mfaRequired: boolean }>;
  /**
   * AUTH-02: a password (or email link) session of an account with a verified authenticator, or one the API answered
   * with 403 mfa_required: the app is not entered (token stays null) until `verifyMfa` succeeds.
   */
  mfaRequired: boolean;
  verifyMfa(code: string): Promise<void>;
  mfa: MfaControls;
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
const AUTH_PAGES = /^\/(login|signup|forgot-password|reset-password|auth\/callback)(\/|$)/;
/**
 * AUTH-02: the API answered 403 mfa_required for this user (e.g. a factor was added on another device and this
 * session's user object is stale). Kept per tab so another SessionProvider instance (the sign-in page's) honours it.
 */
const MFA_DEMANDED_KEY = 'resuto.auth.mfa-demanded';
const mfaDemandedFor = (sub: unknown) => { try { return !!sub && sessionStorage.getItem(MFA_DEMANDED_KEY) === sub; } catch { return false; } };
const setMfaDemanded = (sub: string | null) => {
  try { if (sub) sessionStorage.setItem(MFA_DEMANDED_KEY, sub); else sessionStorage.removeItem(MFA_DEMANDED_KEY); } catch { /* storage blocked */ }
};

/** Where email links come back to (CR-05): the callback page finishes the session, then continues to `next`. */
const callbackUrl = (next: string) => `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`;

/**
 * AUTH-01: every new password (sign-up, reset, change) passes Resuto's compensating checks first: length, very common
 * passwords, the account's email and the product name, and the Pwned Passwords k-anonymity lookup (an unreachable
 * lookup does not block). Client-side only; see lib/auth/password-policy.ts and docs/SECURITY_AUTH.md.
 */
async function assertPasswordAllowed(password: string, email: string | null | undefined) {
  const verdict = await checkNewPassword(password, { email });
  if (verdict.issue) throw new AuthFlowError(verdict.issue);
}

export { loginUrl } from './safe-next';

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
  const [mfaRequired, setMfaRequired] = useState(false);
  // Always the latest token: callbacks created before sign-in (e.g. refreshMe called
  // right after signIn) must not read a stale null token from their closure.
  const tokenRef = useRef<string | null>(null);
  const expiring = useRef(false);
  const pathRef = useRef(pathname);
  pathRef.current = pathname;
  const meRef = useRef<MeResponse | null>(null);
  meRef.current = me;

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
    setMfaDemanded(null);
    setMfaRequired(false);
    tokenRef.current = null;
    setToken(null);
    setMe(null);
  }, []);

  /**
   * AUTH-02: a Supabase session becomes the app's token only at the assurance level it needs. An aal1 session of a
   * user with a verified factor (or one the API demanded aal2 from) is held back: token null, `mfaRequired` true,
   * nothing of the app loads until the code is verified. Returns whether the code step is owed.
   */
  const admit = useCallback((s: MfaSession | null | undefined): boolean => {
    const a = assuranceOf(s);
    const sub = s ? jwtClaims(s.access_token).sub : null;
    if (!s || a.current === 'aal2') setMfaDemanded(null);
    const owed = !!s && (a.required || (a.current !== 'aal2' && mfaDemandedFor(sub)));
    setMfaRequired(owed);
    if (owed) setMe(null);
    applyToken(owed ? null : s?.access_token ?? null);
    return owed;
  }, [applyToken]);

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
        // Subscribe before reading the session: a recovery link is processed while the client initialises.
        const sub = client.auth.onAuthStateChange((e, s) => {
          if (e === 'PASSWORD_RECOVERY') markRecovery();
          if (e === 'SIGNED_OUT' || !s) { clearRecovery(); clearUserStorage({ keep: keepSession }); queryCache.clear(); }
          admit(s);
        });
        off = () => sub.data.subscription.unsubscribe();
        const { data } = await client.auth.getSession();
        t = admit(data.session) ? null : data.session?.access_token ?? null;
      } else {
        t = readStored()?.accessToken ?? null;
      }
      applyToken(t);
      setTokenReady(true);
      await loadMe(t);
      setReady(true);
    })();
    return () => off?.();
  }, [loadMe, applyToken, admit]);

  // Staff routes: a signed-out visitor goes to the sign-in page and comes back here afterwards.
  useEffect(() => {
    if (!requireAuth || !ready || token || AUTH_PAGES.test(pathname ?? '')) return;
    router.replace(loginUrl(window.location.pathname + window.location.search));
  }, [requireAuth, ready, token, pathname, router]);

  // DF-13: `call` keeps ONE identity for the provider's lifetime. It reads the current token (tokenRef, inside
  // withAuth) and the current auth runner through refs, so a token change (a Supabase TOKEN_REFRESHED, a new sign-in)
  // never changes it: pollers (useApi, the KDS board) that depend on it are not torn down, restarted or blanked; the
  // next scheduled request simply carries the new token. Regression test: lib/session-stability.test.ts.
  const withAuthRef = useRef(withAuth);
  withAuthRef.current = withAuth;
  const demandMfa = useCallback(async () => {
    // AUTH-02: the API wants aal2 from this user. Remember it for this tab, refresh the session (its user object may not
    // list a factor added elsewhere) and hold the token back: requireAuth pages then go to the sign-in code step.
    setMfaDemanded(String(jwtClaims(tokenRef.current).sub ?? ''));
    setMfaRequired(true);
    applyToken(null);
    setMe(null);
    try { await (await sb()).auth.refreshSession(); } catch { /* the code step still runs */ }
  }, [applyToken]);
  const demandMfaRef = useRef(demandMfa);
  demandMfaRef.current = demandMfa;
  const call = useCallback(async <T,>(path: string, opts?: Omit<ApiOptions, 'token'>): Promise<T> => {
    const result = await withAuthRef.current((t) => api<T>(path, { ...opts, token: t })).catch(async (e: unknown) => {
      if (AUTH_MODE === 'supabase' && e instanceof ApiRequestError && e.code === 'mfa_required') await demandMfaRef.current();
      throw e;
    });
    const method = opts?.method ?? (opts?.body !== undefined ? 'POST' : 'GET');
    if (method !== 'GET') invalidateAfterMutation(path);
    return result;
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    let t: string;
    if (AUTH_MODE === 'supabase') {
      const { data, error } = await (await sb()).auth.signInWithPassword({ email, password });
      if (error) throw error;
      if (!data.session) throw new AuthFlowError('invalid_credentials');
      if (admit(data.session)) return { mfaRequired: true };
      t = data.session.access_token;
    } else {
      const r = await api<{ accessToken: string; expiresIn: number }>('/auth/dev/login', { body: { email, password } });
      writeStored({ accessToken: r.accessToken, expiresAt: Date.now() + r.expiresIn * 1000, email });
      t = r.accessToken;
    }
    applyToken(t);
    await loadMe(t);
    return { mfaRequired: false };
  }, [applyToken, loadMe, admit]);

  const verifyMfa = useCallback(async (code: string) => {
    if (AUTH_MODE !== 'supabase') throw new AuthFlowError('mfa_unavailable');
    const client = await sb();
    await verifySignInCode(client as unknown as MfaClient, code);
    const { data } = await client.auth.getSession();
    if (!data.session || admit(data.session)) throw new AuthFlowError('mfa_code_invalid');
    await loadMe(data.session.access_token);
  }, [admit, loadMe]);

  const mfa = useMemo<MfaControls>(() => {
    const client = async () => {
      if (AUTH_MODE !== 'supabase') throw new AuthFlowError('mfa_unavailable');
      return (await sb()) as unknown as MfaClient;
    };
    const friendlyName = () => `Authenticator ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
    return {
      available: AUTH_MODE === 'supabase',
      list: async () => listTotp(await client()),
      start: async () => startTotpEnrolment(await client(), { friendlyName: friendlyName(), issuer: 'Resuto' }),
      confirm: async (factorId, code) => {
        await verifyTotp(await client(), factorId, code);
        const { data } = await (await sb()).auth.getSession();
        admit(data.session);
      },
      cancel: async (factorId) => cancelTotpEnrolment(await client(), factorId),
      remove: async (factorId, code) => {
        await removeTotp(await client(), factorId, code);
        const { data } = await (await sb()).auth.getSession();
        admit(data.session);
      },
    };
  }, [admit]);

  const signUp = useCallback(async (email: string, password: string, fullName?: string) => {
    await assertPasswordAllowed(password, email);
    if (AUTH_MODE === 'supabase') {
      const { data, error } = await (await sb()).auth.signUp({ email, password, options: { data: { full_name: fullName }, emailRedirectTo: callbackUrl('/onboarding') } });
      if (error) throw error;
      // Email confirmation is on: no session until the link is opened (returns through /auth/callback).
      if (!data.session) return { confirmationRequired: true };
      applyToken(data.session.access_token);
      await loadMe(data.session.access_token);
      return { confirmationRequired: false };
    }
    const r = await api<{ accessToken: string; expiresIn: number }>('/auth/dev/signup', { body: { email, password, fullName } });
    writeStored({ accessToken: r.accessToken, expiresAt: Date.now() + r.expiresIn * 1000, email });
    applyToken(r.accessToken);
    await loadMe(r.accessToken);
    return { confirmationRequired: false };
  }, [applyToken, loadMe]);

  const requestPasswordReset = useCallback(async (email: string) => {
    // The dev issuer has no email service: say so instead of pretending a link was sent.
    if (AUTH_MODE !== 'supabase') throw new AuthFlowError('reset_unavailable');
    const { error } = await (await sb()).auth.resetPasswordForEmail(email.trim().toLowerCase(), { redirectTo: callbackUrl('/reset-password') });
    if (error) throw error;
  }, []);

  const updatePassword = useCallback(async (newPassword: string, currentPassword?: string) => {
    if (!tokenRef.current) throw new AuthFlowError('not_signed_in');
    await assertPasswordAllowed(newPassword, meRef.current?.user.email);
    if (AUTH_MODE !== 'supabase') {
      await withAuth((t) => api('/auth/dev/password', { token: t, body: { currentPassword: currentPassword ?? '', newPassword } }));
      return;
    }
    const client = await sb();
    // Without the current password only a fresh recovery link may set a new one (see recoveryPending).
    if (currentPassword === undefined && !recoveryPending()) throw new AuthFlowError('current_password_required');
    if (currentPassword !== undefined) {
      const { data: u } = await client.auth.getUser();
      const email = u.user?.email;
      if (!email) throw new AuthFlowError('not_signed_in');
      const { error: verify } = await client.auth.signInWithPassword({ email, password: currentPassword });
      if (verify) throw (verify as { code?: string }).code === 'invalid_credentials' ? new AuthFlowError('current_password_incorrect') : verify;
    }
    const { error } = await client.auth.updateUser({ password: newPassword });
    if (error) throw error;
    clearRecovery();
  }, [withAuth]);

  const updateEmail = useCallback(async (email: string) => {
    if (AUTH_MODE !== 'supabase') throw new AuthFlowError('email_change_unavailable');
    const { error } = await (await sb()).auth.updateUser({ email: email.trim().toLowerCase() }, { emailRedirectTo: callbackUrl('/account/security') });
    if (error) throw error;
  }, []);

  const completeAuthLink = useCallback(async (href: string) => {
    if (AUTH_MODE !== 'supabase') throw new AuthFlowError('link_invalid');
    const url = new URL(href);
    const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
    if (url.searchParams.get('error') || hash.get('error')) throw new AuthFlowError('link_invalid', url.searchParams.get('error_description') ?? hash.get('error_description') ?? undefined);
    const client = await sb();
    const code = url.searchParams.get('code');
    // PKCE links carry ?code=; implicit links (#access_token=…) were already read by the client when it initialised.
    if (code) {
      const { data: ex, error } = await client.auth.exchangeCodeForSession(code);
      if (error) throw error;
      // PKCE recovery links say so in the exchange (the code verifier was stored by resetPasswordForEmail).
      if ((ex as { redirectType?: string | null } | null)?.redirectType === 'PASSWORD_RECOVERY') markRecovery();
    }
    const { data } = await client.auth.getSession();
    if (!data.session) throw new AuthFlowError('link_invalid');
    // AUTH-02: a link signs in at aal1; an account with an authenticator still owes its code.
    if (admit(data.session)) return { mfaRequired: true };
    await loadMe(data.session.access_token);
    return { mfaRequired: false };
  }, [admit, loadMe]);

  const signOut = useCallback(async () => {
    if (AUTH_MODE === 'supabase') { try { await (await sb()).auth.signOut(); } catch { /* local clear below */ } }
    dropSession();
  }, [dropSession]);

  const signInWithGoogle = useCallback(async (next?: string | null) => {
    if (!GOOGLE_AUTH) throw new AuthFlowError('google_disabled');
    const back = googleReturnUrl(window.location.origin, next);
    const { error } = await (await sb()).auth.signInWithOAuth({ provider: 'google', options: { redirectTo: back } });
    if (error) throw new Error(error.message);
  }, []);

  const refreshMe = useCallback(() => loadMe(tokenRef.current), [loadMe]);

  const value = useMemo<SessionValue>(() => ({
    ready, tokenReady, token, scope: scopeOfToken(token), me, meError, signIn, signUp, signOut, signInWithGoogle, refreshMe, call,
    requestPasswordReset, updatePassword, updateEmail, completeAuthLink, mfaRequired, verifyMfa, mfa,
  }), [ready, tokenReady, token, me, meError, signIn, signUp, signOut, signInWithGoogle, refreshMe, call, requestPasswordReset, updatePassword,
    updateEmail, completeAuthLink, mfaRequired, verifyMfa, mfa]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const v = useContext(SessionContext);
  if (!v) throw new Error('useSession must be used inside SessionProvider');
  return v;
}
