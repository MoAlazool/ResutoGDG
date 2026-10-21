'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { Notice, Skeleton } from '@resuto/ui';
import { destinationFor } from '@/components/shell/AuthForm';
import { authErrorText } from '@/lib/auth-errors';
import { useT } from '@/lib/i18n/client';
import { safeNext } from '@/lib/safe-next';
import { useSession } from '@/lib/session';
import { AuthPanel } from '../../_ui/AuthPanel';
import { MfaStep } from '../../_ui/MfaStep';

/** Account pages an email link may continue to (they are excluded from safeNext as sign-in pages). */
const LINK_TARGETS = new Set(['/reset-password', '/account/security']);

/**
 * CR-05: where Supabase email links return (sign-up confirmation, password recovery, email change, PKCE OAuth):
 * finishes the session, then continues to the validated `next` (same-origin only) or the user's home.
 */
function Callback() {
  const { t } = useT();
  const session = useSession();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const started = useRef(false);
  const routed = useRef(false);

  useEffect(() => {
    if (started.current || !session.tokenReady) return;
    started.current = true;
    const href = window.location.href;
    const raw = new URL(href).searchParams.get('next');
    const next = raw && LINK_TARGETS.has(raw) ? raw : safeNext(raw);
    session.completeAuthLink(href)
      .then(async (r) => {
        // AUTH-02: an account with an authenticator owes its code first (MfaStep below); the effect continues after.
        if (r.mfaRequired) { setTarget(next ?? ''); return; }
        const me = await session.refreshMe();
        routed.current = true;
        router.replace(next ?? destinationFor(me, null));
      })
      .catch((err) => setError(authErrorText(err, t)));
  }, [session, router, t]);

  // After the code step: the session is aal2 and /me answered.
  useEffect(() => {
    if (routed.current || target === null || session.mfaRequired || !session.token || !session.me) return;
    routed.current = true;
    router.replace(target || destinationFor(session.me, null));
  }, [target, session.mfaRequired, session.token, session.me, router]);

  if (target !== null && session.mfaRequired) {
    return (
      <AuthPanel eyebrow={t('auth.mfa.eyebrow')} title={t('auth.mfa.title')} body={t('auth.mfa.body')}>
        <MfaStep embedded onSignedOut={() => router.replace('/login')} />
      </AuthPanel>
    );
  }

  return (
    <AuthPanel eyebrow={t('auth.account.eyebrow')} title={error ? t('auth.callbackFailed') : t('auth.callbackWorking')}>
      {error ? (
        <>
          <Notice tone="danger">{error}</Notice>
          <div className="login-links"><Link href="/login">{t('auth.backToSignIn')}</Link><Link href="/forgot-password">{t('auth.forgot')}</Link></div>
        </>
      ) : <Skeleton lines={2} />}
    </AuthPanel>
  );
}

export default function AuthCallbackPage() {
  return <Suspense><Callback /></Suspense>;
}
