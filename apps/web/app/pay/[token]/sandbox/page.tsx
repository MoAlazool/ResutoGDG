'use client';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Badge, Notice, Skeleton } from '@resuto/ui';
import { api, ApiRequestError } from '@/lib/api';
import { guestMoney as money, pick } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { PayFrame } from '../_ui/PayFrame';

interface SandboxView {
  sandbox: true; label: string; amountMinor: number; currency: string; sessionStatus: string;
  merchant: { name: string; nameAr: string | null };
  providerSession: null | { id: string; status: string; amountMinor: number; currency: string };
}

/**
 * Resuto's simulated payment provider. Clearly labelled; the outcome is sent to
 * the API, which emits a signed webhook through the real verification path.
 */
export default function SandboxProviderPage() {
  const { token } = useParams<{ token: string }>();
  const session = useSearchParams().get('session') ?? '';
  const router = useRouter();
  const { t, locale } = useT();
  const [view, setView] = useState<SandboxView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    api<SandboxView>(`/public/pay/${token}/sandbox?session=${encodeURIComponent(session)}`).then(setView).catch((e: ApiRequestError) => setError(e.message));
  }, [token, session]);

  async function complete(outcome: 'success' | 'failure') {
    setError(null);
    try {
      await api(`/public/pay/${token}/sandbox/complete`, { body: { outcome } });
      setSent(true);
      router.replace(`/pay/${token}?return=1`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <PayFrame merchant={view ? pick(locale, view.merchant.name, view.merchant.nameAr) : null} sandbox>
      <section className="pay-card rise" style={{ border: '2px dashed #d8aa4a' }}>
        <Badge tone="sandbox">{t('pay.sandbox.title')}</Badge>
        <h1 style={{ fontSize: 22, marginTop: 12 }}>{t('pay.sandbox.title')}</h1>
        <p className="fine">{t('pay.sandbox.body')}</p>
        {!view && !error && <Skeleton lines={3} />}
        {view && (
          <>
            <div className="pay-amount" dir="ltr">{money(view.amountMinor, view.currency, locale)}</div>
            {view.providerSession ? (
              <>
                <p className="fine" dir="ltr">{t('pay.sandbox.session')}: {view.providerSession.id} · {view.providerSession.status}</p>
                {sent ? <Notice tone="ok">{t('pay.sandbox.done')}</Notice> : view.providerSession.status === 'open' ? (
                  <div className="stack" style={{ marginTop: 12 }}>
                    <button className="btn btn-primary btn-block" onClick={() => complete('success')}>{t('pay.sandbox.success')}</button>
                    <button className="btn btn-danger btn-block" onClick={() => complete('failure')}>{t('pay.sandbox.failure')}</button>
                  </div>
                ) : null}
              </>
            ) : <Notice tone="warn">{t('pay.sandbox.noSession')}</Notice>}
          </>
        )}
        {error && <Notice tone="danger">{error}</Notice>}
        <p style={{ marginTop: 16 }}><Link href={`/pay/${token}?return=1`}>{t('pay.backToCheckout')}</Link></p>
      </section>
    </PayFrame>
  );
}
