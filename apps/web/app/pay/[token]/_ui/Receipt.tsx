'use client';
// Digital receipt — React port of legacy/public/receipt.js. Rendered only from
// a ReceiptView the API builds from a settled payment row.
import { useState, type ReactNode } from 'react';
import type { ReceiptView } from '@resuto/contracts';
import { useT } from '@/lib/i18n/client';
import { money } from '@/lib/format';
import './receipt.css';

// Code 39 — self-checking; every receipt id is inside its charset.
const CODE39: Record<string, string> = { '0': 'nnnwwnwnn', '1': 'wnnwnnnnw', '2': 'nnwwnnnnw', '3': 'wnwwnnnnn', '4': 'nnnwwnnnw', '5': 'wnnwwnnnn', '6': 'nnwwwnnnn', '7': 'nnnwnnwnw', '8': 'wnnwnnwnn', '9': 'nnwwnnwnn', A: 'wnnnnwnnw', B: 'nnwnnwnnw', C: 'wnwnnwnnn', D: 'nnnnwwnnw', E: 'wnnnwwnnn', F: 'nnwnwwnnn', G: 'nnnnnwwnw', H: 'wnnnnwwnn', I: 'nnwnnwwnn', J: 'nnnnwwwnn', K: 'wnnnnnnww', L: 'nnwnnnnww', M: 'wnwnnnnwn', N: 'nnnnwnnww', O: 'wnnnwnnwn', P: 'nnwnwnnwn', Q: 'nnnnnnwww', R: 'wnnnnnwwn', S: 'nnwnnnwwn', T: 'nnnnwnwwn', U: 'wwnnnnnnw', V: 'nwwnnnnnw', W: 'wwwnnnnnn', X: 'nwnnwnnnw', Y: 'wwnnwnnnn', Z: 'nwwnwnnnn', '-': 'nwnnnnwnw', '.': 'wwnnnnwnn', ' ': 'nwwnnnwnn', '*': 'nwnnwnwnn' };

export function Barcode({ value, height = 54, label }: { value: string; height?: number; label: string }) {
  const text = `*${value.toUpperCase().replace(/[^0-9A-Z\-. ]/g, '')}*`;
  const bars: Array<{ x: number; w: number }> = [];
  let x = 0;
  for (const ch of text) {
    const p = CODE39[ch];
    if (!p) continue;
    for (let i = 0; i < p.length; i++) {
      const w = p[i] === 'w' ? 6 : 2;
      if (i % 2 === 0) bars.push({ x, w });
      x += w;
    }
    x += 2;
  }
  return (
    <svg className="receipt-barcode" viewBox={`0 0 ${x} ${height}`} role="img" aria-label={label} preserveAspectRatio="none">
      {bars.map((b, i) => <rect key={i} x={b.x} y={0} width={b.w} height={height} />)}
    </svg>
  );
}

