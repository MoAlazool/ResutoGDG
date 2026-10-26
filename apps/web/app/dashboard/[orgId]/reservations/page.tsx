'use client';
import { useSearchParams } from 'next/navigation';
import { lazy, Suspense, useEffect, useState } from 'react';
import type { FloorLayout, ReservationView } from '@resuto/contracts';
import { Badge, Code, EmptyState, Field, Icon, ListPage, Notice, Phone, Skeleton, Tabs, UserText, useConfirm } from '@resuto/ui';
import { PlusIcon } from '@/components/icons/glyphs';
import '@/components/ops/ops.css';
import { FrontOfHouseNav } from '@/components/ops/FrontOfHouseNav';
import { shiftDay } from '@/components/ops/timeline';
import { ModuleGate } from '@/components/shell/ModuleGate';
import { useUrlParam } from '@/components/ops/use-url-state';
import { money, time } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useBranchParam, useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { isClosed, ReservationActions, resTone, type ResActions } from './_parts/actions';
import './reservations.css';

// The timeline, the booking sheet and the new-booking form load on demand (staff bundle budget).
const ReservationTimeline = lazy(() => import('@/components/ops/ReservationTimeline').then((m) => ({ default: m.ReservationTimeline })));
const ReservationSheet = lazy(() => import('./_parts/ReservationSheet').then((m) => ({ default: m.ReservationSheet })));
const NewReservationSheet = lazy(() => import('./_parts/NewReservationSheet').then((m) => ({ default: m.NewReservationSheet })));

