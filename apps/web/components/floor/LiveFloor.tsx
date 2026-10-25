'use client';
// Floor overview (VS-11), restored from the legacy manager "Floor overview" (legacy/public/app.js renderStaff floor):
// QR print sheet and "+ Seat a walk-in" in the header, the four-cell KPI strip, the "opened by a guest scan" notice
// with Release table, the live floor plan with the eight-state legend and "Edit layout", and the side column with the
// selected table (seat / mark clean / close visit, remaining balance, its QR code) and the service requests.
// GET /floor/:branch/live is polled every 3 s; polling holds still while a dialog is open (VS-20).
import Link from 'next/link';
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Notice, PageHeading, StatsStrip, StatsStripSkeleton, useConfirm, useToast } from '@resuto/ui';
import { ServiceRequestList, useServiceRequests } from '@/components/ops/ServiceRequests';
import '@/components/ops/ops.css';
import { newIdempotencyKey } from '@/lib/api';
import { money, time } from '@/lib/format';
import { useApi } from '@/lib/use-api';
import { useSession } from '@/lib/session';
import { areaScene, floorAreas } from './areas';
import { FloorScene, type SceneTable } from './FloorScene';
import { LEGEND, liveCounts, liveState, type LiveFloorResponse, type LiveTable } from './live';
import { normalizeLayout } from './model';
import { sanitizeQrSvg } from './QrSheet';
import { useFloorLabels } from './use-floor-labels';
import { tableActionKeys, visitActions, type VisitActions } from './visit-actions';
import './floor.css';

export const LIVE_POLL_MS = 3000;

/** The walk-in sheet loads when it opens (staff bundle budget). */
export const WalkInSheet = lazy(() => import('./WalkInSheet').then((m) => ({ default: m.WalkInSheet })));

/**
 * Seat / close / release / clean with one guard (one action at a time, buttons disabled while it runs), toasts and the
 * styled confirm. Shared by the Floor overview, the Front desk and Active visits so no screen renders an inert action.
 * `canForce`: only managers are offered force-close when a normal close is refused (the API refuses it for others).
 */
export function useVisitActions(orgId: string, canForce: boolean, after: () => unknown) {
  const { t, locale } = useFloorLabels();
  const session = useSession();
  const toast = useToast();
  const [confirm, confirmDialog] = useConfirm(locale);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const afterRef = useRef(after);
  afterRef.current = after;
  const actions = useMemo(() => {
    const raw = visitActions({
      orgId, canForce, t, ask: confirm, newKey: newIdempotencyKey,
      call: (path, init) => session.call(path, init),
      notify: (message, tone) => toast.show({ message, tone }),
      after: () => afterRef.current(),
    });
    const guard = <A extends unknown[]>(fn: (...a: A) => Promise<void>) => async (...a: A) => {
      if (running.current) return;
      running.current = true;
      setBusy(true);
      try { await fn(...a); } finally { running.current = false; setBusy(false); }
    };
    return { seat: guard(raw.seat), close: guard(raw.close), release: guard(raw.release), clean: guard(raw.clean) } satisfies VisitActions;
  }, [orgId, canForce, t, confirm, session, toast]);
  return { busy, confirmDialog, ...actions };
}

/** Live floor data: saved geometry + live states, reloading the geometry when a new layout is saved. */
export function useLiveFloor(orgId: string, branchId: string, pollMs = LIVE_POLL_MS) {
  const L = useFloorLabels();
  const layout = useApi<any>(`/o/${orgId}/floor/${branchId}`);
  const live = useApi<LiveFloorResponse>(`/o/${orgId}/floor/${branchId}/live`, { pollMs });
  const layoutRevision = layout.data?.revision;
  useEffect(() => {
    if (live.data && layoutRevision !== undefined && live.data.revision !== layoutRevision) void layout.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.data?.revision, layoutRevision]);
  const scene = useMemo(() => {
    if (!layout.data || !live.data) return null;
    const geometry = normalizeLayout(layout.data);
    const tables: SceneTable[] = live.data.tables.map((x) => {
      const s = liveState(x);
      const base = normalizeLayout({ tables: [x] } as any).tables[0]!;
      return { ...base, state: s.state, statusText: L.t(`ops.floor.state.${s.key}`), disabled: false };
    });
    return { ...geometry, tables };
  }, [layout.data, live.data, L]);
  return { L, layout, live, scene };
}

/**
 * The shared live map (floor overview, front desk, overview): area tabs (Entire floor and each zone that has tables,
 * 21-OPS), the legend, the scene cropped to the chosen area, and the "N tables · M seats" footer.
 */
