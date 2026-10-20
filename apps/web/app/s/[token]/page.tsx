'use client';
// One guest's share of a split table bill (legacy guest.js sharePage()): the ÷ invitation, "You are invited to share a
// bill.", the share amount and Continue to payment; once the share is paid (as recorded by the server), "Payment
// complete" with the receipt and "How was your experience?". The share link is its own credential.
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import type { ReceiptView } from '@resuto/contracts';
import { api, ApiRequestError } from '@/lib/api';
import { money, pick } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { intentKey, safeRedirect } from '../../pay/[token]/_ui/PayFrame';
import { Receipt } from '../../pay/[token]/_ui/Receipt';
import { RatingSheet } from '@/components/guest/rating';
import { ConsumerFooter, ConsumerHeader, useToast } from '@/components/guest/shell';
import { GuestLoading } from '@/components/guest/GuestLoading';

interface ShareView {
  id: string; label: string; payerName: string | null; amountMinor: number; paidMinor: number; currency: string;
  status: 'open' | 'paid' | 'void'; mode: string; items: Array<{ name: string; amountMinor: number }>;
  restaurant: { name: string; nameAr: string | null }; branch: { name: string; nameAr: string | null };
  participants: number; paidCount: number; remainingBillMinor: number; visitOpen: boolean; checkoutUrl: string | null; receiptPaymentId: string | null;
}

export default function SharePage() {
  const { token } = useParams<{ token: string }>();
  const { t, locale } = useT();
  const [view, setView] = useState<ShareView | null>(null);
  const [receipt, setReceipt] = useState<ReceiptView | null>(null);
  const [showReceipt, setShowReceipt] = useState(false);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);
  const [rating, setRating] = useState(false);
  const [rated, setRated] = useState(false);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const v = await api<ShareView>(`/public/payments/shares/${encodeURIComponent(token)}`);
      setView(v);
      if (v.payerName) setName((n) => n || v.payerName!);
      if (v.status === 'paid') setReceipt(await api<ReceiptView>(`/public/payments/shares/${encodeURIComponent(token)}/receipt`).catch(() => null));
    } catch (e) { setError(e as ApiRequestError); }
  }, [token]);
  useEffect(() => { void load(); }, [load]);

  async function pay() {
    setPending(true);
    setError(null);
    try {
      const r = await api<{ url: string }>(`/public/payments/shares/${encodeURIComponent(token)}/checkout`, { body: { payerName: name.trim() || null, key: intentKey(`share:${token}`) } });
      safeRedirect(r.url);
    } catch (e) { setError(e as ApiRequestError); setPending(false); }
  }

  if (!view) return error ? <div className="gx"><ConsumerHeader org={null} /><main className="gx-main"><p className="gx-note is-danger" role="alert">{error.message}</p></main></div> : <GuestLoading variant="card" />;
  const m = (v: number) => money(v, view.currency, locale);
  const org = { name: view.restaurant.name, nameAr: view.restaurant.nameAr };
  const paid = view.status === 'paid';
  const header = <ConsumerHeader org={org} branch={view.branch} />;

  if (showReceipt && receipt) {
    return (
      <div className="gx">{header}
        <main className="gx-main"><Receipt r={receipt} onRate={!rated ? () => setRating(true) : undefined} onDone={() => setShowReceipt(false)} /></main>
        {rating && <RatingSheet endpoint={`/public/shares/${encodeURIComponent(token)}/rating`} onClose={() => setRating(false)}
          onDone={() => { setRating(false); setRated(true); toast.show(t('core.guest.rate.thanks')); }} />}
        {toast.node}
      </div>
    );
  }
  return (
    <div className="gx">
      {header}
      <main className="gx-invitation">
        <div className="gx-invitation-mark" aria-hidden>{paid ? '✓' : '÷'}</div>
        <span className="gx-overline">{pick(locale, view.restaurant.name, view.restaurant.nameAr)}</span>
        <h1>{paid ? t('pay.invite.complete') : view.status === 'void' || !view.visitOpen ? t('pay.share.inactive') : t('pay.invite.title')}</h1>
        <p className="gx-fine">{pick(locale, view.branch.name, view.branch.nameAr)}</p>
        <div className="gx-share-amount">
          <span>{t('pay.invite.yourShare')}</span>
          <strong><bdi>{m(paid ? view.amountMinor : view.amountMinor - view.paidMinor)}</bdi></strong>
          <p className="gx-fine" style={{ marginBlockStart: 10 }}>{t('pay.share.progress', { paid: view.paidCount, n: view.participants })}</p>
        </div>
        {view.items.length > 0 && (
          <div style={{ textAlign: 'start', marginBlockEnd: 18 }}>
            {view.items.map((i, k) => <div key={k} className="gx-money-row is-fine"><span>{i.name}</span><strong><bdi>{m(i.amountMinor)}</bdi></strong></div>)}
          </div>
        )}
        {paid ? (
          <div style={{ display: 'grid', gap: 10 }}>
            {receipt && <button type="button" className="gx-btn is-primary is-block" onClick={() => setShowReceipt(true)}>{t('pay.invite.viewReceipt')}</button>}
            {rated ? <p className="gx-fine">{t('core.guest.rate.done')}</p>
              : <button type="button" className="gx-btn is-block" onClick={() => setRating(true)}>{t('core.guest.rate.title')}</button>}
          </div>
        ) : view.status !== 'void' && view.visitOpen ? (
          <form onSubmit={(e) => { e.preventDefault(); void pay(); }} style={{ display: 'grid', gap: 10, textAlign: 'start' }} className="gx-form">
            <label className="gx-field" style={{ display: 'grid', gap: 7, fontSize: 13, fontWeight: 650, color: 'var(--muted)' }}>
              <span>{t('pay.payerName')}</span><input value={name} maxLength={60} autoComplete="given-name" dir="auto" onChange={(e) => setName(e.target.value)} />
            </label>
            {view.checkoutUrl ? <button type="button" className="gx-btn is-primary is-block" onClick={() => safeRedirect(view.checkoutUrl!)}>{t('core.bill.resume')}</button>
              : <button className="gx-btn is-primary is-block" disabled={pending}>{pending ? t('core.bill.redirecting') : t('pay.invite.continue')}</button>}
            {error && <p className="gx-note is-danger" role="alert">{error.message}</p>}
            <p className="gx-fine" style={{ textAlign: 'center' }}>{t('pay.invite.remaining', { amount: m(view.remainingBillMinor) })}</p>
            <p className="gx-fine" style={{ textAlign: 'center' }}>{t('pay.bill.payCash')}</p>
          </form>
        ) : null}
      </main>
      <ConsumerFooter org={org} />
      {rating && <RatingSheet endpoint={`/public/shares/${encodeURIComponent(token)}/rating`} onClose={() => setRating(false)}
        onDone={() => { setRating(false); setRated(true); toast.show(t('core.guest.rate.thanks')); }} />}
      {toast.node}
    </div>
  );
}
