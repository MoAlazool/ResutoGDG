'use client';
import { useEffect, useState } from 'react';
import { formatNumber } from '@resuto/contracts';
import { Notice } from '@resuto/ui';
import { authErrorCode, authErrorText } from '@/lib/auth-errors';
import { EMAIL_DELIVERY_LIMITED } from '@/lib/auth/email-delivery';
import { RESEND_COOLDOWN_S, retryAfterSeconds } from '@/lib/auth/links';
import { useT } from '@/lib/i18n/client';

type Msg = { tone: 'ok' | 'danger'; text: string } | null;

/**
 * AUTH-03: "send the email again" with a visible cooldown (Supabase allows one email per address per 60 s by default;
 * a too-early request is answered with the seconds left, which restart the countdown). Never claims an email was
 * sent unless Supabase accepted the request.
 */
export function ResendEmail({ onResend, label, coolingAtStart = true }: { onResend: () => Promise<void>; label?: string; coolingAtStart?: boolean }) {
  const { t, tn, locale } = useT();
  const [left, setLeft] = useState(coolingAtStart ? RESEND_COOLDOWN_S : 0);
  const [pending, setPending] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  useEffect(() => {
    if (left <= 0) return;
    const id = setTimeout(() => setLeft((l) => l - 1), 1000);
    return () => clearTimeout(id);
  }, [left]);

  async function resend() {
    if (pending || left > 0) return;
    setPending(true);
    setMsg(null);
    try {
      await onResend();
      setMsg({ tone: 'ok', text: t('auth.resend.sent') });
      setLeft(RESEND_COOLDOWN_S);
    } catch (e) {
      setMsg({ tone: 'danger', text: authErrorText(e, t) });
      if (authErrorCode(e) === 'rate_limited') setLeft(retryAfterSeconds(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="stack" style={{ gap: 8 }} data-testid="resend-email">
      <button type="button" className="btn btn-block" disabled={pending || left > 0} aria-busy={pending || undefined} onClick={() => void resend()}>
        {pending ? t('state.loading') : left > 0
          ? tn('auth.resend.wait', { seconds: <bdi dir="ltr">{formatNumber(left, locale)}</bdi> })
          : label ?? t('auth.resend.button')}
      </button>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
    </div>
  );
}

/** The honest delivery note on deployments without a custom SMTP sender (NEXT_PUBLIC_AUTH_EMAIL_DELIVERY=limited). */
export function EmailDeliveryNote() {
  const { t } = useT();
  return EMAIL_DELIVERY_LIMITED ? <Notice tone="warn">{t('auth.emailLimited')}</Notice> : null;
}
