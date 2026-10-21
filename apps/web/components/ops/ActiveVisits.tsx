'use client';
// Active visits (VS-13), restored from the legacy "Active visits" tab: one card per open table visit with "Accepting
// orders" / "Billing locked", the bill total and what remains, and Close visit (only a manager is offered force-close
// for a visit that is not settled, after a styled confirm; others are told to settle the bill first). Pickup and delivery orders that are still open or unpaid are listed
// below them, as the legacy board listed off-site visits.
import Link from 'next/link';
import type { OrderSummary, VisitSummary } from '@resuto/contracts';
import { Badge, EmptyState, Notice, PageHeading, OrderRef } from '@resuto/ui';
import { useVisitActions } from '@/components/floor/LiveFloor';
import { formatWhen, money } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useApi } from '@/lib/use-api';
import './ops.css';

export function ActiveVisits({ orgId, branchId, timezone, canClose, canForce, ordersHref }: {
  orgId: string; branchId: string; timezone: string; canClose: boolean; canForce: boolean; ordersHref: string | null;
}) {
  const { t, locale } = useT();
  const visits = useApi<{ items: VisitSummary[] }>(`/o/${orgId}/visits?branchId=${branchId}`, { pollMs: 5000 });
  const offsite = useApi<{ items: OrderSummary[] }>(`/o/${orgId}/orders?branchId=${branchId}&status=placed,accepted,preparing,ready&limit=50`, { pollMs: 5000 });
  const { busy, confirmDialog, close } = useVisitActions(orgId, canForce, () => visits.reload());

  const off = (offsite.data?.items ?? []).filter((o) => o.fulfillment !== 'dine_in');
  return (
    <div className="stack">
      {confirmDialog}
      <PageHeading title={t('ops.visits.title')} subtitle={t('ops.visits.subtitle')} />
      {visits.error && <Notice tone="danger">{visits.error.message}</Notice>}
      {!visits.data ? <div className="visit-cards"><div className="skeleton ops-skel" /><div className="skeleton ops-skel" /></div>
        : visits.data.items.length === 0 ? <section className="panel"><EmptyState title={t('ops.visits.emptyTitle')}>{t('ops.visits.emptyBody')}</EmptyState></section>
        : (
          <div className="visit-cards">
            {visits.data.items.map((v) => (
              <section key={v.id} className="panel visit-card">
                <div className="table-title"><h2>{v.tableLabel ?? t('ops.visits.offsite')}</h2>
                  <Badge tone={v.billingLocked ? 'pay' : 'ok'}>{v.billingLocked ? t('ops.visits.locked') : t('ops.visits.accepting')}</Badge></div>
                <h3>{v.guestName ? <bdi>{v.guestName}</bdi> : v.partySize ? t('ops.floor.party', { n: v.partySize }) : t('ops.floor.seatedGuests')}</h3>
                <p className="fine">{t('ops.visits.qrHint')} · <span className="num">{formatWhen(v.openedAt, locale, timezone)}</span></p>
                <div className="bill-row"><span>{t('ops.visits.billTotal')}</span><strong className="num">{money(v.totalMinor, v.currency, locale)}</strong></div>
                <div className="bill-row"><span>{t('ops.floor.remaining')}</span><strong className="num">{money(v.dueMinor, v.currency, locale)}</strong></div>
                {v.openOrders > 0 && <p className="fine">{t('ops.visits.openOrders', { n: v.openOrders })}</p>}
                {canClose && <button type="button" className="btn" disabled={busy} onClick={() => void close({ visitId: v.id, label: v.tableLabel ?? '' })}>{t('ops.floor.closeVisit')}</button>}
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
