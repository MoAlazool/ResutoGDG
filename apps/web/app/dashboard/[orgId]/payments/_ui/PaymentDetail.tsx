'use client';
import { useState } from 'react';
import type { ReceiptView } from '@resuto/contracts';
import { Badge, Card, DataTableV2, EmptyState, Field, Notice, OrderRef, Skeleton, Timeline, useAction, type TimelineItem } from '@resuto/ui';
import { newIdempotencyKey } from '@/lib/api';
import { dateTime, isolate, money } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { paymentProviderLabel } from '@/lib/vocab';
import { Receipt } from '../../../../pay/[token]/_ui/Receipt';
import styles from '../payments.module.css';
import { refundTone, statusTone } from '../tone';

export interface PaymentDetailView {
  id: string; amountMinor: number; feeMinor: number | null; refundedMinor: number; currency: string; method: string; provider: string; status: string;
  isTest: boolean; capturedAt: string | null; createdAt: string; providerPaymentId: string | null; reference: string | null; failureReason: string | null;
  checkoutSession: { purpose: string; channel: string; status: string } | null;
  allocations: Array<{ id: number; orderNumber: string; kind: string; amountMinor: number }>;
  refunds: Array<{ id: string; amountMinor: number; reason: string; status: string; outcomeUncertain: boolean; instructions: string | null; failureReason: string | null;
    source: string; createdAt: string; completedAt: string | null; lastCheckedAt: string | null }>;
  refundableMinor: number; refundMode: 'provider' | 'manual' | null; hasReceipt: boolean;
}

/**
 * One payment: amounts, the orders it paid, its history (capture, then each refund with its real state) and the refund
 * form. Refund safety is the API's (ResutoPay): every request carries an idempotency key, the amount is bounded by
 * what is refundable, a provider refund that is not confirmed stays "pending" (or "not confirmed yet" while its outcome
 * is uncertain) and is only ever checked, never resent; cash and other manual refunds need instructions and a manual
 * completion. Used by the payment sheet on the list and by the payment page.
 */
