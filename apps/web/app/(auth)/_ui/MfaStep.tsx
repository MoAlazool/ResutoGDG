'use client';
import { useState, type FormEvent } from 'react';
import { Field, Notice } from '@resuto/ui';
import { authErrorText } from '@/lib/auth-errors';
import { useT } from '@/lib/i18n/client';
import { useSession } from '@/lib/session';

/**
 * AUTH-02: the authenticator-code step. Shown after a password sign-in, an email link or a 403 mfa_required when the
 * account has a verified TOTP factor; the app is entered only after the code is verified (the session becomes aal2).
 * Arabic-Indic digits typed on an Arabic keyboard become 0-9 (numeric Field + normalizeTotpCode).
 */
export function MfaStep({ onSignedOut, embedded = false }: { onSignedOut?: () => void; embedded?: boolean }) {
  const { t } = useT();
  const session = useSession();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    const code = String(new FormData(e.currentTarget).get('code') ?? '');
    setPending(true);
    setError(null);
    try {
      await session.verifyMfa(code);
    } catch (err) {
      setError(authErrorText(err, t));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className={embedded ? 'stack' : 'login-form'} style={embedded ? { gap: 12 } : undefined} onSubmit={submit}
      aria-busy={pending || undefined} data-testid="mfa-step">
      {!embedded && <>
        <div className="eyebrow">{t('auth.mfa.eyebrow')}</div>
        <h1>{t('auth.mfa.title')}</h1>
        <p>{t('auth.mfa.body')}</p>
      </>}
      <Field label={t('auth.mfa.code')} name="code" required inputMode="numeric" autoComplete="one-time-code" dir="ltr"
        maxLength={9} autoFocus placeholder="123456" />
      {error && <Notice tone="danger">{error}</Notice>}
      <button className="btn btn-primary btn-block" disabled={pending} aria-busy={pending || undefined}>
        {pending ? t('state.loading') : t('auth.mfa.verify')}
      </button>
      <p className="login-note">{t('auth.mfa.lost')}</p>
      <button type="button" className="btn btn-ghost btn-sm" disabled={pending}
        onClick={async () => { await session.signOut(); onSignedOut?.(); }}>{t('auth.mfa.otherAccount')}</button>
    </form>
  );
}