export function FloorMapPanel({ data, selectedId, onSelect, title, note, actions, compact }: {
  data: ReturnType<typeof useLiveFloor>; selectedId?: string | null; onSelect?: (id: string) => void; title?: ReactNode; note?: ReactNode;
  actions?: ReactNode; compact?: boolean;
}) {
  const { L, scene, live } = data;
  const { t, nf } = L;
  const counts = live.data ? liveCounts(live.data.tables) : null;
  const areas = useMemo(() => (scene ? floorAreas(scene) : []), [scene]);
  const [area, setArea] = useState<string | null>(null);
  const shown = useMemo(() => (scene ? areaScene(scene, area) : null), [scene, area]);
  return (
    <section className="panel floor-panel">
      {(title || actions) && <div className="panel-head"><div>{title && <h2>{title}</h2>}{note && <p>{note}</p>}</div>{actions && <div className="row">{actions}</div>}</div>}
      <div className="floor-toolbar">
        {areas.length > 1 ? (
          <div className="floor-areas" role="group" aria-label={t('ops.floor.areas')}>
            <button type="button" className="floor-area" aria-pressed={!area || !areas.some((a) => a.label === area)} onClick={() => setArea(null)}>{t('ops.floor.entire')}</button>
            {areas.map((a) => (
              <button key={a.label} type="button" className="floor-area" aria-pressed={area === a.label} onClick={() => setArea(a.label)}>
                {L.labelOf(a.label)} <span className="num">{nf.format(a.tables)}</span>
              </button>
            ))}
          </div>
        ) : <span className="segmented">{t('ops.floor.entire')}</span>}
        <div className="legend" aria-label={t('ops.floor.legend')}>
          {LEGEND.map((l) => <span key={l.key}><i data-state={l.key} aria-hidden="true" />{t(`ops.floor.state.${l.key}`)}</span>)}
        </div>
      </div>
      {shown ? (
        <div className="saved-floor floor-mode-operations">
          <FloorScene layout={shown.layout} viewBox={shown.viewBox} mode="operations" ariaLabel={t('studio.live.mapLabel')} seatsLabel={L.seatsLabel} labelOf={L.labelOf}
            selected={selectedId ? [selectedId] : []} onTableActivate={onSelect ?? (() => undefined)}
            tableAria={(x) => `${x.label}, ${L.seatsLabel(x.capacity)}, ${x.statusText ?? ''}`} />
        </div>
      ) : <div className="skeleton floor-skel" aria-hidden="true" />}
      {!compact && counts && (
        <div className="floor-bottom">
          <span>{t('ops.floor.bottom', { tables: nf.format(counts.total), seats: nf.format(counts.seats) })}</span>
          <span>{t('ops.floor.syncs')} <span className="ws-live-dot" aria-hidden="true" /></span>
        </div>
      )}
    </section>
  );
}

