'use client';
import { useParams, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CheckoutView, ReceiptView, StartCheckoutResult } from '@resuto/contracts';
import { Field, Notice, Skeleton } from '@resuto/ui';
import { api, ApiRequestError } from '@/lib/api';
import { dateTime, money, pick } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { methodIcon, PayFrame, safeRedirect } from './_ui/PayFrame';
import { Receipt, ReceiptFailed, ReceiptPending } from './_ui/Receipt';

/**
 * Hosted checkout (/pay/<token>). The return from a provider only triggers a
 * server-side re-check; the page never decides that anything is paid.
 */
export default function HostedCheckoutPage() {
  const { token } = useParams<{ token: string }>();
  const params = useSearchParams();
  const returning = params.get('return') === '1';
  const { t, locale } = useT();
  const [view, setView] = useState<CheckoutView | null>(null);
  const [receipt, setReceipt] = useState<ReceiptView | null>(null);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [method, setMethod] = useState<string | null>(null);
  const [payerName, setPayerName] = useState('');
  const [pending, setPending] = useState(false);
  const [offline, setOffline] = useState<StartCheckoutResult | null>(null);
  const [polls, setPolls] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const load = useCallback(async (recheck: boolean) => {
    try {
      const v = await api<CheckoutView>(`/public/pay/${token}${recheck ? '/refresh' : ''}`, recheck ? { method: 'POST' } : {});
      setView(v);
      setError(null);
      if (v.status === 'paid') setReceipt(await api<ReceiptView>(`/public/pay/${token}/receipt`).catch(() => null));
      return v;
    } catch (e) {
      setError(e as ApiRequestError);
      return null;
    }
  }, [token]);

  useEffect(() => { void load(returning); }, [load, returning]);

  // While an attempt is in flight, keep asking the API (which asks the provider).
  useEffect(() => {
    if (view?.status !== 'processing' || polls > 40) return;
    timer.current = setTimeout(async () => { await load(true); setPolls((n) => n + 1); }, polls < 10 ? 3000 : 6000);
    return () => clearTimeout(timer.current);
  }, [view, polls, load]);

  useEffect(() => {
    if (view && !method) setMethod(view.methods[0]?.method ?? null);
  }, [view, method]);

  async function start() {
    if (!method) return;
    setPending(true);
    try {
      const r = await api<StartCheckoutResult>(`/public/pay/${token}/start`, { body: { method, payerName: payerName.trim() || null } });
      if (r.kind === 'redirect' && r.redirectUrl) { safeRedirect(r.redirectUrl); return; }
      if (r.kind === 'offline') setOffline(r);
      await load(false);
    } catch (e) {
      setError(e as ApiRequestError);
    } finally {
      setPending(false);
    }
  }

  const m = (v: number) => money(v, view?.currency ?? 'EGP', locale);
  const merchant = view ? pick(locale, view.merchant.name, view.merchant.nameAr) : null;

  if (!view) {
    return (
      <PayFrame>
        <div className="pay-card">{error ? <Notice tone="danger">{error.status === 404 ? t('pay.notFound') : error.message}</Notice> : <Skeleton lines={5} />}</div>
      </PayFrame>
    );
  }
  if (view.status === 'paid') {
    return <PayFrame merchant={merchant} sandbox={view.sandbox}>{receipt ? <Receipt r={receipt} /> : <ReceiptPending title={t('pay.confirming')} note={t('pay.confirmingNote')} />}</PayFrame>;
  }
  if (view.status === 'expired' || view.status === 'cancelled') {
    return <PayFrame merchant={merchant} sandbox={view.sandbox}><ReceiptFailed title={t(`pay.status.${view.status}`)} note={t(view.status === 'expired' ? 'pay.expiredNote' : 'pay.cancelledNote')} /></PayFrame>;
  }
  if (view.status === 'processing') {
    const resume = view.attempt?.redirectUrl;
    return (
      <PayFrame merchant={merchant} sandbox={view.sandbox}>
        <ReceiptPending title={t('pay.confirming')} note={polls > 40 ? t('pay.notConfirmedYet') : t('pay.confirmingNote')} />
        <div className="stack" style={{ width: '100%', maxWidth: 440 }}>
          {resume && <button className="btn btn-block" onClick={() => safeRedirect(resume)}>{t('pay.resume')}</button>}
          <button className="btn btn-ghost btn-block" onClick={() => { void load(true); }}>{t('action.retry')}</button>
        </div>
      </PayFrame>
    );
  }

  const failed = view.attempt && ['failed', 'expired'].includes(view.attempt.status);
  const selected = view.methods.find((x) => x.method === method);
  return (
    <PayFrame merchant={merchant} sandbox={view.sandbox}>
      {failed && !offline && <div style={{ width: '100%', maxWidth: 440, marginBottom: 12 }}><Notice tone="warn">{t('pay.failedTitle')} — {t('pay.failedNote')}</Notice></div>}
      <section className="pay-card rise">
        <div className="overline">{t('pay.amountDue')}</div>
        <div className="pay-amount" dir="ltr">{m(view.amountMinor)}</div>
        {view.description && <p className="fine" style={{ margin: 0 }}>{view.description}</p>}
        {view.items.length > 0 && (
          <ul className="pay-lines" aria-label={t('pay.items')}>
            {view.items.map((i, k) => <li key={k}><span>{i.quantity} × {pick(locale, i.name, i.nameAr)}</span><span dir="ltr">{m(i.totalMinor)}</span></li>)}
          </ul>
        )}
        <p className="fine" style={{ marginTop: 12 }}>{t('pay.expiresAt', { time: dateTime(view.expiresAt, locale) })}</p>
      </section>
      <section className="pay-card">
        {offline ? (
          <div className="stack">
            <h2 style={{ margin: 0 }}>{t('pay.offlineTitle')}</h2>
            <Notice>{offline.instructions}</Notice>
            <p className="fine">{t('pay.offlineNote')}</p>
            <button className="btn btn-ghost" onClick={() => setOffline(null)}>{t('pay.chooseOther')}</button>
          </div>
        ) : (
          <>
            <h2 style={{ marginBottom: 4 }}>{t('pay.chooseMethod')}</h2>
            <div className="pay-methods" role="radiogroup" aria-label={t('pay.chooseMethod')}>
              {view.methods.map((o) => (
                <div key={o.method} className="pay-method" role="radio" tabIndex={0} aria-checked={method === o.method}
                  onClick={() => setMethod(o.method)} onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setMethod(o.method); } }}>
                  <span aria-hidden style={{ fontSize: 22 }}>{methodIcon[o.method] ?? '•'}</span>
                  <span><strong>{t(`pay.method.${o.method}`)}</strong><small>{o.kind === 'online' ? t('pay.method.online') : t('pay.method.offline')}{o.sandbox ? ` · ${t('pay.sandboxBadge')}` : ''}</small></span>
                </div>
              ))}
            </div>
            {selected?.kind === 'online' && <Field label={t('pay.payerName')} value={payerName} maxLength={60} autoComplete="name" onChange={(e) => setPayerName(e.target.value)} />}
            {error && <Notice tone="danger">{error.message}</Notice>}
            <button className="btn btn-primary btn-block" disabled={!method || pending} onClick={start} style={{ marginTop: 8 }}>
              {pending ? t('pay.redirecting') : selected?.kind === 'offline' ? t('pay.continue') : t('pay.payNow', { amount: m(view.amountMinor) })}
            </button>
          </>
        )}
      </section>
    </PayFrame>
  );
}
