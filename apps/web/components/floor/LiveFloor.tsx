'use client';
// Live floor operations (port of the manager "Floor overview" and host board):
// GET /floor/:branchId/live polled every few seconds, legacy table-state colours,
// seat walk-in, close, clean, undo, service requests and next reservation.
import { useEffect, useMemo, useState } from 'react';
import { EmptyState, KeyValueList, Notice, Skeleton, useConfirm, useToast } from '@resuto/ui';
import { ApiRequestError, newIdempotencyKey } from '@/lib/api';
import { money, time } from '@/lib/format';
import { useApi } from '@/lib/use-api';
import { useSession } from '@/lib/session';
import { FloorScene, type SceneTable } from './FloorScene';
import { LEGEND, liveCounts, liveState, type LiveFloorResponse, type LiveTable } from './live';
import { normalizeLayout } from './model';
import { useFloorLabels } from './use-floor-labels';
import './floor.css';

export function LiveFloor({ orgId, branchId, currency, timezone, canSeat }: { orgId: string; branchId: string; currency: string; timezone: string; canSeat: boolean }) {
  const L = useFloorLabels();
  const { t, locale } = L;
  const session = useSession();
  const toast = useToast();
  const [confirm, confirmDialog] = useConfirm(locale);
  const layout = useApi<any>(`/o/${orgId}/floor/${branchId}`);
  const live = useApi<LiveFloorResponse>(`/o/${orgId}/floor/${branchId}/live`, { pollMs: 5000 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [party, setParty] = useState(2);
  const [busy, setBusy] = useState(false);

  // Reload the geometry when the saved layout changes underneath the live view.
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
      return { ...base, state: s.state, statusText: t(`studio.live.state.${s.key}`), disabled: false };
    });
    return { ...geometry, tables };
  }, [layout.data, live.data, t]);

  const selected: LiveTable | undefined = live.data?.tables.find((x) => x.id === selectedId);
  useEffect(() => { if (selected?.capacity) setParty(Math.min(selected.capacity, Math.max(1, party))); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [selectedId]);

  const act = async (fn: () => Promise<unknown>, success: string) => {
    setBusy(true);
    try {
      await fn();
      toast.show({ message: success, tone: 'ok' });
      await live.reload();
    } catch (e) {
      toast.show({ message: (e as Error).message, tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };
  const seat = (tbl: LiveTable, reservationId?: string) => act(
    () => session.call(`/o/${orgId}/visits`, { body: { tableId: tbl.id, partySize: party, ...(reservationId ? { reservationId } : {}) }, idempotencyKey: newIdempotencyKey() }),
    t('studio.live.seated', { label: tbl.label }));
  const close = async (tbl: LiveTable) => {
    if (!tbl.visit) return;
    const visitId = tbl.visit.id;
    setBusy(true);
    try {
      await session.call(`/o/${orgId}/visits/${visitId}/close`, { body: {} });
      toast.show({ message: t('studio.live.closed', { label: tbl.label }), tone: 'ok' });
      await live.reload();
    } catch (e) {
      const err = e as ApiRequestError;
      if (err.status === 409 || err.status === 422) {
        setBusy(false);
        const ok = await confirm({ title: t('studio.live.forceTitle'), body: `${err.message} ${t('studio.live.forceBody')}`, confirmLabel: t('studio.live.forceClose'), tone: 'danger' });
        if (ok) await act(() => session.call(`/o/${orgId}/visits/${visitId}/close`, { body: { force: true } }), t('studio.live.closed', { label: tbl.label }));
        return;
      }
      toast.show({ message: err.message, tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };
  const undoSeat = async (tbl: LiveTable) => {
    if (!tbl.visit) return;
    if (!(await confirm({ title: t('studio.live.undoTitle'), body: t('studio.live.undoBody'), confirmLabel: t('studio.live.undo') }))) return;
    await act(() => session.call(`/o/${orgId}/visits/${tbl.visit!.id}/undo`, { body: {} }), t('studio.live.undone', { label: tbl.label }));
  };
  const clean = (tbl: LiveTable) => act(() => session.call(`/o/${orgId}/tables/${tbl.id}/clean`, { body: {} }), t('studio.live.cleaned', { label: tbl.label }));

  if (layout.error || live.error) {
    const err = layout.error ?? live.error!;
    return (
      <div className="card">
        <Notice tone="danger">{err.status === 404 ? t('studio.floor.notFound') : `${t('state.error')}: ${err.message}`}</Notice>
        <button className="btn" style={{ marginBlockStart: 12 }} onClick={() => { void layout.reload(); void live.reload(); }}>{t('action.retry')}</button>
      </div>
    );
  }
  if (!scene || !live.data) return <div className="card"><Skeleton lines={6} /></div>;
  if (!live.data.tables.length) {
    return <div className="card"><EmptyState title={t('studio.live.emptyTitle')}>{t('studio.live.emptyBody')}</EmptyState></div>;
  }

  const counts = liveCounts(live.data.tables);
  const requests = live.data.tables.filter((x) => x.visit?.requests.length);
  const upcoming = live.data.tables.filter((x) => x.nextReservation).sort((a, b) => a.nextReservation!.startsAt.localeCompare(b.nextReservation!.startsAt));
  const nf = L.nf;
  return (
    <div dir={locale === 'ar' ? 'rtl' : 'ltr'}>
      {confirmDialog}
      <div className="live-kpis" role="list">
        <div role="listitem"><small>{t('studio.live.kpiFree')}</small><strong>{nf.format(counts.free)}</strong></div>
        <div role="listitem"><small>{t('studio.live.kpiSeated')}</small><strong>{nf.format(counts.seated)}</strong></div>
        <div role="listitem"><small>{t('studio.live.kpiGuests')}</small><strong>{nf.format(counts.guests)}</strong></div>
        <div role="listitem"><small>{t('studio.live.kpiNeeds')}</small><strong>{nf.format(counts.needsYou)}</strong></div>
      </div>
      <div className="live-floor" style={{ padding: 0 }}>
        <div className="floor-card">
          <div className="saved-floor floor-mode-operations">
            <FloorScene layout={scene} mode="operations" ariaLabel={t('studio.live.mapLabel')} seatsLabel={L.seatsLabel} labelOf={L.labelOf}
              selected={selectedId ? [selectedId] : []} onTableActivate={setSelectedId}
              tableAria={(x) => `${x.label}, ${L.seatsLabel(x.capacity)}, ${x.statusText ?? ''}`} />
            <small>{t('studio.floor.illustrative')}</small>
          </div>
          <div className="live-legend" aria-label={t('studio.live.legend')}>
            {LEGEND.map((l) => <span key={l.key}><i style={{ background: l.fill, borderColor: l.stroke }} aria-hidden />{t(`studio.live.state.${l.key}`)}</span>)}
          </div>
          <p className="fine" aria-live="polite">{t('studio.live.autoRefresh')}</p>
        </div>
        <div className="live-panel">
          <section className="floor-card" aria-live="polite">
            {!selected ? (
              <EmptyState title={t('studio.live.pickTitle')}>{t('studio.live.pickBody')}</EmptyState>
            ) : (
              <>
                <div className="spread"><h3>{selected.label}</h3><span className="badge">{t(`studio.live.state.${liveState(selected).key}`)}</span></div>
                <KeyValueList items={[
                  { label: t('studio.live.capacity'), value: L.seatsLabel(selected.capacity) },
                  { label: t('studio.floor.zone'), value: selected.zone ? L.labelOf(selected.zone) : '—' },
                  ...(selected.visit ? [
                    { label: t('studio.live.party'), value: selected.visit.partySize ? nf.format(selected.visit.partySize) : '—' },
                    { label: t('studio.live.since'), value: time(selected.visit.openedAt, locale, timezone) },
                    { label: t('studio.live.orders'), value: nf.format(selected.visit.orderCount) },
                    { label: t('studio.live.due'), value: money(selected.visit.dueMinor, currency, locale) },
                    { label: t('studio.live.paid'), value: money(selected.visit.paidMinor, currency, locale) },
                  ] : []),
                  ...(selected.nextReservation ? [{
                    label: t('studio.live.nextReservation'),
                    value: `${time(selected.nextReservation.startsAt, locale, timezone)} · ${selected.nextReservation.guestName ?? ''} · ${nf.format(selected.nextReservation.partySize)}`,
                  }] : []),
                ]} />
                {selected.visit?.requests.length ? (
                  <ul className="request-list" style={{ marginBlockStart: 12 }}>
                    {selected.visit.requests.map((r, i) => <li key={i}>{requestLabel(r, t)}</li>)}
                  </ul>
                ) : null}
                {canSeat && (
                  <div className="stack" style={{ marginBlockStart: 14 }}>
                    {!selected.visit && selected.status !== 'cleaning' && selected.status !== 'out_of_service' && (
                      <>
                        <label className="field"><span>{t('studio.live.partySize')}</span>
                          <input className="input" type="number" min={1} max={100} value={party} onChange={(e) => setParty(Math.max(1, Number(e.target.value) || 1))} />
                        </label>
                        <button className="btn btn-primary" disabled={busy} onClick={() => void seat(selected)}>{t('studio.live.seatWalkIn')}</button>
                        {selected.nextReservation && (
                          <button className="btn" disabled={busy} onClick={() => void seat(selected, selected.nextReservation!.id)}>{t('studio.live.seatReservation', { name: selected.nextReservation.guestName ?? '' })}</button>
                        )}
                      </>
                    )}
                    {selected.visit && (
                      <>
                        <button className="btn btn-primary" disabled={busy} onClick={() => void close(selected)}>{t('studio.live.close')}</button>
                        <button className="btn btn-ghost" disabled={busy} onClick={() => void undoSeat(selected)}>{t('studio.live.undo')}</button>
                      </>
                    )}
                    {selected.status === 'cleaning' && <button className="btn btn-leaf" disabled={busy} onClick={() => void clean(selected)}>{t('studio.live.markClean')}</button>}
                  </div>
                )}
              </>
            )}
          </section>
          <section className="floor-card">
            <h3>{t('studio.live.requests')}</h3>
            {requests.length ? (
              <ul className="request-list">
                {requests.flatMap((x) => x.visit!.requests.map((r, i) => (
                  <li key={`${x.id}-${i}`}><button type="button" className="btn btn-ghost btn-sm" style={{ padding: 0, minHeight: 0 }} onClick={() => setSelectedId(x.id)}>{x.label}</button><span>{requestLabel(r, t)}</span></li>
                )))}
              </ul>
            ) : <p className="fine">{t('studio.live.noRequests')}</p>}
          </section>
          <section className="floor-card">
            <h3>{t('studio.live.upcoming')}</h3>
            {upcoming.length ? (
              <ul className="request-list">
                {upcoming.slice(0, 6).map((x) => (
                  <li key={x.id} style={{ background: '#e6ecf7', color: '#2f4a76' }}>
                    <span>{x.label} · {x.nextReservation!.guestName ?? ''}</span>
                    <span>{time(x.nextReservation!.startsAt, locale, timezone)} · {nf.format(x.nextReservation!.partySize)}</span>
                  </li>
                ))}
              </ul>
            ) : <p className="fine">{t('studio.live.noUpcoming')}</p>}
          </section>
        </div>
      </div>
    </div>
  );
}

function requestLabel(r: string, t: (k: string) => string) {
  const key = `studio.live.request.${r}`;
  const v = t(key);
  return v === key ? r.replaceAll('_', ' ') : v;
}