export function Receipt({ r, actions }: { r: ReceiptView; actions?: ReactNode }) {
  const { t, locale, dir } = useT();
  const [copied, setCopied] = useState(false);
  const m = (v: number) => money(v, r.currency, locale);
  const loc = locale === 'ar' ? 'ar-EG' : 'en-GB';
  const at = r.reservation ? new Date(r.reservation.startsAt) : new Date(r.at);
  const date = new Intl.DateTimeFormat(loc, { day: 'numeric', month: 'short', year: 'numeric' }).format(at);
  const time = new Intl.DateTimeFormat(loc, { hour: 'numeric', minute: '2-digit' }).format(at);
  const name = (en: string, ar: string | null) => (locale === 'ar' && ar ? ar : en);
  const meta: Array<[string, string | number | null | undefined]> = [
    [t('pay.receipt.order'), r.reference.orders[0]], [t('pay.receipt.number'), r.id],
    ...(r.reservation ? [[t('pay.receipt.reservation'), r.reference.reservation], [t('pay.receipt.guests'), r.reservation.partySize]] as Array<[string, string | number]> : []),
    [t('pay.receipt.date'), date], [t('pay.receipt.time'), time], [t('pay.receipt.table'), r.table],
  ];
  const shareText = () => [`${r.restaurant.name} — ${t('pay.receipt.title')} ${r.id}`, `${date} ${time}`,
    ...r.items.map((l) => `${l.quantity} × ${name(l.name, l.nameAr)}  ${m(l.totalMinor)}`), `${t('pay.receipt.paidNow')}: ${m(r.amountMinor)}`,
    `${t('pay.receipt.txn')}: ${r.payment.transactionId}`].join('\n');
  async function share() {
    const text = shareText();
    try {
      if (navigator.share) await navigator.share({ title: `${t('pay.receipt.title')} ${r.id}`, text });
      else { await navigator.clipboard.writeText(text); setCopied(true); }
    } catch { /* dismissed */ }
  }
  const Row = ({ label, value, cls = '' }: { label: string; value: number; cls?: string }) => (
    <div className={`receipt-amount ${cls}`}><span>{label}</span><b dir="ltr">{m(value)}</b></div>
  );
  return (
    <div className="receipt-stage">
      <article className="receipt-paper" dir={dir} aria-label={`${t('pay.receipt.title')} ${r.id}`}>
        <div className="receipt-body">
          <header className="receipt-head">
            <h2 className="receipt-title">{t('pay.receipt.title')}</h2>
            <p className="receipt-stamp">✓ {r.status === 'paid' ? t('pay.receipt.success') : t('pay.receipt.refunded')}</p>
          </header>
          <section className="receipt-venue"><strong>{name(r.restaurant.name, r.restaurant.nameAr)}</strong><span>{r.branch ? name(r.branch.name, r.branch.nameAr) : ''}</span></section>
          <div className="receipt-rule" aria-hidden />
          <dl className="receipt-meta">
            {meta.filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{String(v)}</dd></div>)}
          </dl>
          {r.reference.orders.length > 1 && <p className="receipt-note">{t('pay.receipt.alsoCovers')}: {r.reference.orders.slice(1).join(', ')}</p>}
          <div className="receipt-rule dotted" aria-hidden />
          <div className="receipt-items">
            {r.kind === 'deposit' ? (
              <div className="receipt-item"><span className="receipt-qty">1</span><span className="receipt-item-name">{t('pay.receipt.deposit')}<small>{r.reservation?.guestName}</small></span><b className="receipt-item-price" dir="ltr">{m(r.amountMinor)}</b></div>
            ) : r.items.map((l, i) => (
              <div key={i} className="receipt-item"><span className="receipt-qty">{l.quantity}</span>
                <span className="receipt-item-name">{name(l.name, l.nameAr)}<small dir="ltr">{m(l.unitPriceMinor)} {t('pay.receipt.each')}</small></span>
                <b className="receipt-item-price" dir="ltr">{m(l.totalMinor)}</b></div>
            ))}
          </div>
          <div className="receipt-rule dotted" aria-hidden />
          {r.kind === 'deposit' ? (
            <>
              <div className="receipt-totals"><Row label={t('pay.receipt.total')} value={r.amountMinor} cls="receipt-grand" /></div>
              <p className="receipt-note">{t('pay.receipt.depositNote')}</p>
            </>
          ) : (
            <>
              <div className="receipt-totals">
                <Row label={t('pay.receipt.subtotal')} value={r.totals.subtotalMinor} />
                {r.totals.discountMinor > 0 && <Row label={t('pay.receipt.discount')} value={-r.totals.discountMinor} cls="receipt-credit" />}
                {r.totals.feeMinor > 0 && <Row label={t('pay.receipt.fees')} value={r.totals.feeMinor} />}
                {r.totals.taxMinor > 0 && <Row label={t('pay.receipt.vatIncluded')} value={r.totals.taxMinor} />}
                <Row label={t('pay.receipt.total')} value={r.totals.totalMinor} cls="receipt-grand" />
              </div>
              <div className="receipt-rule dotted" aria-hidden />
              <div className="receipt-totals">
                <Row label={r.split ? t('pay.receipt.yourPayment') : t('pay.receipt.paidNow')} value={r.amountMinor} cls="receipt-paid" />
                {r.refundedMinor > 0 && <Row label={t('pay.receipt.refunded')} value={-r.refundedMinor} />}
                <Row label={t('pay.receipt.remaining')} value={r.totals.dueMinor} cls={r.totals.dueMinor ? 'receipt-due' : ''} />
              </div>
              {!r.totals.dueMinor && <p className="receipt-settled">✓ {t('pay.receipt.fullyPaid')}</p>}
            </>
          )}
          <div className="receipt-rule dotted" aria-hidden />
          <dl className="receipt-meta receipt-payment">
            <div><dt>{t('pay.receipt.method')}</dt><dd>{t(`pay.method.${r.payment.method}`)}{r.payment.provider !== 'manual' ? ` · ${r.payment.provider}` : ''}</dd></div>
            <div><dt>{t('pay.receipt.status')}</dt><dd className="receipt-paid-flag">{t('pay.receipt.paid')} ✓</dd></div>
            <div><dt>{t('pay.receipt.txn')}</dt><dd dir="ltr">{r.payment.transactionId}</dd></div>
            {r.split && <div><dt>{t('pay.receipt.split')}</dt><dd>{t('pay.receipt.splitPaid', { paid: r.split.paidCount, n: r.split.participants })}</dd></div>}
          </dl>
          {r.payment.mode === 'test' && <p className="receipt-note">{t('pay.receipt.test')}</p>}
          <div className="receipt-rule dotted" aria-hidden />
          <footer className="receipt-foot">
            <p className="receipt-thanks">{t('pay.receipt.thanks')} <span aria-hidden>♥</span></p>
            <Barcode value={r.id} label={`${t('pay.receipt.number')} ${r.id}`} />
            <span className="receipt-code" dir="ltr">{r.id}</span>
          </footer>
        </div>
      </article>
      <div className="receipt-actions">
        <button type="button" className="receipt-action" onClick={() => window.print()}>{t('pay.receipt.print')}</button>
        <button type="button" className="receipt-action" onClick={share}>{copied ? t('pay.receipt.copied') : t('pay.receipt.share')}</button>
      </div>
      {actions}
    </div>
  );
}

export function ReceiptPending({ title, note }: { title: string; note: string }) {
  return (
    <div className="receipt-stage">
      <article className="receipt-paper is-loading" aria-busy="true"><div className="receipt-body">
        <div className="receipt-spinner" aria-hidden />
        <p className="receipt-pending-title">{title}</p>
        <p className="receipt-note">{note}</p>
        <div className="receipt-skeleton" aria-hidden>{Array.from({ length: 7 }, (_, i) => <span key={i} />)}</div>
      </div></article>
    </div>
  );
}

export function ReceiptFailed({ title, note, action }: { title: string; note: string; action?: ReactNode }) {
  return (
    <div className="receipt-stage">
      <article className="receipt-paper is-failed"><div className="receipt-body">
        <div className="receipt-failed-mark" aria-hidden>!</div>
        <p className="receipt-pending-title">{title}</p>
        <p className="receipt-note">{note}</p>
        {action}
      </div></article>
    </div>
  );
}
