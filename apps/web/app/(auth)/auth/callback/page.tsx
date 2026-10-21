'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Suspense, useEffect, useRef, useState, type FormEvent } from 'react';
import { Field, Notice, Skeleton } from '@resuto/ui';
import { destinationFor } from '@/components/shell/AuthForm';
import { authErrorCode, authErrorText, type AuthErrorCode } from '@/lib/auth-errors';
import { linkFlow, type LinkFlow } from '@/lib/auth/links';
import { useT } from '@/lib/i18n/client';
import { loginUrl, safeNext } from '@/lib/safe-next';
import { useSession } from '@/lib/session';
import { AuthPanel } from '../../_ui/AuthPanel';
import { MfaStep } from '../../_ui/MfaStep';
import { EmailDeliveryNote, ResendEmail } from '../../_ui/ResendEmail';

/** Account pages an email link may continue to (they are excluded from safeNext as sign-in pages). */
const LINK_TARGETS = new Set(['/reset-password', '/account/security']);

type Failure = { text: string; code: AuthErrorCode | null };
type Done = 'email_change_half' | 'email_changed';

/**
 * CR-05 / AUTH-03: where Supabase email links return (sign-up confirmation, password recovery, email change, PKCE
 * OAuth): finishes the session, then continues to the validated `next` (same-origin only) or the user's home. A link
 * that expired, was used already or was opened in another browser says so, with the way to a new link for its flow
 * (a new confirmation email, a new reset link, the email change again). The first of the two secure-email-change links
 * says that the second address still has to confirm.
 */
function Callback() {
  const { t } = useT();
  const session = useSession();
  const router = useRouter();
  const [failure, setFailure] = useState<Failure | null>(null);
  const [done, setDone] = useState<{ notice: Done; next: string | null } | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [flow, setFlow] = useState<LinkFlow>('signup');
  const [rawNext, setRawNext] = useState<string | null>(null);
  const started = useRef(false);
  const routed = useRef(false);

  useEffect(() => {
    if (started.current || !session.tokenReady) return;
    started.current = true;
    const href = window.location.href;
    const raw = new URL(href).searchParams.get('next');
    const next = raw && LINK_TARGETS.has(raw) ? raw : safeNext(raw);
    setFlow(linkFlow(next));
    setRawNext(next);
    session.completeAuthLink(href)
      .then(async (r) => {
        if (r.notice === 'email_change_half') { setDone({ notice: r.notice, next }); return; }
        // AUTH-02: an account with an authenticator owes its code first (MfaStep below); the effect continues after.
        if (r.mfaRequired) { setTarget(next ?? ''); return; }
        if (r.notice === 'email_changed') { await session.refreshMe(); setDone({ notice: r.notice, next }); return; }
        const me = await session.refreshMe();
        routed.current = true;
        router.replace(next ?? destinationFor(me, null));
      })
      .catch((err) => setFailure({ text: authErrorText(err, t), code: authErrorCode(err) }));
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

  if (done) {
    return (
      <AuthPanel eyebrow={t('auth.account.eyebrow')} title={done.notice === 'email_changed' ? t('auth.callback.emailChangedTitle') : t('auth.callback.emailChangeHalfTitle')}>
        <Notice tone="ok">{done.notice === 'email_changed' ? t('auth.callback.emailChanged') : t('auth.callback.emailChangeHalf')}</Notice>
        <div className="login-links">
          {session.token ? <Link href="/account/security">{t('auth.goToAccount')}</Link> : <Link href={loginUrl('/account/security')}>{t('auth.backToSignIn')}</Link>}
        </div>
      </AuthPanel>
    );
  }

  return (
    <AuthPanel eyebrow={t('auth.account.eyebrow')} title={failure ? (failure.code === 'link_expired' ? t('auth.callback.expiredTitle') : t('auth.callbackFailed')) : t('auth.callbackWorking')}>
      {failure ? (
        <div className="stack" style={{ gap: 12 }} data-testid="callback-failure">
          <Notice tone="danger">{failure.text}</Notice>
          <Recovery flow={flow} next={rawNext} otherBrowser={failure.code === 'link_other_browser'} />
        </div>
      ) : <Skeleton lines={2} />}
    </AuthPanel>
  );
}

/** The way to a new link for the flow this callback belonged to. */
function Recovery({ flow, next, otherBrowser }: { flow: LinkFlow; next: string | null; otherBrowser: boolean }) {
  const { t } = useT();
  if (flow === 'reset') {
    return (
      <div className="login-links">
        <Link className="btn btn-primary btn-block" href="/forgot-password">{t('auth.callback.newReset')}</Link>
        <Link href="/login">{t('auth.backToSignIn')}</Link>
      </div>
    );
  }
  if (flow === 'email_change') {
    return (
      <div className="login-links">
        <Link className="btn btn-primary btn-block" href="/account/security">{t('auth.callback.newEmailChange')}</Link>
        <Link href="/login">{t('auth.backToSignIn')}</Link>
      </div>
    );
  }
  // Sign-up confirmation (also for an invitation: `next` carries it through the new link).
  return (
    <>
      {otherBrowser ? null : <ResendConfirmation next={next} />}
      <div className="login-links">
        <Link href={loginUrl(next)}>{t('auth.callback.alreadyConfirmed')}</Link>
      </div>
    </>
  );
}

function ResendConfirmation({ next }: { next: string | null }) {
  const { t } = useT();
  const session = useSession();
  const [email, setEmail] = useState('');
  const [ready, setReady] = useState(false);
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = String(new FormData(e.currentTarget).get('email') ?? '').trim();
    if (v) { setEmail(v); setReady(true); }
  };
  return (
    <div className="stack" style={{ gap: 10 }}>
      <p className="fine" style={{ margin: 0 }}>{t('auth.callback.newConfirmBody')}</p>
      {!ready ? (
        <form onSubmit={submit} className="stack" style={{ gap: 10 }}>
          <Field label={t('auth.callback.confirmEmailLabel')} name="email" type="email" required autoComplete="email" dir="ltr" />
          <button className="btn btn-primary btn-block">{t('auth.continue')}</button>
        </form>
      ) : (
        <>
          <p className="fine" style={{ margin: 0 }}><bdi dir="ltr">{email}</bdi></p>
          <EmailDeliveryNote />
          <ResendEmail coolingAtStart={false} label={t('auth.callback.newConfirm')} onResend={() => session.resendEmail('signup', email, next)} />
        </>
      )}
    </div>
  );
}

export default function AuthCallbackPage() {
  return <Suspense><Callback /></Suspense>;
}
