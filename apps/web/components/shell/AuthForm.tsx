'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { MeResponse } from '@resuto/contracts';
import { Field, Notice, Wordmark } from '@resuto/ui';
import { LanguageToggle, useT } from '@/lib/i18n/client';
import { authErrorText } from '@/lib/auth-errors';
import { MAX_PASSWORD, MIN_PASSWORD } from '@/lib/auth/password-policy';
import { homePath } from '@/lib/home-path';
import { safeNext } from '@/lib/safe-next';
import { AUTH_MODE, GOOGLE_AUTH, useSession } from '@/lib/session';
import { MfaStep } from '@/app/(auth)/_ui/MfaStep';

const WORKSPACES = ['manager', 'kitchen', 'host'] as const;
type Workspace = (typeof WORKSPACES)[number];

/** Where a signed-in user goes: `next` when given, otherwise their role's home in their first restaurant (VS-05). */
export function destinationFor(me: MeResponse | null, next: string | null): string {
  const safe = safeNext(next);
  if (safe) return safe;
  const m = me?.memberships[0];
  return m ? homePath(m.role, m.orgId) : '/onboarding';
}

/**
 * Staff sign-in and sign-up, restored to the legacy split layout (legacy/public/app.js renderLogin): a green brand
 * panel ("A calmer kind of service. Every table. Every order. All together.") and the form column with the
 * workspace eyebrow, "Welcome back.", email and password, Google when configured, the account note and links to the
 * other workspaces. After sign-in each role lands on its own screen (kitchen → KDS, front desk → floor, …).
 */
export function AuthForm({ mode }: { mode: 'login' | 'signup' }) {
  const { t, tn } = useT();
  const session = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [confirmFor, setConfirmFor] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const routed = useRef(false);
  const next = params.get('next');
  const workspace: Workspace | 'staff' = (WORKSPACES as readonly string[]).includes(params.get('role') ?? '') ? params.get('role') as Workspace : 'staff';

  // Already signed in (or back from Google): continue to the right screen instead of showing the form again.
  useEffect(() => {
    if (routed.current || pending || !session.ready || !session.token || !session.me) return;
    routed.current = true;
    router.replace(destinationFor(session.me, next));
  }, [session.ready, session.token, session.me, pending, next, router]);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    const f = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    try {
      if (mode === 'signup') {
        const r = await session.signUp(String(f.get('email')), String(f.get('password')), String(f.get('fullName') || ''));
        if (r.confirmationRequired) { setConfirmFor(String(f.get('email'))); setPending(false); return; }
      } else {
        const r = await session.signIn(String(f.get('email')), String(f.get('password')));
        // AUTH-02: an authenticator is enrolled: the code step replaces the form (session.mfaRequired), then the
        // effect above continues to the destination once the session is aal2.
        if (r.mfaRequired) { setPending(false); return; }
      }
      const me = await session.refreshMe();
      routed.current = true;
      router.push(destinationFor(me, next));
    } catch (err) {
      setError(authErrorText(err, t));
      setPending(false);
    }
  }

  async function google() {
    setError(null);
    try { await session.signInWithGoogle(safeNext(next)); } catch (err) { setError(authErrorText(err, t)); }
  }

  const otherWorkspaces = WORKSPACES.filter((w) => w !== workspace);
  return (
    <div className="login">
      <section className="login-brand" aria-label={t('auth.brand.foot')}>
        <Link href="/" className="ws-brand" aria-label={t('app.name')}><Wordmark tone="light" label={t('app.name')} /></Link>
        <div>
          <div className="eyebrow">{t('auth.brand.eyebrow')}</div>
          <h1>{t('auth.brand.line1')}<br />{t('auth.brand.line2')}<br />{t('auth.brand.line3')}</h1>
          <p>{t('auth.brand.body')}</p>
        </div>
        <small>{t('auth.brand.foot')}</small>
      </section>
      <main className="login-main">
        {session.mfaRequired ? <MfaStep onSignedOut={() => setError(null)} /> : (
        <form className="login-form" onSubmit={submit} aria-busy={pending || undefined}>
          <div className="eyebrow">{t(`auth.workspace.${workspace}`)}</div>
          <h1>{mode === 'signup' ? t('auth.signupTitle') : t('auth.welcome')}</h1>
          <p>{mode === 'signup' ? t('auth.signupBody') : t('auth.welcomeBody')}</p>
          {params.get('reason') === 'expired' && mode === 'login' && <Notice tone="warn">{t('auth.expired')}</Notice>}
          {mode === 'signup' && <Field label={t('auth.fullName')} name="fullName" autoComplete="name" />}
          <Field label={t('auth.email')} name="email" type="email" required autoComplete="email" dir="ltr" />
          <Field label={t('auth.password')} name="password" type="password" required minLength={MIN_PASSWORD}
            maxLength={mode === 'signup' ? MAX_PASSWORD : undefined} hint={mode === 'signup' ? t('auth.passwordHint') : undefined}
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} dir="ltr" />
          {error && <Notice tone="danger">{error}</Notice>}
          {confirmFor && <Notice tone="ok">{tn('auth.confirmSent', { email: <bdi dir="ltr">{confirmFor}</bdi> })}</Notice>}
          <button className="btn btn-primary btn-block" disabled={pending} aria-busy={pending || undefined}>
            {pending ? t('state.loading') : mode === 'signup' ? t('auth.submitSignup') : t('auth.submit')}
          </button>
          {GOOGLE_AUTH && <button type="button" className="btn btn-block" onClick={google} disabled={pending}>{t('auth.google')}</button>}
          <p className="login-note">{t('auth.accountNote')}</p>
          <div className="login-links">
            {mode === 'signup'
              ? <span>{t('auth.haveAccount')} <Link href={`/login${next ? `?next=${encodeURIComponent(next)}` : ''}`}>{t('auth.signIn')}</Link></span>
              : <><Link href="/forgot-password">{t('auth.forgot')}</Link><Link href="/signup">{t('auth.createAccount')}</Link></>}
          </div>
          {mode === 'login' && (
            <nav className="login-roles" aria-label={t('auth.brand.foot')}>
              {otherWorkspaces.map((w) => <Link key={w} href={`/login?role=${w}${next ? `&next=${encodeURIComponent(next)}` : ''}`}>{t(`auth.workspace.${w}`)} ↗</Link>)}
            </nav>
          )}
          {AUTH_MODE === 'dev' && (
            <p className="login-dev"><span className="badge badge-sandbox">DEV</span>
              <span>{tn('auth.devMode', { provider: <bdi dir="ltr">Supabase Auth</bdi> })}</span></p>
          )}
        </form>
        )}
      </main>
      <LanguageToggle className="ws-lang" label={t('lang.short')} />
    </div>
  );
}