export function PaymentDetail({ paymentId, onChanged }: { paymentId: string; onChanged?: () => void }) {
  const { t, locale } = useT();
  const { org, can } = useOrg();
  const { call } = useSession();
  const { data: p, error, loading, reload } = useApi<PaymentDetailView>(`/o/${org.id}/payments/${paymentId}`);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [key, setKey] = useState(newIdempotencyKey());
  const [receipt, setReceipt] = useState<ReceiptView | null>(null);
  const [lastRefund, setLastRefund] = useState<{ status: string; instructions?: string | null } | null>(null);
  const amountMinor = Math.round(Number(amount.replace(',', '.')) * 100);
  const changed = async () => { await reload(); onChanged?.(); };
  const refund = useAction(async () => {
    const r = await call<{ status: string; instructions?: string | null }>(`/o/${org.id}/payments/${paymentId}/refunds`, { body: { amountMinor, reason, key } });
    setLastRefund(r); setKey(newIdempotencyKey()); setAmount(''); setReason(''); await changed();
  });
  const complete = useAction(async (id: string) => { await call(`/o/${org.id}/payments/refunds/${id}/complete`, { body: {} }); setLastRefund(null); await changed(); });
  // PAY-05/PAY-12: ask the provider about a pending or unconfirmed refund (never sends a second one blindly).
  const check = useAction(async (id: string) => { await call(`/o/${org.id}/payments/refunds/${id}/check`, { method: 'POST' }); await changed(); });
  const openReceipt = useAction(async () => setReceipt(await call<ReceiptView>(`/o/${org.id}/payments/${paymentId}/receipt`)));

  if (loading && !p) return <Skeleton lines={6} />;
  if (error || !p) return <EmptyState title={t('pay.detail.notFound')}>{error?.message}</EmptyState>;
  const m = (v: number | null | undefined) => (v === null || v === undefined ? '—' : money(v, p.currency, locale));
  const history: TimelineItem[] = [
    { id: 'payment', tone: timelineTone(statusTone(p.status)), time: p.capturedAt ?? p.createdAt, timeLabel: dateTime(p.capturedAt ?? p.createdAt, locale),
      title: t('pay.timeline.captured', { status: t(`pay.payment.status.${p.status}`), amount: m(p.amountMinor) }),
      description: <>{t(`pay.method.${p.method}`)} · <bdi>{paymentProviderLabel(t, p.provider)}</bdi></> },
    ...p.refunds.map((r): TimelineItem => ({
      id: r.id, tone: refundTone(r), time: r.createdAt, timeLabel: dateTime(r.createdAt, locale),
      title: t('pay.timeline.refund', { status: t(`pay.refund.status.${r.status}`), amount: m(r.amountMinor) }),
      description: (
        <span className={styles.refundNotes} data-refund={r.status} data-uncertain={r.outcomeUncertain ? '' : undefined}>
          <span><UserReason text={r.reason} /></span>
          {r.outcomeUncertain && <span>{t('pay.refund.uncertain')}</span>}
          {r.instructions && r.status === 'manual_required' && <span>{r.instructions}</span>}
          {r.failureReason && !r.outcomeUncertain && <span className={styles.failure} dir="ltr">{r.failureReason}</span>}
          {r.source && r.source !== 'resuto' && <span>{t(`pay.refund.source.${r.source}`)}</span>}
          {r.completedAt && <span>{t('pay.timeline.completedAt', { at: dateTime(r.completedAt, locale) })}</span>}
          {r.lastCheckedAt && r.status === 'pending' && <span>{t('pay.timeline.checkedAt', { at: dateTime(r.lastCheckedAt, locale) })}</span>}
        </span>
      ),
    })),
  ];
  const actionable = p.refunds.filter((r) => can('payments:refund') && (r.status === 'pending' || r.status === 'manual_required'));
  return (
    <div className="stack" data-testid="payment-detail">
      <div className={styles.badges}>
        <Badge tone={statusTone(p.status)}>{t(`pay.payment.status.${p.status}`)}</Badge>
        {p.isTest && <Badge tone="sandbox">{t('pay.dash.test')}</Badge>}
        {p.hasReceipt && <button className="btn btn-sm" aria-busy={openReceipt.pending || undefined} onClick={() => { if (!openReceipt.pending) void openReceipt.run(); }}>{t('pay.detail.receipt')}</button>}
      </div>
      <dl className={styles.figures}>
        <div><dt>{t('pay.dash.col.amount')}</dt><dd className="num" dir="ltr">{m(p.amountMinor)}</dd></div>
        <div><dt>{t('pay.detail.fee')}</dt><dd className="num" dir="ltr">{m(p.feeMinor)}</dd></div>
        <div><dt>{t('pay.receipt.refunded')}</dt><dd className="num" dir="ltr">{m(p.refundedMinor)}</dd></div>
      </dl>
      <p className="fine m-0" dir="ltr">{p.providerPaymentId ?? p.id}{p.reference ? ` · ${p.reference}` : ''}</p>
      {p.failureReason && <Notice tone="warn">{p.failureReason}</Notice>}
      {p.checkoutSession && <p className="fine m-0">{t('pay.detail.session')}: {t(`pay.purpose.${p.checkoutSession.purpose}`)} · {p.checkoutSession.channel} · {p.checkoutSession.status}</p>}
      {openReceipt.error && <Notice tone="danger">{openReceipt.error}</Notice>}
      {receipt && <Card title={t('pay.receipt.title')} actions={<button className="btn btn-sm btn-ghost" onClick={() => setReceipt(null)}>{t('action.close')}</button>}><Receipt r={receipt} /></Card>}

      <section aria-labelledby={`pay-${p.id}-alloc`}>
        <h3 id={`pay-${p.id}-alloc`}>{t('pay.detail.allocations')}</h3>
        <DataTableV2 label={t('pay.detail.allocations')} rows={p.allocations} rowKey={(a) => String(a.id)} empty={<EmptyState title="—" />} columns={[
          { key: 'o', header: t('pay.dash.col.orders'), render: (a) => <OrderRef n={a.orderNumber} /> },
          { key: 'k', header: t('pay.dash.col.purpose'), render: (a) => a.kind },
          { key: 'a', header: t('pay.dash.col.amount'), align: 'end', render: (a) => <span className="num" dir="ltr">{m(a.amountMinor)}</span> },
        ]} />
      </section>

      <section aria-labelledby={`pay-${p.id}-history`} data-testid="refund-timeline">
        <h3 id={`pay-${p.id}-history`}>{t('pay.sheet.timeline')}</h3>
        <Timeline items={history} />
        {p.refunds.length === 0 && <p className="fine m-0">{t('pay.timeline.empty')}</p>}
        {actionable.length > 0 && (
          <div className={styles.refundActions}>
            {actionable.map((r) => r.status === 'pending'
              ? <button key={r.id} className="btn btn-sm" aria-busy={check.pending || undefined} onClick={() => { if (!check.pending) void check.run(r.id); }}>{t('pay.refund.check')} · <span className="num">{m(r.amountMinor)}</span></button>
              : <button key={r.id} className="btn btn-sm" aria-busy={complete.pending || undefined} onClick={() => { if (!complete.pending) void complete.run(r.id); }}>{t('pay.detail.complete')} · <span className="num">{m(r.amountMinor)}</span></button>)}
          </div>
        )}
        {complete.error && <Notice tone="danger">{complete.error}</Notice>}
        {check.error && <Notice tone="danger">{check.error}</Notice>}
      </section>

      {can('payments:refund') && p.refundableMinor > 0 && (
        <form className={styles.refundForm} aria-labelledby={`pay-${p.id}-refund`} onSubmit={(e) => { e.preventDefault(); if (!refund.pending) void refund.run(); }}>
          <h3 id={`pay-${p.id}-refund`}>{t('pay.detail.refund')}</h3>
          <p className="fine m-0">{t('pay.detail.refundable', { amount: m(p.refundableMinor) })} · {p.refundMode === 'provider' ? t('pay.detail.refundProvider', { provider: isolate(paymentProviderLabel(t, p.provider)) }) : t('pay.detail.refundManual')}</p>
          <Field label={t('pay.dash.col.amount')} inputMode="decimal" dir="ltr" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <Field label={t('pay.detail.reason')} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
          {refund.error && <Notice tone="danger">{refund.error}</Notice>}
          {lastRefund?.status === 'manual_required' && <Notice tone="warn">{lastRefund.instructions}</Notice>}
          {lastRefund?.status === 'pending' && <Notice tone="warn">{t('pay.alert.refundPending')}</Notice>}
          <div>
            <button className="btn btn-danger" disabled={refund.pending || !(amountMinor > 0 && amountMinor <= p.refundableMinor) || !reason.trim()}>
              {t('pay.detail.submitRefund', { amount: amountMinor > 0 ? m(amountMinor) : '' })}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function UserReason({ text }: { text: string }) { return <bdi>{text}</bdi>; }

const timelineTone = (tone: string): TimelineItem['tone'] => (['ok', 'warn', 'danger', 'pay', 'info'].includes(tone) ? tone as TimelineItem['tone'] : 'neutral');
