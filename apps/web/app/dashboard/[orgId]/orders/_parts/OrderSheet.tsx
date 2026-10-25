'use client';
import { useRef, useState } from 'react';
import type { OrderDetail } from '@resuto/contracts';
import { Badge, Notice, Phone, Sheet, Skeleton, UserText, usePrompt } from '@resuto/ui';
import { ApiRequestError, newIdempotencyKey } from '@/lib/api';
import { dateTime, money, pick, time } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { statusTone } from '../../../../t/[qr]/_guest/menu-ui';
import { cancellable, nextSteps } from './order-steps';

/**
 * One order in a sheet at the reading end (21-OPS; was a modal): status, payment, lines with their kitchen status,
 * totals, the next status steps, cash collection, cancel, and the history. Polls every 5 s while open.
 */
export function OrderSheet({ orderId, onClose, onChanged }: { orderId: string; onClose: () => void; onChanged: () => void }) {
  const { t, locale } = useT();
  const { org, can } = useOrg();
  const { call } = useSession();
  const detail = useApi<OrderDetail>(`/o/${org.id}/orders/${orderId}`, { pollMs: 5000 });
  const [error, setError] = useState<string | null>(null);
  const [refund, setRefund] = useState<{ paidMinor: number } | null>(null);
  const [pending, setPending] = useState(false);
  const collectKey = useRef(newIdempotencyKey());
  const o = detail.data;
  const [prompt, promptDialog] = usePrompt(locale);

  const run = async (fn: () => Promise<unknown>) => {
    setPending(true); setError(null);
    try { await fn(); await detail.reload(); onChanged(); }
    catch (e) {
      const err = e as ApiRequestError;
      if (err.code === 'refund_required') setRefund(err.details as { paidMinor: number });
      setError(err.message);
    } finally { setPending(false); }
  };

  const actions = o && (
    <div className="row order-sheet-actions">
      {can('orders:status') && nextSteps(o).map((to, i) => (
        <button key={to} className={`btn ${i === 0 ? 'btn-primary' : ''}`} disabled={pending}
          onClick={() => void run(() => call(`/o/${org.id}/orders/${o.id}/transition`, { body: { to, version: o.version } }))}>
          {t(`core.orders.to.${to}`)}
        </button>
      ))}
      {can('payments:collect') && o.dueMinor > 0 && o.status !== 'cancelled' && !o.visitId && (
        <button className="btn btn-leaf" disabled={pending} onClick={() => void run(async () => {
          await call(`/o/${org.id}/orders/${o.id}/collect`, { body: { method: 'cash' }, idempotencyKey: collectKey.current });
          collectKey.current = newIdempotencyKey();
        })}>{t('core.orders.collectCash', { amount: money(o.dueMinor, o.currency, locale) })}</button>
      )}
      {/* A counter ticket (FT-07) is paid as a whole: cash for every unpaid order of this guest's counter visit. */}
      {can('payments:collect') && o.dueMinor > 0 && o.status !== 'cancelled' && o.visitId && !o.tableId && (
        <button className="btn btn-leaf" disabled={pending} onClick={() => void run(async () => {
          await call(`/o/${org.id}/visits/${o.visitId}/collect`, { body: { method: 'cash' }, idempotencyKey: collectKey.current });
          collectKey.current = newIdempotencyKey();
        })}>{t('ops.counter.collectTicket')}</button>
      )}
      {can('orders:cancel') && cancellable(o.status) && (
        <button className="btn btn-danger" disabled={pending} onClick={async () => {
          const reason = await prompt({ title: t('core.orders.cancel'), label: t('core.orders.cancelReason'), minLength: 2, maxLength: 300, multiline: true, tone: 'danger', confirmLabel: t('core.orders.cancel') });
          if (reason) void run(() => call(`/o/${org.id}/orders/${o.id}/cancel`, { body: { reason, version: o.version } }));
        }}>{t('core.orders.cancel')}</button>
      )}
    </div>
  );

  return (
    <Sheet open onClose={onClose} size="md" title={o ? t('core.guest.orderNumber', { n: o.number }) : t('state.loading')}
      description={o ? `${t(`core.channel.${o.channel}`)} · ${t(`core.web.${o.fulfillment}`)} · ${dateTime(o.placedAt, locale, org.timezone)}` : undefined}
      footer={actions || undefined} className="order-sheet">
      {promptDialog}
      {!o ? (detail.error ? <Notice tone="danger">{detail.error.message}</Notice> : <Skeleton lines={5} />) : (
        <div className="stack">
          <div className="row">
            <Badge tone={statusTone(o.status)}>{t(`core.status.${o.status}`)}</Badge>
            <Badge tone={o.paymentStatus === 'paid' ? 'ok' : 'pay'}>{t(`core.payment.${o.paymentStatus}`)}</Badge>
            {o.tableLabel && <Badge>{t('core.kds.table', { label: o.tableLabel })}</Badge>}
          </div>
          {(o.customerName || o.customerPhone) && <p className="flush"><UserText>{o.customerName}</UserText>{o.customerName && o.customerPhone ? ' · ' : ''}<Phone value={o.customerPhone} link /></p>}
          {o.deliveryAddress != null && <p className="fine flush"><UserText>{String((o.deliveryAddress as { line1?: string }).line1 ?? '')}</UserText></p>}
          <div>
            {o.lines.map((l) => (
              <div key={l.id} className="spread ops-line">
                <span><strong className="num">{l.quantity}×</strong> {pick(locale, l.name, l.nameAr)}
                  {l.modifiers.length > 0 && <small className="fine"> · {l.modifiers.map((m) => m.option).join(', ')}</small>}
                  {l.notes && <small className="fine"> · “<UserText>{l.notes}</UserText>”</small>}
                  {' '}<Badge>{t(`core.kitchen.${l.kitchenStatus}`)}</Badge></span>
                <span className="num">{money(l.lineTotalMinor, o.currency, locale)}</span>
              </div>
            ))}
          </div>
          {o.notes && <Notice tone="warn"><UserText>{o.notes}</UserText></Notice>}
          <div className="spread"><span>{t('core.bill.total')}</span><strong className="num">{money(o.totalMinor, o.currency, locale)}</strong></div>
          <div className="spread fine"><span>{t('core.bill.paid')}</span><span className="num">{money(o.paidMinor - o.refundedMinor, o.currency, locale)}</span></div>
          {o.dueMinor > 0 && <div className="spread"><span>{t('core.bill.due')}</span><strong className="num">{money(o.dueMinor, o.currency, locale)}</strong></div>}
          {error && <Notice tone="danger">{error}</Notice>}
          {refund && <Notice tone="warn">{t('core.orders.refundFirst', { amount: money(refund.paidMinor, o.currency, locale) })}</Notice>}
          {o.visitId && o.dueMinor > 0 && <p className="fine">{t('core.orders.tableBillHint')}</p>}
          <details>
            <summary className="fine cursor-pointer">{t('core.orders.history')}</summary>
            <ol className="fine">
              {o.events.map((e) => <li key={e.id}><span className="num">{time(e.at, locale, org.timezone)}</span> · {e.to ? t(`core.status.${e.to}`) : e.type} · {e.actorType}</li>)}
              {o.payments.map((p) => <li key={p.id}>{t(`core.method.${p.method}`)} · <span className="num">{money(p.amountMinor, o.currency, locale)}</span> · {p.status}{p.isTest ? ` · ${t('state.sandbox')}` : ''}</li>)}
            </ol>
          </details>
        </div>
      )}
    </Sheet>
  );
}
