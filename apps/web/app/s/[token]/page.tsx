'use client';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import type { ReceiptView } from '@resuto/contracts';
import { Field, Notice, Skeleton } from '@resuto/ui';
import { api, ApiRequestError } from '@/lib/api';
import { money, pick } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { intentKey, PayFrame, safeRedirect } from '../../pay/[token]/_ui/PayFrame';
import { Receipt, ReceiptFailed } from '../../pay/[token]/_ui/Receipt';
import { shareLabel } from '../../t/[qr]/pay/bill';

interface ShareView {
  id: string; label: string; payerName: string | null; amountMinor: number; paidMinor: number; currency: string;
  status: 'open' | 'paid' | 'void'; mode: string; items: Array<{ name: string; amountMinor: number }>;
  restaurant: { name: string; nameAr: string | null }; branch: { name: string; nameAr: string | null };
  participants: number; paidCount: number; remainingBillMinor: number; visitOpen: boolean; checkoutUrl: string | null; receiptPaymentId: string | null;
}

/** One guest's share of a split table bill. The share link is its own credential. */
export default function SharePage() {
  const { token } = useParams<{ token: string }>();
  const { t, locale } = useT();
  const [view, setView] = useState<ShareView | null>(null);
  const [receipt, setReceipt] = useState<ReceiptView | null>(null);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);

  const load = useCallback(async () => {
    try {
      const v = await api<ShareView>(`/public/payments/shares/${token}`);
      setView(v);
      if (v.payerName) setName(v.payerName);
      if (v.status === 'paid') setReceipt(await api<ReceiptView>(`/public/payments/shares/${token}/receipt`).catch(() => null));
    } catch (e) {
      setError(e as ApiRequestError);
    }
  }, [token]);
  useEffect(() => { void load(); }, [load]);

  async function pay() {
    setPending(true);
    setError(null);
    try {
      const r = await api<{ url: string }>(`/public/payments/shares/${token}/checkout`, { body: { payerName: name.trim() || null, key: intentKey(`share:${token}`) } });
      safeRedirect(r.url);
    } catch (e) {
      setError(e as ApiRequestError);
      setPending(false);
    }
  }

  if (!view) return <PayFrame><div className="pay-card">{error ? <Notice tone="danger">{error.message}</Notice> : <Skeleton lines={4} />}</div></PayFrame>;
  const m = (v: number) => money(v, view.currency, locale);
  const merchant = pick(locale, view.restaurant.name, view.restaurant.nameAr);
  if (view.status === 'paid') {
    return <PayFrame merchant={merchant}>{receipt ? <Receipt r={receipt} /> : <Notice tone="ok">{t('pay.share.paid')}</Notice>}</PayFrame>;
  }
  if (view.status === 'void' || !view.visitOpen) return <PayFrame merchant={merchant}><ReceiptFailed title={t('pay.share.inactive')} note="" /></PayFrame>;
  return (
    <PayFrame merchant={merchant}>
      <section className="pay-card rise">
        <div className="overline">{t('pay.share.of', { restaurant: merchant })}</div>
        <h1 style={{ fontSize: 22, margin: '8px 0 0' }}>{shareLabel(view.label, t)}</h1>
        <div className="pay-amount" dir="ltr">{m(view.amountMinor - view.paidMinor)}</div>
        <p className="fine">{t('pay.share.progress', { paid: view.paidCount, n: view.participants })} · {t('pay.share.remainingBill', { amount: m(view.remainingBillMinor) })}</p>
        {view.items.length > 0 && (
          <>
            <h3 style={{ marginTop: 12 }}>{t('pay.share.items')}</h3>
            <ul className="pay-lines">{view.items.map((i, k) => <li key={k}><span>{i.name}</span><span dir="ltr">{m(i.amountMinor)}</span></li>)}</ul>
          </>
        )}
      </section>
      <section className="pay-card">
        <Field label={t('pay.payerName')} value={name} maxLength={60} autoComplete="given-name" onChange={(e) => setName(e.target.value)} />
        {error && <Notice tone="danger">{error.message}</Notice>}
        <button className="btn btn-primary btn-block" disabled={pending} onClick={pay}>{pending ? t('pay.redirecting') : t('pay.share.pay')}</button>
        <p className="fine" style={{ marginTop: 10 }}>{t('pay.bill.payCash')}</p>
      </section>
    </PayFrame>
  );
}