const today = (tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

type View = 'timeline' | 'list';

export default function ReservationsPage() {
  return <Suspense fallback={<Skeleton lines={6} />}><Reservations /></Suspense>;
}

/**
 * Reservations (21-OPS): the day as a timeline per table (Gantt-style; a bar opens the booking in a sheet) or as a
 * list, with the front-of-house tabs (floor, front desk, reservations). Day and view live in the URL (PCL-20); the
 * branch is the shell's branch switcher (21-SHELL), which a ?branch= link selects.
 */
function Reservations() {
  const { t, locale } = useT();
  const { org, can, branchId: shellBranch } = useOrg();
  const { call } = useSession();
  const branchId = useBranchParam(shellBranch ?? org.branches[0]?.id ?? '');
  const [date, setDate] = useUrlParam<string>('date', today(org.timezone));
  const [view, setView] = useUrlParam<View>('view', 'timeline', ['timeline', 'list']);
  // The command palette's "New reservation" opens the form (`?new=1`).
  const params = useSearchParams();
  const [creating, setCreating] = useState(() => params.get('new') === '1' && can('reservations:write'));
  const newParam = params.get('new');
  useEffect(() => { if (newParam === '1' && can('reservations:write')) setCreating(true); }, [newParam]); // eslint-disable-line react-hooks/exhaustive-deps
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm(locale);
  const day = useApi<{ items: ReservationView[] }>(`/o/${org.id}/reservations?date=${date}${branchId ? `&branchId=${branchId}` : ''}`, { pollMs: 15000 });
  const floor = useApi<FloorLayout>(view === 'timeline' && branchId ? `/o/${org.id}/floor/${branchId}` : null, { staleMs: 60_000 });

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setError(null); setNotice(null);
    try { await fn(); setNotice(ok); setOpenId(null); await day.reload(); } catch (e) { setError((e as Error).message); }
  };
  const actions: ResActions = {
    checkIn: (r) => void act(() => call(`/o/${org.id}/reservations/${r.id}/check-in`, { body: {} }), t('core.resdash.seated')),
    noShow: (r) => void act(() => call(`/o/${org.id}/reservations/${r.id}/no-show`, { body: {} }), t('core.res.status.no_show')),
    cancel: async (r) => {
      if (await confirm({ title: t('core.res.cancelConfirm'), tone: 'danger', confirmLabel: t('core.res.cancel') })) void act(() => call(`/o/${org.id}/reservations/${r.id}/cancel`, { body: {} }), t('core.res.cancelled'));
    },
  };
  const items = day.data?.items ?? [];
  const live = items.filter((r) => !['cancelled', 'expired'].includes(r.status));
  const covers = live.reduce((a, r) => a + r.partySize, 0);
  const opened = items.find((r) => r.id === openId) ?? null;
  const tables = (floor.data?.tables ?? []).map((x) => ({ id: x.id, label: x.label }));

  return (
    <ModuleGate module="core" permission="reservations:read">
      {confirmDialog}
      <FrontOfHouseNav />
      <ListPage header={{ title: t('nav.reservations'), subtitle: t('core.resdash.subtitle', { n: live.length, covers }),
        actions: can('reservations:write') && <button className="btn btn-primary" onClick={() => setCreating(true)}><Icon icon={PlusIcon} size={16} /> {t('core.resdash.new')}</button> }}
        filters={<div className="res-toolbar">
        <div className="res-day" role="group" aria-label={t('core.orders.date')}>
          <button type="button" className="btn btn-sm" aria-label={t('ops.res.prevDay')} onClick={() => setDate(shiftDay(date, -1))}><span className="res-dir" aria-hidden="true">‹</span></button>
          <Field label={t('core.orders.date')} type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
          <button type="button" className="btn btn-sm" aria-label={t('ops.res.nextDay')} onClick={() => setDate(shiftDay(date, 1))}><span className="res-dir" aria-hidden="true">›</span></button>
          {date !== today(org.timezone) && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setDate(today(org.timezone))}>{t('ops.res.today')}</button>}
        </div>
        <Tabs<View> label={t('ops.orders.view')} value={view} onChange={setView}
          tabs={[{ key: 'timeline', label: t('ops.res.timeline') }, { key: 'list', label: t('ops.orders.list') }]} />
      </div>}>
      {error && <Notice tone="danger">{error}</Notice>}
      {notice && <Notice tone="ok">{notice}</Notice>}
      {day.loading && !day.data ? <Skeleton lines={6} /> : !items.length ? (
        <div className="card"><EmptyState title={t('core.resdash.empty')}>{t('core.resdash.emptyHint')}</EmptyState></div>
      ) : view === 'timeline' ? (
        floor.error ? <Notice tone="danger">{floor.error.message}</Notice> : !floor.data ? <Skeleton lines={6} /> : (
          <Suspense fallback={<Skeleton lines={6} />}>
            <ReservationTimeline tables={tables} bookings={items} timeZone={org.timezone} day={date} now={Date.now()} onOpen={setOpenId} />
          </Suspense>
        )
      ) : (
        <ol className="stack res-timeline" aria-label={t('core.resdash.timeline')}>
          {items.map((r) => (
            <li key={r.id} className="card res-row" data-closed={isClosed(r.status) || undefined}>
              <div><strong className="num res-time">{time(r.startsAt, locale, org.timezone)}</strong><div className="fine num">{time(r.endsAt, locale, org.timezone)}</div></div>
              <div className="stack res-body">
                <div className="spread">
                  <span><strong><UserText>{r.guestName}</UserText></strong> · {t('core.res.guests', { n: r.partySize })}{r.tableLabel ? ` · ${t('core.kds.table', { label: r.tableLabel })}` : ''}</span>
                  <Badge tone={resTone(r.status)}>{t(`core.res.status.${r.status}`)}</Badge>
                </div>
                <div className="fine">
                  <Code>{r.code}</Code> · {t(`core.res.source.${r.source}`)}{r.guestPhone ? <> · <Phone value={r.guestPhone} link /></> : null}
                  {r.depositMinor > 0 && ` · ${t('core.res.deposit')}: ${money(r.depositMinor, r.currency, locale)} (${t(`core.res.deposit.${r.depositStatus}`)})`}
                </div>
                {r.notes && <div className="fine">“<UserText>{r.notes}</UserText>”</div>}
                <ReservationActions r={r} canWrite={can('reservations:write')} canSeat={can('floor:seat')} actions={actions} />
              </div>
            </li>
          ))}
        </ol>
      )}
      </ListPage>
      {opened && <Suspense fallback={null}><ReservationSheet r={opened} onClose={() => setOpenId(null)} actions={actions} /></Suspense>}
      {creating && (
        <Suspense fallback={null}>
          <NewReservationSheet branchId={branchId} date={date} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); setNotice(t('core.res.status.confirmed')); void day.reload(); }} />
        </Suspense>
      )}
    </ModuleGate>
  );
}
