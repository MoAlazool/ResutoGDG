'use client';
import { INTL_LOCALE } from '@resuto/contracts';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import QRCode from 'qrcode';
import { useCallback, useEffect, useState } from 'react';
import type { ReceiptView, SplitShareView } from '@resuto/contracts';
import { Badge, EmptyState, Field, Notice, Skeleton } from '@resuto/ui';
import { api, ApiRequestError } from '@/lib/api';
import { loadGuestVisit, visitHeaders, type GuestVisit } from '@/lib/guest-visit';
import { money, pick } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { clearIntent, intentKey, PayFrame, safeRedirect } from '../../../pay/[token]/_ui/PayFrame';
import { Receipt } from '../../../pay/[token]/_ui/Receipt';
import { loadBill, shareLabel, type BillView } from './bill';

/** Table bill (QR): view the bill, pay it, or split it and hand out share links. */
export default function TableBillPage() {
  const { qr } = useParams<{ qr: string }>();
  const { t, locale } = useT();
  const [visit, setVisit] = useState<GuestVisit | null | undefined>(undefined);
  const [bill, setBill] = useState<BillView | null>(null);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [partial, setPartial] = useState('');
  const [pending, setPending] = useState(false);
  const [receipt, setReceipt] = useState<ReceiptView | null>(null);

  useEffect(() => { setVisit(loadGuestVisit(qr)); }, [qr]);
  const load = useCallback(async () => {
    if (!visit) return;
    try { setBill(await loadBill(visit)); setError(null); } catch (e) { setError(e as ApiRequestError); }
  }, [visit]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!bill?.split || bill.split.status !== 'open') return;
    const id = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 8000);
    return () => clearInterval(id);
  }, [bill?.split, load]);

  if (visit === undefined) return <PayFrame><div className="pay-card"><Skeleton lines={4} /></div></PayFrame>;
  if (visit === null || error?.status === 404 || error?.status === 401) {
    return (
      <PayFrame>
        <div className="pay-card"><EmptyState title={t('pay.bill.noSession')} action={<Link className="btn btn-primary" href={`/t/${qr}`}>{t('pay.bill.openMenu')}</Link>}>{t('pay.bill.noSessionBody')}</EmptyState></div>
      </PayFrame>
    );
  }
  if (!bill) return <PayFrame><div className="pay-card">{error ? <Notice tone="danger">{error.message}</Notice> : <Skeleton lines={5} />}</div></PayFrame>;

  const m = (v: number) => money(v, bill.currency, locale);
  const scope = `bill:${bill.visitId}`;
  async function payBill(amountMinor?: number) {
    setPending(true);
    setError(null);
    try {
      const r = await api<{ url: string }>('/public/payments/visit/checkout', {
        headers: visitHeaders(visit!), body: { key: intentKey(`${scope}:${amountMinor ?? 'full'}`), ...(amountMinor ? { amountMinor } : {}) } });
      clearIntent(`${scope}:${amountMinor ?? 'full'}`);
      safeRedirect(r.url);
    } catch (e) {
      setError(e as ApiRequestError);
      setPending(false);
    }
  }
  async function cancelSplit() {
    try { await api('/public/payments/visit/split/cancel', { method: 'POST', headers: visitHeaders(visit!) }); await load(); } catch (e) { setError(e as ApiRequestError); }
  }
  async function showReceipt(paymentId: string) {
    try { setReceipt(await api<ReceiptView>(`/public/payments/visit/receipts/${paymentId}`, { headers: visitHeaders(visit!) })); } catch (e) { setError(e as ApiRequestError); }
  }
  const partialMinor = Math.round(Number(partial.replace(',', '.')) * 100);

  if (receipt) return <PayFrame merchant={pick(locale, bill.org.name, bill.org.nameAr)}><Receipt r={receipt} actions={<button className="btn btn-ghost" onClick={() => setReceipt(null)}>{t('action.back')}</button>} /></PayFrame>;

  return (
    <PayFrame merchant={pick(locale, bill.org.name, bill.org.nameAr)}>
      <section className="pay-card rise">
        <div className="spread"><h1 style={{ fontSize: 22, margin: 0 }}>{t('pay.bill.title')}</h1><Badge>{t('pay.bill.table', { label: bill.table.label })}</Badge></div>
        {!bill.orders.length && <p className="fine">{t('pay.bill.empty')}</p>}
        {bill.orders.map((o) => (
          <div key={o.id} style={{ marginTop: 12 }}>
            <div className="fine">{t('pay.bill.order', { number: o.number })}</div>
            <ul className="pay-lines">{o.lines.map((l) => <li key={l.id}><span>{l.quantity} × {pick(locale, l.name, l.nameAr)}</span><span dir="ltr">{m(l.lineTotalMinor)}</span></li>)}</ul>
          </div>
        ))}
        <div className="pay-totals">
          <div><span>{t('pay.bill.total')}</span><span dir="ltr">{m(bill.totals.totalMinor)}</span></div>
          {bill.totals.paidMinor > 0 && <div><span>{t('pay.bill.paid')}</span><span dir="ltr">−{m(bill.totals.paidMinor)}</span></div>}
          {bill.totals.creditMinor > 0 && <div><span>{t('pay.bill.credit')}</span><span dir="ltr">−{m(bill.totals.creditMinor)}</span></div>}
          <div className="due"><span>{t('pay.bill.due')}</span><span dir="ltr">{m(bill.totals.dueMinor)}</span></div>
        </div>
      </section>

      {error && <div className="pay-card"><Notice tone="danger">{error.message}</Notice></div>}
      {bill.pendingCheckout?.url && (
        <section className="pay-card"><Notice tone="warn">{t('pay.bill.pending')}</Notice>
          <button className="btn btn-block" style={{ marginTop: 10 }} onClick={() => safeRedirect(bill.pendingCheckout!.url!)}>{t('pay.resume')}</button></section>
      )}

      {bill.split && bill.split.status !== 'cancelled' ? (
        <SplitPanel split={bill.split} currency={bill.currency} onCancel={cancelSplit} />
      ) : bill.totals.dueMinor > 0 ? (
        <section className="pay-card stack">
          <button className="btn btn-primary btn-block" disabled={pending} onClick={() => payBill()}>{pending ? t('pay.redirecting') : `${t('pay.bill.payFull')} · ${m(bill.totals.dueMinor)}`}</button>
          <Link className="btn btn-block" href={`/t/${qr}/pay/split`}>{t('pay.bill.split')}</Link>
          <details>
            <summary className="fine" style={{ cursor: 'pointer' }}>{t('pay.bill.payAmount')}</summary>
            <div className="row" style={{ marginTop: 8, alignItems: 'flex-end' }}>
              <div style={{ flex: 1 }}><Field label={t('pay.bill.amount')} inputMode="decimal" value={partial} onChange={(e) => setPartial(e.target.value)} dir="ltr" /></div>
              <button className="btn" style={{ marginBottom: 14 }} disabled={pending || !(partialMinor > 0 && partialMinor <= bill.totals.dueMinor)} onClick={() => payBill(partialMinor)}>{t('pay.continue')}</button>
            </div>
          </details>
          <p className="fine">{t('pay.bill.payCash')}</p>
        </section>
      ) : (
        <section className="pay-card"><Notice tone="ok">{t('pay.bill.settled')}</Notice></section>
      )}

      {bill.receipts.length > 0 && (
        <section className="pay-card">
          <h3>{t('pay.bill.receipts')}</h3>
          <div className="receipt-list">
            {bill.receipts.map((r) => (
              <button key={r.paymentId} type="button" className="receipt-list-item" onClick={() => showReceipt(r.paymentId)}>
                <span><strong>{t(`pay.method.${r.method}`)}</strong><small>{r.at ? new Date(r.at).toLocaleString(locale === 'ar' ? INTL_LOCALE.ar : 'en-GB') : ''}</small></span>
                <b dir="ltr">{m(r.amountMinor)}</b>
              </button>
            ))}
          </div>
        </section>
      )}
    </PayFrame>
  );
}

