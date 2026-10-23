'use client';
// Active visits (VS-13), restored from the legacy "Active visits" tab: one card per open table visit with "Accepting
// orders" / "Billing locked", the bill total and what remains, and Close visit (only a manager is offered force-close
// for a visit that is not settled, after a styled confirm; others are told to settle the bill first). Pickup and delivery orders that are still open or unpaid are listed
// below them, as the legacy board listed off-site visits. Counter visits (FT-07: venue QR, no table) show their ticket
// number, and the cashier collects cash for the whole ticket here (recorded only when staff confirm the money is in).
import Link from 'next/link';
import { useRef, useState } from 'react';
import type { OrderSummary, VisitSummary } from '@resuto/contracts';
import { Badge, EmptyState, Notice, PageHeading, OrderRef, useConfirm } from '@resuto/ui';
import { useVisitActions } from '@/components/floor/LiveFloor';
import { formatWhen, money } from '@/lib/format';
import { newIdempotencyKey } from '@/lib/api';
import { useT } from '@/lib/i18n/client';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import './ops.css';

export function ActiveVisits({ orgId, branchId, timezone, canClose, canForce, ordersHref, canCollect = false }: {
  orgId: string; branchId: string; timezone: string; canClose: boolean; canForce: boolean; ordersHref: string | null; canCollect?: boolean;
}) {
  const { t, locale } = useT();
  const { call } = useSession();
  const [confirmCash, cashDialog] = useConfirm(locale);
  const [cash, setCash] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  const [collecting, setCollecting] = useState<string | null>(null);
  // One key per collection intent: a retried click after a lost response cannot record the cash twice.
  const cashKey = useRef<Record<string, string>>({});
  const visits = useApi<{ items: VisitSummary[] }>(`/o/${orgId}/visits?branchId=${branchId}`, { pollMs: 5000 });
  const offsite = useApi<{ items: OrderSummary[] }>(`/o/${orgId}/orders?branchId=${branchId}&status=placed,accepted,preparing,ready&limit=50`, { pollMs: 5000 });
  const { busy, confirmDialog, close } = useVisitActions(orgId, canForce, () => visits.reload());

  const off = (offsite.data?.items ?? []).filter((o) => o.fulfillment !== 'dine_in' && !(o.visitId && !o.tableId));
  const ticket = (v: VisitSummary) => (v.ticket ? <OrderRef n={v.ticket.padStart(3, '0')} /> : null);
  const collect = async (v: VisitSummary) => {
    const amount = money(v.dueMinor, v.currency, locale);
    const label = v.ticket ? v.ticket.padStart(3, '0') : '';
    if (collecting || !(await confirmCash({ title: t('ops.counter.collectTitle', { ticket: label }), body: t('ops.counter.collectBody', { amount }), confirmLabel: t('ops.counter.collect', { amount }) }))) return;
    setCollecting(v.id); setCash(null);
    const key = (cashKey.current[v.id] ??= newIdempotencyKey());
    try {
      await call(`/o/${orgId}/visits/${v.id}/collect`, { body: { method: 'cash', amountMinor: v.dueMinor }, idempotencyKey: key });
      delete cashKey.current[v.id];
      setCash({ tone: 'ok', text: t('ops.counter.collected', { ticket: label }) });
      await visits.reload();
    } catch (e) { setCash({ tone: 'danger', text: (e as Error).message }); } finally { setCollecting(null); }
  };
  return (
    <div className="stack">
      {confirmDialog}
      {cashDialog}
      <PageHeading title={t('ops.visits.title')} subtitle={t('ops.visits.subtitle')} />
      {visits.error && <Notice tone="danger">{visits.error.message}</Notice>}
      {cash && <Notice tone={cash.tone}>{cash.text}</Notice>}
      {!visits.data ? <div className="visit-cards"><div className="skeleton ops-skel" /><div className="skeleton ops-skel" /></div>
        : visits.data.items.length === 0 ? <section className="panel"><EmptyState title={t('ops.visits.emptyTitle')}>{t('ops.visits.emptyBody')}</EmptyState></section>
        : (
          <div className="visit-cards">
            {visits.data.items.map((v) => (
              <section key={v.id} className="panel visit-card">
                <div className="table-title"><h2>{v.kind === 'counter' ? (v.ticket ? <>{t('ops.kds.counter')} {ticket(v)}</> : t('ops.counter.noOrder')) : v.tableLabel ?? t('ops.visits.offsite')}</h2>
                  <Badge tone={v.billingLocked ? 'pay' : 'ok'}>{v.billingLocked ? t('ops.visits.locked') : t('ops.visits.accepting')}</Badge></div>
                <h3>{v.kind === 'counter' ? t('ops.counter.takeaway') : v.guestName ? <bdi>{v.guestName}</bdi> : v.partySize ? t('ops.floor.party', { n: v.partySize }) : t('ops.floor.seatedGuests')}</h3>
                <p className="fine">{t(v.kind === 'counter' ? 'ops.counter.hint' : 'ops.visits.qrHint')} · <span className="num">{formatWhen(v.openedAt, locale, timezone)}</span></p>
                <div className="bill-row"><span>{t('ops.visits.billTotal')}</span><strong className="num">{money(v.totalMinor, v.currency, locale)}</strong></div>
                <div className="bill-row"><span>{t('ops.floor.remaining')}</span><strong className="num">{money(v.dueMinor, v.currency, locale)}</strong></div>
                {v.openOrders > 0 && <p className="fine">{t('ops.visits.openOrders', { n: v.openOrders })}</p>}
                {v.kind === 'counter' && canCollect && v.dueMinor > 0 && !v.billingLocked && (
                  <button type="button" className="btn btn-primary" disabled={collecting === v.id} onClick={() => void collect(v)}>
                    {t('ops.counter.collect', { amount: money(v.dueMinor, v.currency, locale) })}</button>
                )}
                {canClose && <button type="button" className="btn" disabled={busy} onClick={() => void close({ visitId: v.id, label: v.tableLabel ?? (v.ticket ? t('ops.counter.ticket', { ticket: v.ticket.padStart(3, '0') }) : t('ops.counter.noOrder')) })}>{t('ops.floor.closeVisit')}</button>}
              </section>
            ))}
          </div>
        )}
      {off.length > 0 && (
        <section className="panel">
          <div className="panel-head"><h2>{t('ops.visits.offsiteTitle')}</h2></div>
          <div className="panel-body">
            {off.map((o) => (
              <div key={o.id} className="host-row">
                <span><strong><OrderRef n={o.number} /> · {t(`core.web.${o.fulfillment}`)}</strong><small>{o.customerName ? <bdi>{o.customerName}</bdi> : null} {t(`core.status.${o.status}`)} · <span className="num">{formatWhen(o.placedAt, locale, timezone)}</span></small></span>
                <span className="row"><b className="num">{money(o.dueMinor, o.currency, locale)}</b>{ordersHref && <Link className="btn btn-sm" href={ordersHref}>{t('ops.kds.openOrders')}</Link>}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
