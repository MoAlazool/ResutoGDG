'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Notice, Skeleton } from '@resuto/ui';
import { api } from '@/lib/api';
import { LanguageToggle, useT } from '@/lib/i18n/client';

interface UnsubscribeStatus { channel: 'email' | 'sms'; restaurant: string; unsubscribed: boolean }

/**
 * Opt-out page linked from every marketing email / SMS (INT-28). Opening it changes nothing (link scanners and
 * previews follow links); the guest confirms with the button. Email clients use the one-click POST instead.
 */
function Unsubscribe() {
  const { t } = useT();
  const token = useSearchParams().get('t') ?? '';
  const [status, setStatus] = useState<UnsubscribeStatus | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'invalid' | 'error'>('loading');
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!/^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/.test(token)) { setState('invalid'); return; }
    api<UnsubscribeStatus>(`/public/unsubscribe/${token}`)
      .then((s) => { setStatus(s); setState('ready'); })
      .catch((e) => setState(e?.status === 404 ? 'invalid' : 'error'));
  }, [token]);

  async function confirm() {
    setPending(true);
    try {
      setStatus(await api<UnsubscribeStatus>(`/public/unsubscribe/${token}`, { method: 'POST', body: {} }));
    } catch {
      setState('error');
    } finally {
      setPending(false);
    }
  }

  const channel = status ? t(`marketing.consent.unsub.channel.${status.channel}`) : '';
  return (
    <main className="center-page">
      <div className="auth-card rise">
        <div className="spread">
          <span className="brand-row"><img src="/brand/resuto-icon.png" alt="" /> {t('marketing.consent.unsub.brand')}</span>
          <LanguageToggle />
        </div>
        <h1 style={{ fontSize: '1.4rem', margin: '16px 0 8px' }}>{t('marketing.consent.unsub.title')}</h1>
        {state === 'loading' && <Skeleton lines={2} />}
        {state === 'invalid' && <Notice tone="warn">{t('marketing.consent.unsub.invalid')}</Notice>}
        {state === 'error' && <Notice tone="danger">{t('marketing.consent.unsub.error')}</Notice>}
        {state === 'ready' && status && (status.unsubscribed ? (
          <div data-testid="unsubscribed">
            <Notice tone="ok">{t('marketing.consent.unsub.done', { channel })} <bdi>{status.restaurant}</bdi></Notice>
          </div>
        ) : (
          <>
            <p className="muted">{t('marketing.consent.unsub.body', { channel })} <bdi>{status.restaurant}</bdi></p>
            <p className="muted small">{t('marketing.consent.unsub.note')}</p>
            <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={confirm} disabled={pending} data-testid="confirm-unsubscribe">
              {pending ? t('marketing.consent.unsub.pending') : t('marketing.consent.unsub.confirm', { channel })}
            </button>
          </>
        ))}
        <p className="small muted" style={{ marginTop: 16 }}><Link href="/">{t('marketing.consent.unsub.home')}</Link></p>
      </div>
    </main>
  );
}

export default function UnsubscribePage() {
  return <Suspense fallback={null}><Unsubscribe /></Suspense>;
}
