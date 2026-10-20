'use client';
// "Split & pay" (legacy guest.js billSheet()/splitChooser()/splitForm()/splitMarkup(), platform.css .bill-choice and
// .share-row): Total / Reservation deposit / Paid / Remaining with a progress bar, Pay full bill | Split bill, the
// share rows with their links, and the receipts. Payment always goes through the hosted checkout; nothing here marks
// anything paid — the bill reflects only what the server has recorded.
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { parseMajor, planSplit, SplitRuleError, type BillUnit, type SplitShareView } from '@resuto/contracts';
import { api, ApiRequestError } from '@/lib/api';
import { visitHeaders, type GuestVisit } from '@/lib/guest-visit';
import { useT } from '@/lib/i18n/client';
import { formatWhen, money, pick } from '@/lib/format';
import { clearIntent, intentKey, safeRedirect } from '@/app/pay/[token]/_ui/PayFrame';
import type { BillView } from '@/app/t/[qr]/pay/bill';
import { billStage } from './bill-state';
import { MoneyRow, Sheet } from './shell';

export type SplitMode = 'equal' | 'items' | 'custom';

/** Server default labels ("Guest 3") are shown localised; names typed by guests are shown as typed. */
const shareName = (label: string, i: number, t: (k: string, v?: Record<string, string | number>) => string) => {
  const m = /^Guest (\d+)$/.exec(label);
  return m ? t('core.bill.form.share', { index: m[1]! }) : label || t('core.bill.form.share', { index: i + 1 });
};

