'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { Card, Field, Notice, Skeleton } from '@resuto/ui';
import { authErrorText } from '@/lib/auth-errors';
import { homePath } from '@/lib/home-path';
import { useT } from '@/lib/i18n/client';
import { loginUrl } from '@/lib/safe-next';
import { AUTH_MODE, useSession } from '@/lib/session';
import { AuthPanel, MIN_PASSWORD } from '../../_ui/AuthPanel';

/**
 * CR-05: the signed-in account (legacy /account "Account home"): who you are, your restaurants, change password and
 * email, sign out.
 */
export default function AccountPage() {
  const { t, tn } = useT();
  const session = useSession();
  const router = useRouter();
  useEffect(() => {
    if (session.ready && !session.token) router.replace(loginUrl('/account/security'));
  }, [session.ready, session.token, router]);
  const me = session.me;

  return (
    <AuthPanel eyebrow={t('auth.account.eyebrow')} title={t('auth.account.title')}
      body={me ? <>{t('auth.account.signedInAs')} <bdi dir="ltr"><strong>{me.user.email}</strong></bdi></> : undefined}>
      {!me ? <Skeleton lines={6} /> : (
        <div className="stack" style={{ gap: 16 }}>
          <Card title={t('auth.account.workspaces')}>
            {me.memberships.length === 0 ? <p className="fine">{t('auth.account.noWorkspaces')}</p> : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
                {me.memberships.map((m) => (
                  <li key={m.orgId} className="spread">
                    <span><bdi>{m.orgName}</bdi> <span className="fine">· {t(`role.${m.role}`)}</span></span>
                    <Link href={homePath(m.role, m.orgId)}>{t('auth.account.open')}</Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <PasswordCard />
          <EmailCard />
          <button className="btn btn-block" onClick={async () => { await session.signOut(); router.push('/login'); }}>{t('auth.account.signOut')}</button>
          {AUTH_MODE === 'dev' && <p className="login-dev"><span className="badge badge-sandbox">DEV</span><span>{tn('auth.devMode', { provider: <bdi dir="ltr">Supabase Auth</bdi> })}</span></p>}
        </div>
      )}
    </AuthPanel>
  );
}

function PasswordCard() {
  const { t } = useT();
  const session = useSession();
  const [pending, setPending] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    const form = e.currentTarget;
    const f = new FormData(form);
    const next = String(f.get('password') ?? ''), again = String(f.get('confirm') ?? '');
    if (next !== again) { setMsg({ tone: 'danger', text: t('auth.mismatch') }); return; }
    setPending(true); setMsg(null);
    try {
      await session.updatePassword(next, String(f.get('current') ?? ''));
      form.reset();
      setMsg({ tone: 'ok', text: t('auth.account.passwordDone') });
    } catch (err) {
      setMsg({ tone: 'danger', text: authErrorText(err, t) });
    } finally {
      setPending(false);
    }
  }
  return (
    <Card title={t('auth.account.passwordTitle')}>
      <form onSubmit={submit} className="stack" style={{ gap: 10 }} aria-busy={pending || undefined}>
        <Field label={t('auth.currentPassword')} name="current" type="password" required autoComplete="current-password" dir="ltr" />
        <Field label={t('auth.newPassword')} name="password" type="password" required minLength={MIN_PASSWORD} autoComplete="new-password" dir="ltr" />
        <Field label={t('auth.confirmPassword')} name="confirm" type="password" required minLength={MIN_PASSWORD} autoComplete="new-password" dir="ltr" />
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        <button className="btn btn-primary" disabled={pending}>{pending ? t('state.loading') : t('auth.account.passwordSubmit')}</button>
      </form>
    </Card>
  );
}

function EmailCard() {
  const { t, tn } = useT();
  const session = useSession();
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (AUTH_MODE !== 'supabase') {
    return <Card title={t('auth.account.emailTitle')}><p className="fine">{t('auth.error.email_change_unavailable')}</p></Card>;
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    const email = String(new FormData(e.currentTarget).get('email') ?? '').trim();
    setPending(true); setError(null);
    try { await session.updateEmail(email); setSent(email); } catch (err) { setError(authErrorText(err, t)); } finally { setPending(false); }
  }
  return (
    <Card title={t('auth.account.emailTitle')}>
      <p className="fine">{t('auth.account.emailBody')}</p>
      {sent ? <Notice tone="ok">{tn('auth.account.emailSent', { email: <bdi dir="ltr">{sent}</bdi> })}</Notice> : (
        <form onSubmit={submit} className="stack" style={{ gap: 10 }}>
          <Field label={t('auth.account.newEmail')} name="email" type="email" required autoComplete="email" dir="ltr" />
          {error && <Notice tone="danger">{error}</Notice>}
          <button className="btn" disabled={pending}>{t('auth.account.emailSubmit')}</button>
        </form>
      )}
    </Card>
  );
}
