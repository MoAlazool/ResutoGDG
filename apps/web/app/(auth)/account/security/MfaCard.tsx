'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Card, Field, Notice, Skeleton } from '@resuto/ui';
import { authErrorText } from '@/lib/auth-errors';
import { groupSecret, type TotpEnrolment, type TotpFactors } from '@/lib/auth/mfa';
import { date } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useSession } from '@/lib/session';

type Msg = { tone: 'ok' | 'danger'; text: string } | null;

/**
 * AUTH-02: Account > Security > Two-step verification. Add an authenticator app (QR code + setup key, confirmed with
 * its first code), list the ones in use and remove one after re-entering a current code from it. Supabase Auth TOTP
 * MFA works on the Free plan; the local dev issuer has none and says so.
 */
export function MfaCard() {
  const { t, tn, locale } = useT();
  const session = useSession();
  const mfa = session.mfa;
  const [factors, setFactors] = useState<TotpFactors | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [enrol, setEnrol] = useState<TotpEnrolment | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  const reload = useCallback(async () => {
    if (!mfa.available) return;
    try { setFactors(await mfa.list()); setLoadError(null); } catch (e) { setLoadError(authErrorText(e, t)); }
  }, [mfa, t]);
  useEffect(() => { void reload(); }, [reload]);

  if (!mfa.available) {
    return <Card title={t('auth.mfa.cardTitle')}><p className="fine">{t('auth.mfa.unavailableDev')}</p></Card>;
  }

  async function run(action: () => Promise<void>, done?: string) {
    if (pending) return;
    setPending(true);
    setMsg(null);
    try {
      await action();
      if (done) setMsg({ tone: 'ok', text: done });
    } catch (e) {
      setMsg({ tone: 'danger', text: authErrorText(e, t) });
    } finally {
      setPending(false);
    }
  }

  const start = () => run(async () => { setEnrol(await mfa.start()); });
  const cancel = () => run(async () => {
    if (enrol) await mfa.cancel(enrol.factorId);
    setEnrol(null);
  });
  const confirm = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get('code') ?? '');
    return run(async () => {
      await mfa.confirm(enrol!.factorId, code);
      setEnrol(null);
      await reload();
    }, t('auth.mfa.enabled'));
  };
  const remove = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get('code') ?? '');
    const last = (factors?.verified.length ?? 0) <= 1;
    return run(async () => {
      await mfa.remove(removing!, code);
      setRemoving(null);
      await reload();
    }, last ? t('auth.mfa.removedLast') : t('auth.mfa.removed'));
  };

  const verified = factors?.verified ?? [];
  return (
    <Card title={t('auth.mfa.cardTitle')}>
      <div className="stack" style={{ gap: 10 }} data-testid="mfa-card">
        {loadError ? <Notice tone="danger">{loadError}</Notice> : !factors ? <Skeleton lines={2} /> : (
          verified.length ? <Notice tone="ok">{t('auth.mfa.statusOn')}</Notice> : <p className="fine">{t('auth.mfa.statusOff')}</p>
        )}
        {verified.length > 0 && (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
            {verified.map((f) => (
              <li key={f.id} className="stack" style={{ gap: 6 }}>
                <div className="spread">
                  <span><bdi dir="ltr">{f.friendly_name || t('auth.mfa.cardTitle')}</bdi>{' '}
                    <span className="fine">· {tn('auth.mfa.added', { date: <bdi>{date(f.created_at, locale)}</bdi> })}</span></span>
                  {removing !== f.id && <button type="button" className="btn btn-sm" disabled={pending} onClick={() => { setRemoving(f.id); setMsg(null); }}>{t('auth.mfa.remove')}</button>}
                </div>
                {removing === f.id && (
                  <form onSubmit={remove} className="stack" style={{ gap: 8 }} aria-busy={pending || undefined}>
                    <p className="fine" style={{ margin: 0 }}>{t('auth.mfa.removeConfirm')}</p>
                    <Field label={t('auth.mfa.code')} name="code" required inputMode="numeric" autoComplete="one-time-code" dir="ltr" maxLength={9} />
                    <div className="row" style={{ gap: 8 }}>
                      <button className="btn btn-danger btn-sm" disabled={pending}>{t('auth.mfa.removeSubmit')}</button>
                      <button type="button" className="btn btn-ghost btn-sm" disabled={pending} onClick={() => setRemoving(null)}>{t('auth.mfa.cancel')}</button>
                    </div>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
        {enrol ? (
          <form onSubmit={confirm} className="stack" style={{ gap: 10 }} aria-busy={pending || undefined} data-testid="mfa-enrol">
            <p className="fine" style={{ margin: 0 }}>{t('auth.mfa.scan')}</p>
            <img src={enrol.qrCode} alt={t('auth.mfa.qrAlt')} width={180} height={180}
              style={{ background: 'var(--card)', padding: 8, borderRadius: 8, alignSelf: 'center' }} />
            <div className="fine">{t('auth.mfa.secret')}: <code dir="ltr" style={{ userSelect: 'all', wordBreak: 'break-all' }}>{groupSecret(enrol.secret)}</code></div>
            <p className="fine" style={{ margin: 0 }}>{t('auth.mfa.enterFirst')}</p>
            <Field label={t('auth.mfa.code')} name="code" required inputMode="numeric" autoComplete="one-time-code" dir="ltr" maxLength={9} />
            <div className="row" style={{ gap: 8 }}>
              <button className="btn btn-primary" disabled={pending}>{pending ? t('state.loading') : t('auth.mfa.confirm')}</button>
              <button type="button" className="btn btn-ghost" disabled={pending} onClick={() => void cancel()}>{t('auth.mfa.cancel')}</button>
            </div>
          </form>
        ) : factors && (
          <button type="button" className="btn" disabled={pending} onClick={() => void start()}>
            {verified.length ? t('auth.mfa.addAnother') : t('auth.mfa.add')}
          </button>
        )}
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      </div>
    </Card>
  );
}
