'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import type { ReceiptView } from '@resuto/contracts';
import { Badge, Card, DataTable, EmptyState, Field, Modal, Notice, PageHeader, Skeleton, useAction, OrderRef } from '@resuto/ui';
import { ModuleGate } from '@/components/shell/ModuleGate';
import { newIdempotencyKey } from '@/lib/api';
import { dateTime, isolate, money } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { paymentProviderLabel } from '@/lib/vocab';
import { Receipt } from '../../../../pay/[token]/_ui/Receipt';
import { statusTone } from '../tone';

export default function PaymentDetailPage() {
  const { paymentId } = useParams<{ paymentId: string }>();
  const { t, locale } = useT();
  const { org, can } = useOrg();
  const { call } = useSession();
  const { data: p, error, loading, reload } = useApi<any>(`/o/${org.id}/payments/${paymentId}`);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [key, setKey] = useState(newIdempotencyKey());
  const [receipt, setReceipt] = useState<ReceiptView | null>(null);
  const [lastRefund, setLastRefund] = useState<any>(null);
  const amountMinor = Math.round(Number(amount.replace(',', '.')) * 100);
  const refund = useAction(async () => {
    const r = await call(`/o/${org.id}/payments/${paymentId}/refunds`, { body: { amountMinor, reason, key } });
    setLastRefund(r); setKey(newIdempotencyKey()); setAmount(''); setReason(''); await reload();
  });
  const complete = useAction(async (id: string) => { await call(`/o/${org.id}/payments/refunds/${id}/complete`, { body: {} }); setLastRefund(null); await reload(); });
  // PAY-05/PAY-12: ask the provider about a pending or unconfirmed refund (never sends a second one blindly).
  const check = useAction(async (id: string) => { await call(`/o/${org.id}/payments/refunds/${id}/check`, { method: 'POST' }); await reload(); });
  const openReceipt = useAction(async () => setReceipt(await call<ReceiptView>(`/o/${org.id}/payments/${paymentId}/receipt`)));

  if (loading && !p) return <Skeleton lines={6} />;
  if (error || !p) return <ModuleGate module="pay"><Card><EmptyState title={t('pay.detail.notFound')}>{error?.message}</EmptyState></Card></ModuleGate>;
  const m = (v: number | null) => (v === null || v === undefined ? '—' : money(v, p.currency, locale));
  return (
    <ModuleGate module="pay" permission="payments:read">
      <PageHeader overline={<Link href={`/dashboard/${org.id}/payments`}>← {t('pay.dash.title')}</Link>} title={`${t('pay.detail.title')} · ${m(p.amountMinor)}`}
        subtitle={`${t(`pay.method.${p.method}`)} · ${isolate(paymentProviderLabel(t, p.provider))} · ${isolate(dateTime(p.capturedAt ?? p.createdAt, locale))}`}
        actions={<>
          <Badge tone={statusTone(p.status)}>{t(`pay.payment.status.${p.status}`)}</Badge>
          {p.isTest && <Badge tone="sandbox">{t('pay.dash.test')}</Badge>}
          {p.hasReceipt && <button className="btn" onClick={() => openReceipt.run()}>{t('pay.detail.receipt')}</button>}
        </>} />
      <div className="grid grid-2" style={{ alignItems: 'start' }}>
        <Card>
          <dl className="grid grid-3" style={{ margin: 0 }}>
            <div className="stat"><span>{t('pay.dash.col.amount')}</span><strong dir="ltr">{m(p.amountMinor)}</strong></div>
            <div className="stat"><span>{t('pay.detail.fee')}</span><strong dir="ltr">{m(p.feeMinor)}</strong></div>
            <div className="stat"><span>{t('pay.receipt.refunded')}</span><strong dir="ltr">{m(p.refundedMinor)}</strong></div>
          </dl>
          <p className="fine" dir="ltr">{p.providerPaymentId ?? p.id}{p.reference ? ` · ${p.reference}` : ''}</p>
          {p.failureReason && <Notice tone="warn">{p.failureReason}</Notice>}
          {p.checkoutSession && <p className="fine">{t('pay.detail.session')}: {t(`pay.purpose.${p.checkoutSession.purpose}`)} · {p.checkoutSession.channel} · {p.checkoutSession.status}</p>}
          <h3 style={{ marginTop: 16 }}>{t('pay.detail.allocations')}</h3>
          <DataTable rows={p.allocations} rowKey={(a: any) => String(a.id)} empty={<EmptyState title="—" />} columns={[
            { key: 'o', header: t('pay.dash.col.orders'), render: (a: any) => <OrderRef n={a.orderNumber} /> },
            { key: 'k', header: t('pay.dash.col.purpose'), render: (a: any) => a.kind },
            { key: 'a', header: t('pay.dash.col.amount'), align: 'end', render: (a: any) => <span dir="ltr">{m(a.amountMinor)}</span> },
          ]} />
        </Card>
        <Card title={t('pay.detail.refunds')}>
          {p.refunds.length > 0 && (
            <div className="stack" style={{ marginBottom: 16 }}>
              {p.refunds.map((r: any) => (
                <div key={r.id} className="spread" style={{ borderBottom: '1px solid var(--line-soft)', paddingBottom: 8 }}>
                  <div><strong dir="ltr">{m(r.amountMinor)}</strong> <span className="fine">{r.reason}</span>
                    {r.instructions && r.status === 'manual_required' && <p className="fine" style={{ margin: 0 }}>{r.instructions}</p>}
                    {r.outcomeUncertain && <p className="fine" style={{ margin: 0 }}>{t('pay.refund.uncertain')}</p>}
                    {r.failureReason && !r.outcomeUncertain && <p className="fine" dir="ltr" style={{ margin: 0, color: 'var(--danger)', textAlign: 'start' }}>{r.failureReason}</p>}</div>
                  <div className="row" style={{ gap: 6 }}>
                    <Badge tone={r.outcomeUncertain ? 'warn' : statusTone(r.status)}>{t(`pay.refund.status.${r.status}`)}</Badge>
                    {r.status === 'pending' && can('payments:refund') && <button className="btn btn-sm" disabled={check.pending} onClick={() => check.run(r.id)}>{t('pay.refund.check')}</button>}
                    {r.status === 'manual_required' && can('payments:refund') && <button className="btn btn-sm" disabled={complete.pending} onClick={() => complete.run(r.id)}>{t('pay.detail.complete')}</button>}
                  </div>
                </div>
              ))}
            </div>
          )}
          {complete.error && <Notice tone="danger">{complete.error}</Notice>}
          {check.error && <Notice tone="danger">{check.error}</Notice>}
          {can('payments:refund') && p.refundableMinor > 0 ? (
            <>
              <p className="fine">{t('pay.detail.refundable', { amount: m(p.refundableMinor) })} · {p.refundMode === 'provider' ? t('pay.detail.refundProvider', { provider: isolate(paymentProviderLabel(t, p.provider)) }) : t('pay.detail.refundManual')}</p>
              <Field label={t('pay.dash.col.amount')} inputMode="decimal" dir="ltr" value={amount} onChange={(e) => setAmount(e.target.value)} />
              <Field label={t('pay.detail.reason')} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
              {refund.error && <Notice tone="danger">{refund.error}</Notice>}
              {lastRefund?.status === 'manual_required' && <Notice tone="warn">{lastRefund.instructions}</Notice>}
              <button className="btn btn-danger" style={{ marginTop: 8 }} disabled={refund.pending || !(amountMinor > 0 && amountMinor <= p.refundableMinor) || !reason.trim()} onClick={() => refund.run()}>
                {t('pay.detail.submitRefund', { amount: amountMinor > 0 ? m(amountMinor) : '' })}
              </button>
            </>
          ) : !p.refunds.length && <p className="fine">{t('pay.dash.emptyRefunds')}</p>}
        </Card>
      </div>
      {openReceipt.error && <Notice tone="danger">{openReceipt.error}</Notice>}
      <Modal open={!!receipt} onClose={() => setReceipt(null)} title={t('pay.receipt.title')}>{receipt && <Receipt r={receipt} />}</Modal>
    </ModuleGate>
  );
}
