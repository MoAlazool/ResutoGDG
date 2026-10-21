'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Field, Notice, Skeleton } from '@resuto/ui';
import { destinationFor } from '@/components/shell/AuthForm';
import { authErrorText } from '@/lib/auth-errors';
import { useT } from '@/lib/i18n/client';
import { AUTH_MODE, recoveryPending, useSession } from '@/lib/session';
import { AuthPanel, MIN_PASSWORD } from '../_ui/AuthPanel';

/** CR-05: set a new password after opening a recovery link (the link signed the user in through /auth/callback). */
export default function ResetPasswordPage() {
  const { t } = useT();
  const session = useSession();
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    const f = new FormData(e.currentTarget);
    const pw = String(f.get('password') ?? ''), again = String(f.get('confirm') ?? '');
    if (pw !== again) { setError(t('auth.mismatch')); return; }
    setPending(true); setError(null);
    try {
      await session.updatePassword(pw);
      setDone(true);
    } catch (err) {
      setError(authErrorText(err, t));
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthPanel eyebrow={t('auth.account.security')} title={t('auth.resetTitle')} body={t('auth.resetBody')}>
      {!session.ready ? <Skeleton lines={3} /> : !session.token ? (
        <>
          <Notice tone="warn">{t('auth.resetNoSession')}</Notice>
          <div className="login-links"><Link href="/forgot-password">{t('auth.forgotSubmit')}</Link></div>
        </>
      ) : !done && AUTH_MODE === 'supabase' && !recoveryPending() ? (
        // CR-05: a signed-in session that did not come from a recovery link changes the password on the account page,
        // with the current password (this page would otherwise skip that check).
        <>
          <Notice tone="warn">{t('auth.resetNeedsLink')}</Notice>
          <div className="login-links"><Link href="/account/security">{t('auth.goToAccount')}</Link><Link href="/forgot-password">{t('auth.forgotSubmit')}</Link></div>
        </>
      ) : done ? (
        <>
          <Notice tone="ok">{t('auth.resetDone')}</Notice>
          <button className="btn btn-primary btn-block" onClick={() => router.push(destinationFor(session.me, null))}>{t('auth.continue')}</button>
        </>
      ) : (
        <form onSubmit={submit} aria-busy={pending || undefined} className="stack" style={{ gap: 12 }}>
          <Field label={t('auth.newPassword')} name="password" type="password" required minLength={MIN_PASSWORD} autoComplete="new-password" dir="ltr" />
          <Field label={t('auth.confirmPassword')} name="confirm" type="password" required minLength={MIN_PASSWORD} autoComplete="new-password" dir="ltr" />
          {error && <Notice tone="danger">{error}</Notice>}
          <button className="btn btn-primary btn-block" disabled={pending}>{pending ? t('state.loading') : t('auth.resetSubmit')}</button>
        </form>
      )}
    </AuthPanel>
  );
}
