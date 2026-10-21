'use client';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { Field, Notice } from '@resuto/ui';
import { authErrorText } from '@/lib/auth-errors';
import { useT } from '@/lib/i18n/client';
import { useSession } from '@/lib/session';
import { AuthPanel } from '../_ui/AuthPanel';
import { EmailDeliveryNote, ResendEmail } from '../_ui/ResendEmail';

/**
 * CR-05: request a password reset link (Supabase Auth). Never says whether the account exists: the same answer for
 * every address (AUTH-03), with a rate-limited "send again" and the honest delivery note when there is no SMTP sender.
 */
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
      {sentTo ? (
        <div className="stack" style={{ gap: 12 }} data-testid="reset-sent">
          <Notice tone="ok">{tn('auth.forgotSent', { email: <bdi dir="ltr">{sentTo}</bdi> })}</Notice>
          <EmailDeliveryNote />
          <ResendEmail onResend={() => session.requestPasswordReset(sentTo)} />
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSentTo(null)}>{t('auth.checkEmail.other')}</button>
        </div>
      ) : (
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
