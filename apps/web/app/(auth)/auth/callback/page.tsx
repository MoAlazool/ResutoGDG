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

/** Account pages an email link may continue to (they are excluded from safeNext as sign-in pages). */
const LINK_TARGETS = new Set(['/reset-password', '/account']);

/**
 * CR-05: where Supabase email links return (sign-up confirmation, password recovery, email change, PKCE OAuth):
 * finishes the session, then continues to the validated `next` (same-origin only) or the user's home.
 */
function Callback() {
  const { t } = useT();
  const session = useSession();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current || !session.tokenReady) return;
    started.current = true;
    const href = window.location.href;
    const raw = new URL(href).searchParams.get('next');
    session.completeAuthLink(href)
      .then(async () => {
        const me = await session.refreshMe();
        const next = raw && LINK_TARGETS.has(raw) ? raw : safeNext(raw);
        router.replace(next ?? destinationFor(me, null));
      })
      .catch((err) => setError(authErrorText(err, t)));
  }, [session, router, t]);

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
