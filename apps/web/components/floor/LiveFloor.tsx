'use client';
// Floor overview (VS-11), restored from the legacy manager "Floor overview" (legacy/public/app.js renderStaff floor):
// QR print sheet and "+ Seat a walk-in" in the header, the four-cell KPI strip, the "opened by a guest scan" notice
// with Release table, the live floor plan with the eight-state legend and "Edit layout", and the side column with the
// selected table (seat / mark clean / close visit, remaining balance, its QR code) and the service requests.
// GET /floor/:branch/live is polled every 3 s; polling holds still while a dialog is open (VS-20).
import Link from 'next/link';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Modal, Notice, PageHeading, StatsStrip, StatsStripSkeleton, useConfirm, useToast } from '@resuto/ui';
import { ServiceRequestList, useServiceRequests } from '@/components/ops/ServiceRequests';
import '@/components/ops/ops.css';
import { ApiRequestError, newIdempotencyKey } from '@/lib/api';
import { money, time } from '@/lib/format';
import { useApi } from '@/lib/use-api';
import { useSession } from '@/lib/session';
import { FloorScene, type SceneTable } from './FloorScene';
import { LEGEND, liveCounts, liveState, smallestFreeTable, type LiveFloorResponse, type LiveTable } from './live';
import { normalizeLayout } from './model';
import { sanitizeQrSvg } from './QrSheet';
import { useFloorLabels } from './use-floor-labels';
import './floor.css';

export const LIVE_POLL_MS = 3000;

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

