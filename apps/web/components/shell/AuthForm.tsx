'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Field, Notice } from '@resuto/ui';
import { LanguageToggle, useT } from '@/lib/i18n/client';
import { AUTH_MODE, useSession } from '@/lib/session';

export function AuthForm({ mode }: { mode: 'login' | 'signup' }) {
  const { t } = useT();
  const session = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    try {
      if (mode === 'signup') await session.signUp(String(f.get('email')), String(f.get('password')), String(f.get('fullName') || ''));
      else await session.signIn(String(f.get('email')), String(f.get('password')));
      const me = await session.refreshMe();
      const next = params.get('next');
      if (next?.startsWith('/')) router.push(next);
      else if (me?.memberships.length) {
        const m = me.memberships[0]!;
        router.push(m.role === 'driver' ? '/driver' : m.role === 'kitchen' ? `/kitchen/${m.orgId}` : `/dashboard/${m.orgId}`);
      } else router.push('/onboarding');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="center-page">
      <div className="auth-card rise">
        <div className="spread">
          <Link href="/" className="brand-row"><img src="/brand/resuto-icon.png" alt="" /> {t('app.name')}</Link>
          <LanguageToggle />
        </div>
        <h1 style={{ fontSize: 26 }}>{mode === 'signup' ? t('auth.signUp') : t('auth.signIn')}</h1>
        <form onSubmit={submit} noValidate={false}>
          {mode === 'signup' && <Field label={t('auth.fullName')} name="fullName" autoComplete="name" />}
          <Field label={t('auth.email')} name="email" type="email" required autoComplete="email" />
          <Field label={t('auth.password')} name="password" type="password" required minLength={10} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} />
          {error && <Notice tone="danger">{error}</Notice>}
          <button className="btn btn-primary btn-block" disabled={pending} style={{ marginBlockStart: 12 }}>
            {pending ? t('state.loading') : mode === 'signup' ? t('auth.signUp') : t('auth.signIn')}
          </button>
        </form>
        <p className="fine" style={{ marginBlockStart: 18 }}>
          {mode === 'signup' ? t('auth.haveAccount') : t('auth.noAccount')}{' '}
          <Link href={mode === 'signup' ? '/login' : '/signup'}>{mode === 'signup' ? t('auth.signIn') : t('auth.signUp')}</Link>
        </p>
        {AUTH_MODE === 'dev' && <p className="fine"><span className="badge badge-sandbox">DEV</span> {t('auth.devMode')}</p>}
      </div>
    </main>
  );
}
