'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { Notice, Skeleton } from '@resuto/ui';
import { ApiRequestError } from '@/lib/api';
import { LanguageToggle, useT } from '@/lib/i18n/client';
import { useSession } from '@/lib/session';

const STR = {
  en: {
    title: 'You have been invited to Resuto', body: 'Accept the invitation to join the restaurant team with the role and branches the owner chose.',
    signInFirst: 'Sign in or create an account with the email address the invitation was sent to, then come back here.',
    signIn: 'Sign in', signUp: 'Create account', accept: 'Accept invitation', accepting: 'Joining…', signedInAs: 'Signed in as {email}',
    switchAccount: 'Use a different account', invalid: 'This invitation is invalid, was already used or has expired. Ask the restaurant for a new link.',
    wrongEmail: 'This invitation was sent to a different email address. Sign in with that address instead.', joined: 'Welcome aboard! Opening your workspace…',
  },
  ar: {
    title: 'تمت دعوتك إلى ريزوتو', body: 'اقبل الدعوة للانضمام إلى فريق المطعم بالدور والفروع التي اختارها المالك.',
    signInFirst: 'سجّل الدخول أو أنشئ حسابًا بالبريد الإلكتروني الذي أُرسلت إليه الدعوة، ثم عُد إلى هذه الصفحة.',
    signIn: 'تسجيل الدخول', signUp: 'إنشاء حساب', accept: 'قبول الدعوة', accepting: 'جارٍ الانضمام…', signedInAs: 'مسجّل الدخول باسم {email}',
    switchAccount: 'استخدم حسابًا آخر', invalid: 'هذه الدعوة غير صالحة أو استُخدمت أو انتهت صلاحيتها. اطلب رابطًا جديدًا من المطعم.',
    wrongEmail: 'أُرسلت هذه الدعوة إلى بريد إلكتروني مختلف. سجّل الدخول بذلك البريد.', joined: 'أهلًا بك! جارٍ فتح مساحة العمل…',
  },
};

/** Invitation acceptance: sign in/up first (returning here via ?next=), then join and route by role. */
export default function InvitePage() {
  const { locale } = useT();
  const s = STR[locale];
  const { token } = useParams<{ token: string }>();
  const session = useSession();
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const next = encodeURIComponent(`/invite/${token}`);

  async function accept() {
    setPending(true);
    setError(null);
    try {
      const r = await session.call<{ orgId: string; role: string }>('/invitations/accept', { body: { token } });
      setDone(true);
      await session.refreshMe();
      router.replace(r.role === 'driver' ? '/driver' : r.role === 'kitchen' ? `/kitchen/${r.orgId}` : `/dashboard/${r.orgId}`);
    } catch (e) {
      const err = e as ApiRequestError;
      setError(err.code === 'forbidden' ? s.wrongEmail : err.code === 'invitation_invalid' || err.status === 400 ? s.invalid : err.message);
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="center-page">
      <div className="auth-card rise">
        <div className="spread">
          <Link href="/" className="brand-row"><img src="/brand/resuto-icon.png" alt="" /> {locale === 'ar' ? 'ريزوتو' : 'Resuto'}</Link>
          <LanguageToggle />
        </div>
        <h1 style={{ fontSize: 24 }}>{s.title}</h1>
        <p className="muted">{s.body}</p>
        {!session.ready ? <Skeleton lines={2} /> : !session.token ? (
          <div className="stack">
            <Notice>{s.signInFirst}</Notice>
            <Link className="btn btn-primary btn-block" href={`/login?next=${next}`}>{s.signIn}</Link>
            <Link className="btn btn-block" href={`/signup?next=${next}`}>{s.signUp}</Link>
          </div>
        ) : (
          <div className="stack">
            <p className="fine">{s.signedInAs.replace('{email}', session.me?.user.email ?? '')}</p>
            {error && <Notice tone="danger">{error}</Notice>}
            {done && <Notice tone="ok">{s.joined}</Notice>}
            <button className="btn btn-primary btn-block" onClick={() => void accept()} disabled={pending || done}>{pending ? s.accepting : s.accept}</button>
            <button className="btn btn-ghost btn-sm" onClick={async () => { await session.signOut(); router.push(`/login?next=${next}`); }}>{s.switchAccount}</button>
          </div>
        )}
      </div>
    </main>
  );
}