/** The floor plan panel: legend, scene and the "N tables · M seats" footer (shared by floor, front desk, overview). */
export function FloorMapPanel({ data, selectedId, onSelect, title, note, actions, compact }: {
  data: ReturnType<typeof useLiveFloor>; selectedId?: string | null; onSelect?: (id: string) => void; title?: ReactNode; note?: ReactNode;
  actions?: ReactNode; compact?: boolean;
}) {
  const { L, scene, live } = data;
  const { t, nf } = L;
  const counts = live.data ? liveCounts(live.data.tables) : null;
  return (
    <section className="panel floor-panel">
      {(title || actions) && <div className="panel-head"><div>{title && <h2>{title}</h2>}{note && <p>{note}</p>}</div>{actions && <div className="row">{actions}</div>}</div>}
      <div className="floor-toolbar">
        <span className="segmented">{t('ops.floor.entire')}</span>
        <div className="legend" aria-label={t('ops.floor.legend')}>
          {LEGEND.map((l) => <span key={l.key}><i style={{ background: l.fill, borderColor: l.stroke }} aria-hidden="true" />{t(`ops.floor.state.${l.key}`)}</span>)}
        </div>
      </div>
      {scene ? (
        <div className="saved-floor floor-mode-operations">
          <FloorScene layout={scene} mode="operations" ariaLabel={t('studio.live.mapLabel')} seatsLabel={L.seatsLabel} labelOf={L.labelOf}
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

export function LiveFloor({ orgId, branchId, currency, timezone, canSeat, canWrite, canResolve, qrHref, studioHref }: {
  orgId: string; branchId: string; currency: string; timezone: string; canSeat: boolean; canWrite: boolean; canResolve: boolean;
  qrHref: string; studioHref: string;
}) {
  const data = useLiveFloor(orgId, branchId);
  const { L, layout, live } = data;
  const { t, locale, nf } = L;
  const session = useSession();
  const toast = useToast();
  const [confirm, confirmDialog] = useConfirm(locale);
  const requests = useServiceRequests(orgId, branchId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [walkIn, setWalkIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const tables = live.data?.tables ?? [];
  const selected = tables.find((x) => x.id === selectedId);

  const act = async (fn: () => Promise<unknown>, success: string) => {
    if (busy) return;
    setBusy(true);
    try { await fn(); toast.show({ message: success, tone: 'ok' }); await live.reload(); void requests.reload(); }
    catch (e) { toast.show({ message: (e as Error).message, tone: 'danger' }); }
    finally { setBusy(false); }
  };
  const seat = (tbl: LiveTable, party: number, reservationId?: string) => act(
    () => session.call(`/o/${orgId}/visits`, { body: { tableId: tbl.id, partySize: party, ...(reservationId ? { reservationId } : {}) }, idempotencyKey: newIdempotencyKey() }),
    t('studio.live.seated', { label: tbl.label }));
  const close = async (tbl: LiveTable) => {
    if (!tbl.visit || busy) return;
    const visitId = tbl.visit.id;
    setBusy(true);
    try {
      await session.call(`/o/${orgId}/visits/${visitId}/close`, { body: {} });
      toast.show({ message: t('studio.live.closed', { label: tbl.label }), tone: 'ok' });
      await live.reload();
    } catch (e) {
      const err = e as ApiRequestError;
      setBusy(false);
      if (err.status === 409 || err.status === 422) {
        const ok = await confirm({ title: t('studio.live.forceTitle'), body: `${err.message} ${t('studio.live.forceBody')}`, confirmLabel: t('studio.live.forceClose'), tone: 'danger' });
        if (ok) await act(() => session.call(`/o/${orgId}/visits/${visitId}/close`, { body: { force: true } }), t('studio.live.closed', { label: tbl.label }));
        return;
      }
      toast.show({ message: err.message, tone: 'danger' });
    } finally { setBusy(false); }
  };
  const release = async (tbl: LiveTable) => {
    if (!tbl.visit) return;
    if (!(await confirm({ title: t('studio.live.undoTitle'), body: t('studio.live.undoBody'), confirmLabel: t('ops.floor.release') }))) return;
    await act(() => session.call(`/o/${orgId}/visits/${tbl.visit!.id}/undo`, { body: {} }), t('studio.live.undone', { label: tbl.label }));
  };
  const clean = (tbl: LiveTable) => act(() => session.call(`/o/${orgId}/tables/${tbl.id}/clean`, { body: {} }), t('studio.live.cleaned', { label: tbl.label }));

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
            onSeat={(tbl, party, res) => void seat(tbl, party, res)} onClose={(tbl) => void close(tbl)} onClean={(tbl) => void clean(tbl)} onRelease={(tbl) => void release(tbl)} />
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
        <WalkInDialog tables={tables} onClose={() => setWalkIn(false)} busy={busy}
          onSeat={async (tbl, party) => { await seat(tbl, party); setWalkIn(false); setSelectedId(tbl.id); }} />
      )}
    </div>
  );
}

/** Selected table (legacy .table-detail): badge, seats · zone, the visit and its balance, actions and the table QR. */
export function TableDetail({ table, orgId, branchId, currency, timezone, canSeat, canWrite, busy, onSeat, onClose, onClean, onRelease }: {
  table: LiveTable | undefined; orgId: string; branchId: string; currency: string; timezone: string; canSeat: boolean; canWrite: boolean; busy: boolean;
  onSeat(t: LiveTable, party: number, reservationId?: string): void; onClose(t: LiveTable): void; onClean(t: LiveTable): void; onRelease(t: LiveTable): void;
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
  return (
    <section className="panel table-detail" aria-live="polite">
      <div className="table-title"><h2>{table.label}</h2><span className={`badge state-badge state-${s.state}`}>{t(`ops.floor.state.${s.key}`)}</span></div>
      <p className="fine">{L.seatsLabel(table.capacity)}{table.zone ? <> · {L.labelOf(table.zone)}</> : null}</p>
      {v ? (
        <>
          <hr />
          <h3>{v.partySize ? t('ops.floor.party', { n: v.partySize }) : t('ops.floor.seatedGuests')}</h3>
          <p className="fine">{t('ops.floor.tableOpen', { time: time(v.openedAt, locale, timezone) })}</p>
          <div className="bill-row"><span>{t('ops.floor.remaining')}</span><strong className="num">{money(v.dueMinor, currency, locale)}</strong></div>
          {(v.totalMinor ?? 0) > 0 && <div className="bill-row fine"><span>{t('ops.visits.billTotal')}</span><span className="num">{money(v.totalMinor ?? 0, currency, locale)}</span></div>}
          {canSeat && <button type="button" className="btn btn-block" disabled={busy} onClick={() => onClose(table)}>{t('ops.floor.closeVisit')}</button>}
          {canSeat && v.undoable && <button type="button" className="btn btn-ghost btn-block" disabled={busy} onClick={() => onRelease(table)}>{t('ops.floor.release')}</button>}
        </>
      ) : canSeat && table.status === 'cleaning' ? (
        <button type="button" className="btn btn-primary btn-block" disabled={busy} onClick={() => onClean(table)}>✓ {t('ops.floor.markClean')}</button>
      ) : canSeat && table.status !== 'out_of_service' ? (
        <div className="stack">
          <label className="field"><span>{t('studio.live.partySize')}</span>
            <input className="input" type="number" inputMode="numeric" min={1} max={table.capacity} value={party} onChange={(e) => setParty(Math.max(1, Math.min(table.capacity, Number(e.target.value) || 1)))} />
          </label>
          <button type="button" className="btn btn-primary btn-block" disabled={busy} onClick={() => onSeat(table, party)}>＋ {t('ops.floor.seatGuests')}</button>
          {table.nextReservation && (
            <button type="button" className="btn btn-block" disabled={busy} onClick={() => onSeat(table, table.nextReservation!.partySize, table.nextReservation!.id)}>
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

/** "+ Seat a walk-in" (legacy modal): picks the smallest free table that fits the party; staff can choose another. */
export function WalkInDialog({ tables, onClose, onSeat, busy }: { tables: LiveTable[]; onClose(): void; onSeat(t: LiveTable, party: number): Promise<void>; busy: boolean }) {
  const { t, nf } = useFloorLabels();
  const [party, setParty] = useState(2);
  const free = tables.filter((x) => liveState(x).key === 'available').sort((a, b) => a.capacity - b.capacity);
  const suggested = smallestFreeTable(tables, party);
  const [tableId, setTableId] = useState<string>('');
  const chosen = free.find((x) => x.id === tableId && x.capacity >= party) ?? suggested;
  return (
    <Modal open onClose={onClose} title={t('ops.floor.seatWalkIn')} footer={<>
      <button type="button" className="btn" onClick={onClose}>{t('action.cancel')}</button>
      <button type="button" className="btn btn-primary" disabled={!chosen || busy} onClick={() => chosen && void onSeat(chosen, party)}>
        {chosen ? t('ops.floor.seatAt', { label: chosen.label }) : t('ops.floor.seatGuests')}
      </button>
    </>}>
      <div className="stack">
        <label className="field"><span>{t('studio.live.partySize')}</span>
          <input className="input" type="number" inputMode="numeric" min={1} max={50} value={party} onChange={(e) => setParty(Math.max(1, Math.min(50, Number(e.target.value) || 1)))} />
        </label>
        {free.length === 0 ? <Notice tone="warn">{t('ops.floor.noFree')}</Notice> : (
          <div className="free-chips" role="radiogroup" aria-label={t('ops.floor.freeTables')}>
            {free.map((x) => (
              <button key={x.id} type="button" role="radio" aria-checked={chosen?.id === x.id} disabled={x.capacity < party}
                className={`chip-btn${chosen?.id === x.id ? ' is-on' : ''}`} onClick={() => setTableId(x.id)}>
                <strong>{x.label}</strong><small>{t('studio.floor.seats', { n: nf.format(x.capacity) })}</small>
              </button>
            ))}
          </div>
        )}
        {!suggested && free.length > 0 && <p className="fine">{t('ops.floor.noneFits')}</p>}
      </div>
    </Modal>
  );
}
