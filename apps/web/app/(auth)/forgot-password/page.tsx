'use client';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { Field, Notice } from '@resuto/ui';
import { authErrorText } from '@/lib/auth-errors';
import { useT } from '@/lib/i18n/client';
import { useSession } from '@/lib/session';
import { AuthPanel } from '../_ui/AuthPanel';

/** CR-05: request a password reset link (Supabase Auth). Never says whether the account exists. */
export default function ForgotPasswordPage() {
  const { t, tn } = useT();
  const session = useSession();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    const email = String(new FormData(e.currentTarget).get('email') ?? '').trim();
    setPending(true); setError(null);
    try {
      await session.requestPasswordReset(email);
      setSentTo(email);
    } catch (err) {
      setError(authErrorText(err, t));
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthPanel eyebrow={t('auth.workspace.staff')} title={t('auth.forgotTitle')} body={t('auth.forgotBody')}>
      {sentTo ? <Notice tone="ok">{tn('auth.forgotSent', { email: <bdi dir="ltr">{sentTo}</bdi> })}</Notice> : (
        <form onSubmit={submit} aria-busy={pending || undefined} className="stack" style={{ gap: 12 }}>
          <Field label={t('auth.email')} name="email" type="email" required autoComplete="email" dir="ltr" />
          {error && <Notice tone="danger">{error}</Notice>}
          <button className="btn btn-primary btn-block" disabled={pending}>{pending ? t('state.loading') : t('auth.forgotSubmit')}</button>
        </form>
      )}
      <div className="login-links"><Link href="/login">{t('auth.backToSignIn')}</Link></div>
    </AuthPanel>
  );
}