export function BillSummary({ bill }: { bill: BillView }) {
  const { t, locale } = useT();
  const m = (v: number) => money(v, bill.currency, locale);
  const covered = Math.min(bill.totals.totalMinor, bill.totals.paidMinor + bill.totals.creditMinor);
  const pct = bill.totals.totalMinor > 0 ? Math.round((covered / bill.totals.totalMinor) * 100) : 0;
  return (
    <div>
      <MoneyRow label={t('core.bill.total')} value={m(bill.totals.totalMinor)} />
      {bill.totals.creditMinor > 0 && <MoneyRow label={t('core.bill.depositCredit')} value={m(bill.totals.creditMinor)} />}
      <MoneyRow label={t('core.bill.paid')} value={m(bill.totals.paidMinor)} />
      <MoneyRow label={t('core.bill.remaining')} value={m(bill.totals.dueMinor)} />
      <div className="gx-progress" role="progressbar" aria-label={t('core.bill.progress')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <span style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function ShareRows({ shares, currency, mode, onQr }: { shares: SplitShareView[]; currency: string; mode: string; onQr: (s: SplitShareView) => void }) {
  const { t, locale } = useT();
  const [copied, setCopied] = useState<string | null>(null);
  async function copy(url: string) {
    try { await navigator.clipboard.writeText(url); setCopied(url); } catch { /* clipboard blocked */ }
  }
  async function share(s: SplitShareView, name: string) {
    try {
      if (navigator.share) await navigator.share({ title: `${t('pay.invite.yourShare')} · ${name}`, url: s.url });
      else await copy(s.url);
    } catch { /* dismissed */ }
  }
  return (
    <div>
      <p className="gx-fine">{t('core.bill.share.private')} · {t(`core.bill.share.mode.${mode}`)}</p>
      {shares.filter((s) => s.status !== 'void').map((s, i) => {
        const name = shareName(s.label, i, t);
        const paid = s.status === 'paid';
        return (
          <div key={s.id} className="gx-share-row">
            <span className={`gx-avatar${paid ? ' is-paid' : ''}`} aria-hidden>{paid ? '✓' : i + 1}</span>
            <div><strong><bdi>{name}</bdi></strong><small><bdi>{money(s.amountMinor, currency, locale)}</bdi> · {paid ? t('core.bill.share.paid') : t('core.bill.share.pending')}</small></div>
            {!paid && (
              <div className="gx-share-actions">
                <a className="gx-link" href={s.url}>{t('core.bill.share.pay')}</a>
                <button type="button" className="gx-link" onClick={() => onQr(s)}>{t('core.bill.share.qr')}</button>
                <button type="button" className="gx-link" onClick={() => void copy(s.url)}>{copied === s.url ? t('core.bill.share.copied') : t('core.bill.share.copy')}</button>
                <button type="button" className="gx-link" onClick={() => void share(s, name)}>{t('core.bill.share.share')}</button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function ShareQr({ share, onClose }: { share: SplitShareView; onClose: () => void }) {
  const { t } = useT();
  const [svg, setSvg] = useState<string | null>(null);
  // The QR encoder is loaded only when a guest opens a share's QR (it is not needed to read or pay the bill).
  useEffect(() => {
    let live = true;
    void import('qrcode').then((m) => m.default.toString(share.url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })).then((v) => { if (live) setSvg(v); });
    return () => { live = false; };
  }, [share.url]);
  return (
    <Sheet title={t('core.bill.share.qrTitle')} onClose={onClose}>
      {/* SVG generated locally by the qrcode library from our own share URL. */}
      <div className="gx-qr" dangerouslySetInnerHTML={{ __html: svg ?? '' }} />
      <p className="gx-fine">{t('core.bill.share.qrNote')}</p>
    </Sheet>
  );
}

/**
 * The bill body shared by the table sheet and /t/[qr]/pay. `onSplit` opens the split chooser; `onRate` the rating
 * sheet once the bill is settled and not yet rated.
 */
export function BillPanel({ bill, visit, rated, onSplit, onRate, onChanged, onReceipt }: {
  bill: BillView; visit: GuestVisit; rated: boolean; onSplit: () => void; onRate: () => void; onChanged: () => void; onReceipt: (paymentId: string) => void;
}) {
  const { t, locale } = useT();
  const [qr, setQr] = useState<SplitShareView | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [partial, setPartial] = useState('');
  const m = (v: number) => money(v, bill.currency, locale);
  const stage = billStage(bill);
  const split = bill.split && bill.split.status !== 'cancelled' ? bill.split : null;
  const scope = `bill:${bill.visitId}`;
  const partialMinor = (() => { try { return partial.trim() ? parseMajor(partial.trim().replace(',', '.'), bill.currency as 'EGP' | 'SAR') : 0; } catch { return 0; } })();

  async function pay(amountMinor?: number) {
    setPending(true);
    setError(null);
    const k = `${scope}:${amountMinor ?? 'full'}`;
    try {
      const r = await api<{ url: string }>('/public/payments/visit/checkout', { headers: visitHeaders(visit), body: { key: intentKey(k), ...(amountMinor ? { amountMinor } : {}) } });
      clearIntent(k);
      safeRedirect(r.url);
    } catch (e) {
      setError((e as ApiRequestError).message);
      setPending(false);
    }
  }
  async function cancelSplit() {
    try { await api('/public/payments/visit/split/cancel', { method: 'POST', headers: visitHeaders(visit) }); onChanged(); } catch (e) { setError((e as Error).message); }
  }

  // VP-18: an empty table is not "fully paid" — there is simply nothing to pay yet.
  if (stage === 'empty') {
    return <div className="gx-empty" style={{ padding: '30px 0' }}><h2>{t('core.bill.nothingTitle')}</h2><p>{t('core.bill.nothingBody')}</p></div>;
  }
  return (
    <div>
      <BillSummary bill={bill} />
      {split && <ShareRows shares={split.shares} currency={bill.currency} mode={split.mode} onQr={setQr} />}
      {split && split.status === 'open' && !split.shares.some((s) => s.paidMinor > 0) && (
        <button type="button" className="gx-link" style={{ marginTop: 8 }} onClick={() => void cancelSplit()}>{t('core.bill.share.cancel')}</button>
      )}
      {bill.pendingCheckout?.url && (
        <>
          <p className="gx-note is-warn">{t('pay.bill.pending')}</p>
          <button type="button" className="gx-btn is-block" onClick={() => safeRedirect(bill.pendingCheckout!.url!)}>{t('core.bill.resume')}</button>
        </>
      )}
      {!split && stage === 'due' && (
        <>
          <div className="gx-bill-choice">
            <button type="button" className="gx-btn is-primary" disabled={pending} onClick={() => void pay()}>{pending ? t('core.bill.redirecting') : t('core.bill.payFull')}</button>
            <button type="button" className="gx-btn" disabled={pending} onClick={onSplit}>{t('core.bill.split')}</button>
          </div>
          <details>
            <summary className="gx-fine" style={{ cursor: 'pointer' }}>{t('pay.bill.payAmount')}</summary>
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', marginTop: 8 }}>
              <label className="gx-field" style={{ flex: 1, margin: 0 }}><span>{t('pay.bill.amount')}</span>
                <input inputMode="decimal" dir="ltr" value={partial} onChange={(e) => setPartial(e.target.value)} /></label>
              <button type="button" className="gx-btn" disabled={pending || !(partialMinor > 0 && partialMinor <= bill.totals.dueMinor)} onClick={() => void pay(partialMinor)}>{t('pay.continue')}</button>
            </div>
          </details>
          <p className="gx-fine">{t('pay.bill.payCash')}</p>
        </>
      )}
      {stage === 'settled' && (
        <>
          <div className="gx-settled">✓ {t('core.bill.settled')}</div>
          {rated ? <p className="gx-fine" style={{ textAlign: 'center' }}>{t('core.guest.rate.done')}</p>
            : <button type="button" className="gx-btn is-block" onClick={onRate}>{t('core.guest.rate.title')}</button>}
        </>
      )}
      {error && <p className="gx-note is-danger" role="alert">{error}</p>}
      {bill.receipts.length > 0 && (
        <section style={{ marginTop: 18 }}>
          <h3 style={{ fontSize: 16 }}>{t('core.bill.receipts')}</h3>
          <div className="gx-receipt-list">
            {bill.receipts.map((r) => (
              <button key={r.paymentId} type="button" className="gx-receipt-item" onClick={() => onReceipt(r.paymentId)}>
                <span><strong>{r.share ? t('core.bill.receipt.share') : t('core.bill.receipt.bill')}</strong><small>{formatWhen(r.at, locale)}</small></span>
                <b><bdi>{m(r.amountMinor)}</bdi></b>
              </button>
            ))}
          </div>
        </section>
      )}
      {qr && <ShareQr share={qr} onClose={() => setQr(null)} />}
    </div>
  );
}

export function SplitChooser({ onPick, onClose }: { onPick: (m: SplitMode) => void; onClose: () => void }) {
  const { t } = useT();
  return (
    <Sheet title={t('core.bill.split')} onClose={onClose}>
      <div className="gx-method-picker">
        {(['equal', 'items', 'custom'] as const).map((m) => <button key={m} type="button" className="gx-btn is-block" onClick={() => onPick(m)}>{t(`core.bill.chooser.${m}`)}</button>)}
      </div>
      <p className="gx-fine">{t('core.bill.chooser.note')}</p>
    </Sheet>
  );
}

/** The split form (legacy splitForm): people and optional names; custom amounts; or who had each item. */
export function SplitForm({ mode, bill, visit, onClose, onCreated }: {
  mode: SplitMode; bill: BillView; visit: GuestVisit; onClose: () => void; onCreated: () => void;
}) {
  const { t, locale } = useT();
  const currency = bill.currency as 'EGP' | 'SAR';
  const [people, setPeople] = useState(mode === 'equal' ? 4 : 2);
  const [names, setNames] = useState('');
  const [amounts, setAmounts] = useState('');
  const [owner, setOwner] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const units: Array<BillUnit & { label: string }> = useMemo(() => bill.orders.filter((o) => o.status !== 'cancelled').flatMap((o) => o.lines.flatMap((l) =>
    Array.from({ length: l.quantity }, (_, u) => ({ lineId: l.id, unit: u, amountMinor: l.lineTotalMinor / l.quantity, name: l.name, label: pick(locale, l.name, l.nameAr) })))), [bill, locale]);
  const labels = names.split('\n').map((n) => n.trim()).slice(0, 20);
  const amountList = amounts.split(/\r?\n|[,،]/).map((x) => x.trim()).filter(Boolean).map((x) => { try { return parseMajor(x.replace('٫', '.'), currency); } catch { return NaN; } });
  const count = mode === 'custom' ? amountList.length : people;
  const request = mode === 'equal' ? { mode, people } : mode === 'custom' ? { mode, amounts: amountList }
    : { mode, allocations: Array.from({ length: people }, (_, i) => ({ items: units.filter((u) => (owner[`${u.lineId}:${u.unit}`] ?? (units.indexOf(u) % people)) === i).map((u) => ({ lineId: u.lineId, unit: u.unit })) })) };
  // Same arithmetic as the API (contracts planSplit): the preview is what the server will create.
  const preview = (() => { try { return planSplit(bill.totals.dueMinor, request, units).amounts; } catch (e) { if (e instanceof SplitRuleError) return null; throw e; } })();

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!preview) { setError(mode === 'custom' ? t('core.bill.form.mustMatch', { amount: money(bill.totals.dueMinor, currency, locale) }) : t('core.bill.form.assignAll')); return; }
    setBusy(true);
    setError(null);
    const scope = `split:${bill.visitId}:${JSON.stringify(request)}`;
    const shareLabels = Array.from({ length: count }, (_, i) => labels[i] ?? '');
    try {
      await api('/public/payments/visit/split', { headers: visitHeaders(visit), body: {
        ...request, labels: shareLabels,
        ...(mode === 'items' ? { allocations: (request as { allocations: Array<{ items: unknown[] }> }).allocations.map((a, i) => ({ ...a, label: shareLabels[i] || null })) } : {}),
        key: intentKey(scope) } });
      clearIntent(scope);
      onCreated();
    } catch (err) {
      setError((err as ApiRequestError).message);
      setBusy(false);
    }
  }

  const title = t(`core.bill.chooser.${mode}`);
  return (
    <Sheet title={title} onClose={onClose}>
      <form onSubmit={submit}>
        {mode !== 'custom' && (
          <label className="gx-field"><span>{t('core.bill.form.people')}</span>
            <input type="number" inputMode="numeric" min={2} max={20} required value={people} onChange={(e) => setPeople(Math.max(2, Math.min(20, Number(e.target.value) || 2)))} dir="ltr" /></label>
        )}
        {mode === 'custom' && (
          <label className="gx-field"><span>{t('core.bill.form.amounts', { currency })}</span>
            <textarea required value={amounts} onChange={(e) => setAmounts(e.target.value)} dir="ltr" placeholder={'300\n300\n300\n300'} /></label>
        )}
        <label className="gx-field"><span>{t('core.bill.form.names')}</span>
          <textarea value={names} onChange={(e) => setNames(e.target.value)} dir="auto" /></label>
        {mode === 'items' && (
          <div className="gx-allocation">
            {units.map((u, idx) => {
              const k = `${u.lineId}:${u.unit}`;
              return (
                <label key={k}><span>{u.label} · <bdi>{money(u.amountMinor, currency, locale)}</bdi></span>
                  <select value={owner[k] ?? idx % people} onChange={(e) => setOwner((o) => ({ ...o, [k]: Number(e.target.value) }))}>
                    {Array.from({ length: people }, (_, i) => <option key={i} value={i}>{labels[i] || t('core.bill.form.share', { index: i + 1 })}</option>)}
                  </select>
                </label>
              );
            })}
            <p className="gx-fine">{t('core.bill.form.assignAll')}</p>
          </div>
        )}
        {mode === 'custom' && <p className="gx-fine">{t('core.bill.form.mustMatch', { amount: money(bill.totals.dueMinor, currency, locale) })}</p>}
        {preview && (
          <div style={{ marginBlock: 10 }}>
            {preview.map((a, i) => <MoneyRow key={i} fine label={<bdi>{labels[i] || t('core.bill.form.share', { index: i + 1 })}</bdi>} value={money(a, currency, locale)} />)}
          </div>
        )}
        {error && <p className="gx-note is-danger" role="alert">{error}</p>}
        <button className="gx-btn is-primary is-block" disabled={busy || !preview}>{t('core.bill.form.create')}</button>
      </form>
    </Sheet>
  );
}