function SplitPanel({ split, currency, onCancel }: { split: NonNullable<BillView['split']>; currency: string; onCancel: () => void }) {
  const { t, locale } = useT();
  const anyPaid = split.shares.some((s) => s.paidMinor > 0);
  return (
    <section className="pay-card stack">
      <div className="spread"><h2 style={{ margin: 0 }}>{t('pay.split.active')}</h2><Badge tone={split.status === 'settled' ? 'ok' : 'info'}>{t(`pay.split.${split.mode === 'whole' ? 'equal' : split.mode}`)}</Badge></div>
      {split.status === 'settled' ? <Notice tone="ok">{t('pay.split.settled')}</Notice> : <p className="fine">{t('pay.split.shareLinks')}</p>}
      {split.shares.map((s) => <ShareRow key={s.id} share={s} currency={currency} locale={locale} />)}
      {!anyPaid && split.status === 'open' && <button className="btn btn-ghost" onClick={onCancel}>{t('pay.split.cancel')}</button>}
    </section>
  );
}

function ShareRow({ share, currency, locale }: { share: SplitShareView; currency: string; locale: 'en' | 'ar' }) {
  const { t } = useT();
  const [qrSvg, setQrSvg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const paid = share.status === 'paid';
  async function toggleQr() {
    if (qrSvg) { setQrSvg(null); return; }
    setQrSvg(await QRCode.toString(share.url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }));
  }
  async function copy() {
    try {
      if (navigator.share) await navigator.share({ title: share.label, url: share.url });
      else { await navigator.clipboard.writeText(share.url); setCopied(true); }
    } catch { /* dismissed */ }
  }
  return (
    <div className="pay-share">
      <div className="spread"><strong>{shareLabel(share.label, t)}</strong><span dir="ltr" className="num">{money(share.amountMinor, currency, locale)}</span></div>
      {paid ? <Badge tone="ok">{t('pay.status.paid')}</Badge> : (
        <div className="pay-grid2">
          <button className="btn btn-sm" onClick={copy}>{copied ? t('pay.receipt.copied') : t('pay.split.copy')}</button>
          <button className="btn btn-sm" onClick={toggleQr}>{qrSvg ? t('pay.split.hideQr') : t('pay.split.showQr')}</button>
        </div>
      )}
      {/* SVG generated locally by the qrcode library from our own share URL. */}
      {qrSvg && !paid && <div className="pay-qr" dangerouslySetInnerHTML={{ __html: qrSvg }} />}
      {!paid && <a className="fine" href={share.url}>{t('pay.share.pay')}</a>}
    </div>
  );
}