export function LiveFloor({ orgId, branchId, currency, timezone, canSeat, canForce, canWrite, canResolve, qrHref, studioHref }: {
  orgId: string; branchId: string; currency: string; timezone: string; canSeat: boolean; canForce: boolean; canWrite: boolean; canResolve: boolean;
  qrHref: string; studioHref: string;
}) {
  const data = useLiveFloor(orgId, branchId);
  const { L, layout, live } = data;
  const { t, nf } = L;
  const requests = useServiceRequests(orgId, branchId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [walkIn, setWalkIn] = useState(false);
  const tables = live.data?.tables ?? [];
  const selected = tables.find((x) => x.id === selectedId);
  const { busy, confirmDialog, seat, close, release, clean } = useVisitActions(orgId, canForce, async () => { await live.reload(); void requests.reload(); });

  const counts = live.data ? liveCounts(tables) : null;
  const autoOpened = tables.filter((x) => x.visit?.undoable);
  const heading = (
    <PageHeading title={t('ops.floor.title')} subtitle={t('ops.floor.subtitle')}
      actions={<>
        {canWrite && <Link className="btn" href={qrHref}>↗ {t('ops.floor.qrSheet')}</Link>}
        {canSeat && <button type="button" className="btn btn-primary" disabled={!live.data} onClick={() => setWalkIn(true)}>＋ {t('ops.floor.seatWalkIn')}</button>}
      </>} />
  );

  if (layout.error || live.error) {
    const err = layout.error ?? live.error!;
    return (<>{heading}
      <div className="panel"><div className="panel-body">
        <Notice tone="danger">{err.status === 404 ? t('studio.floor.notFound') : `${t('state.error')}: ${err.message}`}</Notice>
        <button className="btn" onClick={() => { void layout.reload(); void live.reload(); }}>{t('action.retry')}</button>
      </div></div></>);
  }

  return (
    <div className="floor-overview">
      {confirmDialog}
      {heading}
      {canSeat && autoOpened.length > 0 && (
        <div className="auto-notice" role="status">
          {autoOpened.map((x) => (
            <div key={x.id} className="auto-notice-row">
              <span className="ws-live-dot" aria-hidden="true" />
              <div><strong>{x.label} · {t('ops.floor.autoOpened')}</strong><small>{t('ops.floor.autoOpenedHint')}</small></div>
              <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void release(x)}>{t('ops.floor.release')}</button>
            </div>
          ))}
        </div>
      )}
      {counts ? (
        <StatsStrip label={t('ops.floor.title')} items={[
          { key: 'free', label: t('ops.floor.kpi.available'), value: nf.format(counts.free), unit: `/ ${nf.format(counts.total)}`, note: t('ops.floor.kpi.availableNote') },
          { key: 'seats', label: t('ops.floor.kpi.capacity'), value: nf.format(counts.occupiedSeats), unit: t('ops.floor.kpi.capacityUnit'), note: t('ops.floor.kpi.capacityNote', { n: counts.occupiedTables }) },
          { key: 'res', label: t('ops.floor.kpi.upcoming'), value: nf.format(counts.upcoming), note: t('ops.floor.kpi.upcomingNote') },
          { key: 'kitchen', label: t('ops.floor.kpi.kitchen'), value: nf.format(counts.inKitchen), unit: t('ops.floor.kpi.kitchenUnit'), note: t('ops.floor.kpi.kitchenNote', { ready: nf.format(counts.readyToServe) }) },
        ]} />
      ) : <StatsStripSkeleton />}
      <div className="floor-layout">
        <FloorMapPanel data={data} selectedId={selectedId} onSelect={setSelectedId} title={t('ops.floor.planTitle')} note={t('ops.floor.planNote')}
          actions={canWrite ? <Link className="btn btn-sm" href={studioHref}>{t('ops.floor.editLayout')}</Link> : null} />
        <aside className="details-column">
          <TableDetail table={selected} orgId={orgId} branchId={branchId} currency={currency} timezone={timezone} canSeat={canSeat} canWrite={canWrite} busy={busy}
            actions={{ seat, close, clean, release }} />
          <section className="panel">
            <div className="panel-head"><h2>{t('ops.req.title')}</h2><span className="badge num">{nf.format(requests.data?.items.length ?? 0)}</span></div>
            <div className="panel-body">
              <ServiceRequestList orgId={orgId} items={requests.data?.items} timezone={timezone} canResolve={canResolve}
                onResolved={() => { void requests.reload(); void live.reload(); }} onSelect={(r) => setSelectedId(r.tableId)} />
            </div>
          </section>
        </aside>
      </div>
      {walkIn && live.data && (
        <Suspense fallback={null}>
          <WalkInSheet tables={tables} onClose={() => setWalkIn(false)} busy={busy}
            onSeat={async (tbl, party) => { await seat(tbl, party); setWalkIn(false); setSelectedId(tbl.id); }} />
        </Suspense>
      )}
    </div>
  );
}

