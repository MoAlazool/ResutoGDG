'use client';
// Front desk (VS-12), restored from legacy/public/host.js: who is in, what is free, and who is next. KPIs (tables free,
// seated now, booked today, needs you), the live floor (tap a free table to seat guests), "Free right now" chips,
// "Arriving today" with Check in inside the -15/+30 minute window, open bills and service requests.
import { useMemo, useState } from 'react';
import { RESERVATION_RULES, type ReservationView } from '@resuto/contracts';
import { Badge, PageHeading, StatsStrip, StatsStripSkeleton, ToastProvider, useToast } from '@resuto/ui';
import { FloorMapPanel, LIVE_POLL_MS, TableDetail, WalkInDialog, useLiveFloor, useVisitActions } from '@/components/floor/LiveFloor';
import { liveCounts, liveState } from '@/components/floor/live';
import { canForceClose } from '@/components/floor/visit-actions';
import { ServiceRequestList, useServiceRequests } from '@/components/ops/ServiceRequests';
import '@/components/ops/ops.css';
import { ModuleGate } from '@/components/shell/ModuleGate';
import { money, time } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';

/** Today's date (YYYY-MM-DD) in the restaurant's time zone. */
const todayIn = (timeZone: string, now = Date.now()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

function FrontDesk() {
  const { t, locale } = useT();
  const { org, can, branchId: shellBranch } = useOrg();
  const session = useSession();
  const toast = useToast();
  const branchId = shellBranch ?? org.branches[0]?.id ?? '';
  const data = useLiveFloor(org.id, branchId, LIVE_POLL_MS);
  const { live, L } = data;
  const nf = L.nf;
  const requests = useServiceRequests(org.id, branchId);
  const date = todayIn(org.timezone);
  const bookings = useApi<{ items: ReservationView[] }>(can('reservations:read') ? `/o/${org.id}/reservations?branchId=${branchId}&date=${date}&status=confirmed,held,pending_deposit` : null, { pollMs: 15_000 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [walkIn, setWalkIn] = useState(false);
  const tables = useMemo(() => live.data?.tables ?? [], [live.data]);
  const free = tables.filter((x) => liveState(x).key === 'available');
  const openBills = tables.filter((x) => x.visit && x.visit.dueMinor > 0);
  const now = Date.now();
  // As legacy host.js: 'Booked today' and 'Arriving today' are the same list (today's confirmed/held bookings that have
  // not ended, first 12), so the KPI counts who is still to come, not every booking of the day.
  const arriving = (bookings.data?.items ?? []).filter((r) => Date.parse(r.endsAt) > now).slice(0, 12);

  // Seat, close visit, release and mark clean: the same handlers as the Floor overview (no inert buttons, VS-12).
  const visit = useVisitActions(org.id, canForceClose(org.role), async () => { await live.reload(); void bookings.reload(); void requests.reload(); });
  const [checking, setChecking] = useState(false);
  const busy = visit.busy || checking;
  const checkIn = async (r: ReservationView) => {
    if (busy) return;
    setChecking(true);
    try {
      await session.call(`/o/${org.id}/reservations/${r.id}/check-in`, { body: {} });
      toast.show({ message: t('ops.host.checkedIn', { name: r.guestName }), tone: 'ok' });
      await live.reload(); void bookings.reload();
    } catch (e) { toast.show({ message: (e as Error).message, tone: 'danger' }); }
    finally { setChecking(false); }
  };

  const counts = live.data ? liveCounts(tables) : null;
  const needsYou = (requests.data?.items.length ?? 0) + tables.filter((x) => ['payment', 'partiallyPaid'].includes(liveState(x).key) && (x.visit?.dueMinor ?? 0) > 0).length;
  const selected = tables.find((x) => x.id === selectedId);
  const inWindow = (r: ReservationView) => now >= Date.parse(r.startsAt) - RESERVATION_RULES.checkInBeforeMinutes * 60_000 && now <= Date.parse(r.startsAt) + RESERVATION_RULES.checkInAfterMinutes * 60_000;

  return (
    <>
      {visit.confirmDialog}
      <PageHeading title={t('ops.host.title')} subtitle={t('ops.host.subtitle')}
        actions={can('floor:seat') && <button type="button" className="btn btn-primary" disabled={!live.data} onClick={() => setWalkIn(true)}>＋ {t('ops.floor.seatWalkIn')}</button>} />
      {counts ? (
        <StatsStrip label={t('ops.host.title')} items={[
          { key: 'free', label: t('ops.host.kpi.free'), value: nf.format(counts.free), unit: `/ ${nf.format(counts.total)}`, note: t('ops.host.kpi.freeNote', { seats: nf.format(free.reduce((n, x) => n + x.capacity, 0)) }) },
          { key: 'seated', label: t('ops.host.kpi.seated'), value: nf.format(counts.seatedNow), note: t('ops.host.kpi.seatedNote', { tables: nf.format(counts.total - counts.free) }) },
          { key: 'booked', label: t('ops.host.kpi.booked'), value: nf.format(arriving.length), note: t('ops.host.kpi.bookedNote') },
          { key: 'needs', label: t('ops.host.kpi.needs'), value: nf.format(needsYou), note: t('ops.host.kpi.needsNote'), tone: needsYou ? 'warn' : undefined },
        ]} />
      ) : <StatsStripSkeleton />}
      <div className="host-layout">
        <FloorMapPanel data={data} selectedId={selectedId} onSelect={setSelectedId} title={t('ops.host.available')} note={t('ops.host.availableNote')} compact />
        <aside className="host-side">
          {selected && (
            <TableDetail table={selected} orgId={org.id} branchId={branchId} currency={org.currency} timezone={org.timezone} canSeat={can('floor:seat')}
              canWrite={false} busy={busy} actions={visit} />
          )}
          <section className="panel">
            <div className="panel-head"><h2>{t('ops.host.freeNow')}</h2></div>
            <div className="panel-body">
              {free.length ? (
                <div className="host-chips">
                  {free.map((x) => (
                    <button key={x.id} type="button" className="chip-btn" disabled={busy || !can('floor:seat')} onClick={() => setSelectedId(x.id)}>
                      <strong>{x.label}</strong><small>{t('studio.floor.seats', { n: nf.format(x.capacity) })}{x.zone ? <> · {L.labelOf(x.zone)}</> : null}</small>
                    </button>
                  ))}
                </div>
              ) : <p className="fine">{t('ops.host.allInService')}</p>}
            </div>
          </section>
          {can('reservations:read') && (
            <section className="panel">
              <div className="panel-head"><h2>{t('ops.host.arriving')}</h2></div>
              <div className="panel-body">
                {arriving.length ? arriving.map((r) => (
                  <div key={r.id} className="host-row">
                    <span><strong><bdi>{r.guestName}</bdi></strong><small><span className="num">{time(r.startsAt, locale, org.timezone)}</span>{r.tableLabel ? ` · ${r.tableLabel}` : ''} · {t('ops.floor.party', { n: r.partySize })}</small></span>
                    {r.status === 'confirmed' && inWindow(r) && can('floor:seat')
                      ? <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void checkIn(r)}>{t('ops.host.checkIn')}</button>
                      : <Badge tone={r.status === 'confirmed' ? 'ok' : 'neutral'}>{t(`core.res.status.${r.status}`)}</Badge>}
                  </div>
                )) : <p className="fine">{t('ops.host.noBookings')}</p>}
              </div>
            </section>
          )}
          <section className="panel">
            <div className="panel-head"><h2>{t('ops.host.openBills')}</h2></div>
            <div className="panel-body">
              {openBills.length ? openBills.map((x) => (
                <div key={x.id} className="host-row">
                  <span><strong>{x.label}</strong><small>{t(`ops.floor.state.${liveState(x).key}`)}</small></span>
                  <b className="num">{money(x.visit!.dueMinor, org.currency, locale)}</b>
                </div>
              )) : <p className="fine">{t('ops.host.settled')}</p>}
              <p className="fine">{t('ops.host.billsHint')}</p>
            </div>
          </section>
          <section className="panel">
            <div className="panel-head"><h2>{t('ops.req.title')}</h2></div>
            <div className="panel-body">
              <ServiceRequestList orgId={org.id} items={requests.data?.items} timezone={org.timezone} canResolve resolveLabel={t('ops.req.done')}
                onResolved={() => void requests.reload()} onSelect={(r) => setSelectedId(r.tableId)} />
            </div>
          </section>
        </aside>
      </div>
      {walkIn && live.data && (
        <WalkInDialog tables={tables} busy={busy} onClose={() => setWalkIn(false)} onSeat={async (tb, party) => { await visit.seat(tb, party); setWalkIn(false); setSelectedId(tb.id); }} />
      )}
    </>
  );
}

export default function HostPage() {
  const { t } = useT();
  return (
    <ModuleGate module="core" permission="floor:seat">
      <ToastProvider closeLabel={t('action.close')}><FrontDesk /></ToastProvider>
    </ModuleGate>
  );
}