/** Selected table (legacy .table-detail): badge, seats · zone, the visit and its balance, actions and the table QR. */
export function TableDetail({ table, orgId, branchId, currency, timezone, canSeat, canWrite, busy, actions }: {
  table: LiveTable | undefined; orgId: string; branchId: string; currency: string; timezone: string; canSeat: boolean; canWrite: boolean; busy: boolean;
  /** Every button shown (tableActionKeys) runs one of these; pass useVisitActions' handlers. */
  actions: VisitActions;
}) {
  const L = useFloorLabels();
  const { t, locale, nf } = L;
  const [party, setParty] = useState(2);
  useEffect(() => { if (table) setParty(Math.min(table.capacity, 2)); }, [table?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!table) {
    return (
      <section className="panel table-detail">
        <div className="detail-art" aria-hidden="true">▦</div>
        <h2>{t('ops.floor.pickTitle')}</h2>
        <p>{t('ops.floor.pickBody')}</p>
        <div className="detail-tip"><span aria-hidden="true">↖</span> {t('ops.floor.pickTip')}</div>
      </section>
    );
  }
  const s = liveState(table);
  const v = table.visit;
  const shown = new Set(tableActionKeys(table, canSeat));
  const run = (p: Promise<void>) => void p;
  return (
    <section className="panel table-detail" aria-live="polite" aria-labelledby={`table-detail-${table.id}`}>
      <div className="table-title"><h2 id={`table-detail-${table.id}`}>{table.label}</h2><span className={`badge state-badge state-${s.state}`}>{t(`ops.floor.state.${s.key}`)}</span></div>
      <p className="fine">{L.seatsLabel(table.capacity)}{table.zone ? <> · {L.labelOf(table.zone)}</> : null}</p>
      {v ? (
        <>
          <hr />
          <h3>{v.partySize ? t('ops.floor.party', { n: v.partySize }) : t('ops.floor.seatedGuests')}</h3>
          <p className="fine">{t('ops.floor.tableOpen', { time: time(v.openedAt, locale, timezone) })}</p>
          <div className="bill-row"><span>{t('ops.floor.remaining')}</span><strong className="num">{money(v.dueMinor, currency, locale)}</strong></div>
          {(v.totalMinor ?? 0) > 0 && <div className="bill-row fine"><span>{t('ops.visits.billTotal')}</span><span className="num">{money(v.totalMinor ?? 0, currency, locale)}</span></div>}
          {shown.has('close') && <button type="button" className="btn btn-block" disabled={busy} onClick={() => run(actions.close({ visitId: v.id, label: table.label }))}>{t('ops.floor.closeVisit')}</button>}
          {shown.has('release') && <button type="button" className="btn btn-ghost btn-block" disabled={busy} onClick={() => run(actions.release(table))}>{t('ops.floor.release')}</button>}
        </>
      ) : shown.has('clean') ? (
        <button type="button" className="btn btn-primary btn-block" disabled={busy} onClick={() => run(actions.clean(table))}>✓ {t('ops.floor.markClean')}</button>
      ) : shown.has('seat') ? (
        <div className="stack">
          <label className="field"><span>{t('studio.live.partySize')}</span>
            <input className="input" type="number" inputMode="numeric" min={1} max={table.capacity} value={party} onChange={(e) => setParty(Math.max(1, Math.min(table.capacity, Number(e.target.value) || 1)))} />
          </label>
          <button type="button" className="btn btn-primary btn-block" disabled={busy} onClick={() => run(actions.seat(table, party))}>＋ {t('ops.floor.seatGuests')}</button>
          {shown.has('seatReservation') && table.nextReservation && (
            <button type="button" className="btn btn-block" disabled={busy} onClick={() => run(actions.seat(table, table.nextReservation!.partySize, table.nextReservation!.id))}>
              {t('studio.live.seatReservation', { name: table.nextReservation.guestName ?? '' })}
            </button>
          )}
        </div>
      ) : null}
      {table.nextReservation && (
        <p className="fine">{t('studio.live.nextReservation')}: <span className="num">{time(table.nextReservation.startsAt, locale, timezone)}</span> · <bdi>{table.nextReservation.guestName ?? ''}</bdi> · {t('ops.floor.party', { n: table.nextReservation.partySize })}</p>
      )}
      {canWrite && <TableQr orgId={orgId} branchId={branchId} tableId={table.id} label={table.label} />}
    </section>
  );
}

/** One table's QR (legacy .qr-row): loaded on demand for floor writers; every view is audited by the API. */
function TableQr({ orgId, branchId, tableId, label }: { orgId: string; branchId: string; tableId: string; label: string }) {
  const { t } = useFloorLabels();
  const qr = useApi<{ url: string; svg: string }>(`/o/${orgId}/floor/${branchId}/qr/${tableId}`, { staleMs: 10 * 60_000 });
  const svg = qr.data ? sanitizeQrSvg(qr.data.svg) : null;
  const download = () => {
    if (!svg) return;
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    const a = document.createElement('a');
    a.href = url; a.download = `resuto-${label}.svg`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div className="qr-row">
      {svg ? <div className="qr-img" role="img" aria-label={t('studio.qr.codeFor', { label })} dangerouslySetInnerHTML={{ __html: svg }} /> : <div className="qr-img skeleton" aria-hidden="true" />}
      <div>
        <strong>{t('ops.floor.qrTitle')}</strong>
        <p className="fine">{t('ops.floor.qrHint')}</p>
        {qr.data && <a href={qr.data.url} target="_blank" rel="noopener noreferrer">{t('ops.floor.openGuest')} ↗</a>}
        {svg && <button type="button" className="ops-link qr-download" onClick={download}>{t('ops.floor.downloadQr')} ↓</button>}
      </div>
    </div>
  );
}
