'use client';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { kitchenLaneOf, kitchenPathTo, type KitchenFeed, type KitchenLane, type KitchenTicket } from '@resuto/contracts';
import { Badge, Notice, usePrompt } from '@resuto/ui';
import { KanbanBoard } from '@/components/ops/KanbanBoard';
import { isNewTicket, lateness, ticketAge, type AgeUnits } from '@/components/ops/elapsed';
import { ServiceRequestList, useServiceRequests } from '@/components/ops/ServiceRequests';
import { SoldOutDrawer } from '@/components/ops/SoldOutDrawer';
import '@/components/ops/ops.css';
import { interactionPaused } from '@/lib/live-pause';
import { money, pick, time } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useSession } from '@/lib/session';
import { stationLabel } from '@/lib/vocab';
import './kds.css';

const POLL_MS = 2000;
const LANES: Array<{ key: KitchenLane; dot: string }> = [
  { key: 'new', dot: 'var(--sky)' }, { key: 'preparing', dot: 'var(--ember)' }, { key: 'ready', dot: 'var(--herb)' },
  { key: 'out', dot: 'var(--gold)' }, { key: 'done', dot: 'var(--state-ready-stroke)' },
];
const HAND_OVER: Record<string, string> = { dine_in: 'served', pickup: 'picked_up', delivery: 'delivered' };

export interface KitchenBoardProps {
  orgId: string; branchId: string; station: string | null; onStations?: (s: string[]) => void;
  timezone?: string; currency?: string;
  /** orders:cancel (manager): cancel a ticket that has not started. */
  canCancel?: boolean;
  /** orders:read with floor:seat or orders:status: resolve guest requests. */
  canResolve?: boolean;
  /** menu:availability: mark dishes sold out (86) from the kitchen. */
  can86?: boolean;
  /** Where "record the payment" sends staff (the orders page), when the role can open it. */
  ordersHref?: string | null;
  /** Orders board (VS-14): open the order's details from a card. */
  onOpen?: (orderId: string) => void;
}

/**
 * Kitchen board (VS-10), restored from the legacy KDS: five lanes (New orders, Preparing, Ready to serve, On the way,
 * Completed), drag a card forward to advance it (each step is a server transition carrying the ticket's version, so a
 * stale or backward move is refused), buttons on every card for keyboard and touch, the service requests panel, and a
 * "Sold out" drawer for the 86. Polls every 2 s with a cursor; a poll never overlaps the previous one, never applies a
 * response for another branch or station (PCL-19), and holds still while a card is being dragged (VS-20).
 */
export function KitchenBoard({ orgId, branchId, station, onStations, timezone, currency = 'EGP', canCancel, canResolve, can86, ordersHref, onOpen }: KitchenBoardProps) {
  const { t, locale } = useT();
  const ageUnits = useMemo<AgeUnits>(() => ({ hours: (h, mm) => t('ops.kds.ageHours', { h, mm }), days: (d) => t('ops.kds.ageDays', { d }) }), [t]);
  const { call } = useSession();
  const [feed, setFeed] = useState<KitchenFeed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  const [soldOutOpen, setSoldOutOpen] = useState(false);
  const [prompt, promptDialog] = usePrompt(locale);
  const cursor = useRef<string | null>(null);
  const skew = useRef(0);
  const seq = useRef(0);
  const scope = `${branchId}|${station ?? ''}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const onStationsRef = useRef(onStations);
  onStationsRef.current = onStations;
  const requests = useServiceRequests(orgId, canResolve ? branchId : null);

  /** One read of the feed; the latest call wins and a response for another branch/station is dropped (PCL-19). */
  const load = useCallback(async (full: boolean, signal?: AbortSignal) => {
    const mine = ++seq.current;
    const asked = scope;
    const qs = new URLSearchParams({ ...(station ? { station } : {}), ...(!full && cursor.current ? { since: cursor.current } : {}) });
    try {
      const f = await call<KitchenFeed>(`/o/${orgId}/kitchen/${branchId}?${qs}`, { signal });
      if (mine !== seq.current || asked !== scopeRef.current) return;
      skew.current = new Date(f.serverTime).getTime() - Date.now();
      cursor.current = f.cursor;
      if (!f.unchanged) setFeed(f);
      onStationsRef.current?.(f.stations);
      setStale(false);
      setError(null);
    } catch (e) {
      if (mine !== seq.current || (e as Error).name === 'AbortError' || signal?.aborted) return;
      setStale(true);
      setError((e as Error).message);
    }
  }, [call, orgId, branchId, station, scope]);

  // A setTimeout chain (never overlapping requests), restarted with a full read when the branch or station changes.
  useEffect(() => {
    cursor.current = null;
    setFeed(null);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const tick = async (full = false) => {
      if (stopped) return;
      const paused = !full && (document.visibilityState !== 'visible' || interactionPaused());
      if (!paused) await load(full, controller.signal);
      if (!stopped) timer = setTimeout(() => void tick(), paused ? 500 : POLL_MS);
    };
    void tick(true);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => { stopped = true; controller.abort(); clearTimeout(timer); clearInterval(clock); seq.current++; };
  }, [load]);

  const refresh = () => { cursor.current = null; return load(true); };
  const say = (tone: 'ok' | 'danger', text: string) => { setFlash({ tone, text }); setTimeout(() => setFlash((f) => (f?.text === text ? null : f)), 4000); };

  const tickets = useMemo(() => [...(feed?.tickets ?? []), ...(feed?.recent ?? [])], [feed]);
  const byId = useMemo(() => new Map(tickets.map((x) => [x.id, x])), [tickets]);
  const laneName = (k: KitchenLane) => t(`ops.kds.lane.${k}`);

  /** Applies bump steps in order, each with the version the previous step returned. */
  const advance = async (tk: KitchenTicket, steps: string[], lane?: KitchenLane) => {
    setBusy(tk.id);
    try {
      let version = tk.version;
      for (const to of steps) {
        const r = await call<{ version: number }>(`/o/${orgId}/kitchen/orders/${tk.id}/bump`, { body: { to, version } });
        version = r.version;
      }
      if (lane) say('ok', t('ops.kds.moved', { lane: laneName(lane) }));
    } catch (e) {
      say('danger', (e as Error).message);
    } finally {
      setBusy(null);
      await refresh();
    }
  };
  const line = async (tk: KitchenTicket, lineId: string, status: string) => {
    setBusy(tk.id);
    try { await call(`/o/${orgId}/kitchen/lines/${lineId}`, { body: { status } }); } catch (e) { say('danger', (e as Error).message); } finally { setBusy(null); await refresh(); }
  };
  const cancel = async (tk: KitchenTicket) => {
    const reason = await prompt({ title: t('ops.kds.cancelTitle', { number: tk.number }), label: t('core.orders.cancelReason'), minLength: 2, maxLength: 300, multiline: true, tone: 'danger', confirmLabel: t('core.orders.cancel') });
    if (!reason) return;
    setBusy(tk.id);
    try { await call(`/o/${orgId}/orders/${tk.id}/cancel`, { body: { reason, version: tk.version } }); say('ok', t('ops.kds.cancelled', { number: tk.number })); }
    catch (e) { say('danger', (e as Error).message); } finally { setBusy(null); await refresh(); }
  };

  const serverNow = now + skew.current;
  const where = (tk: KitchenTicket) => {
    if (tk.tableLabel) return t('core.kds.table', { label: tk.tableLabel });
    if (tk.fulfillment === 'pickup' && feed?.serviceMode === 'counter') return t('ops.kds.counter');
    return t(`core.web.${tk.fulfillment}`);
  };

  const card = (tk: KitchenTicket, lane: KitchenLane) => {
    const age = Math.max(0, Math.floor((serverNow - Date.parse(tk.placedAt)) / 1000));
    const late = lane === 'done' ? 'fresh' : lateness(age);
    const isNew = isNewTicket(tk.status, tk.placedAt, serverNow);
    const live = lane !== 'done';
    const cls = ['ticket', isNew && 'is-new', late !== 'fresh' && `is-${late}`, !live && 'is-done'].filter(Boolean).join(' ');
    const handOver = HAND_OVER[tk.fulfillment] ?? 'served';
    const off = busy === tk.id;
    return (
      <article key={tk.id} className={cls} data-card={live && lane !== 'out' || (lane === 'out' && !tk.driverJob) ? tk.id : undefined} aria-busy={off || undefined}>
        <div className="ticket-top">
          <strong>#{tk.number.padStart(3, '0')}</strong>
          <span className="ticket-age" title={t('ops.kds.placedAt', { time: time(tk.placedAt, locale, timezone) })}>
            {live ? <>{time(tk.placedAt, locale, timezone)} · <span aria-label={t('core.kds.age')}>{ticketAge(age, ageUnits)}</span></> : time(tk.fulfilledAt ?? tk.placedAt, locale, timezone)}
          </span>
        </div>
        <div className="ticket-source">{where(tk)}{tk.customerName ? <span> · <bdi>{tk.customerName}</bdi></span> : null}<span> · {t(`core.channel.${tk.channel}`)}</span></div>
        {tk.lines.map((l) => {
          const next = l.kitchenStatus === 'queued' ? 'preparing' : l.kitchenStatus === 'preparing' ? 'ready' : 'preparing';
          const body = (<><b className="num">{l.quantity}</b><span><span className="ticket-name">{pick(locale, l.name, l.nameAr)}</span>
            {l.modifiers.length > 0 && <small>{l.modifiers.join(' · ')}</small>}
            {l.notes && <small>“<bdi>{l.notes}</bdi>”</small>}
            {!station && <small>{stationLabel(t, l.station)}</small>}</span></>);
          const tappable = (lane === 'new' || lane === 'preparing' || lane === 'ready') && (l.kitchenStatus === 'queued' || l.kitchenStatus === 'preparing' || l.kitchenStatus === 'ready');
          return tappable
            ? <button key={l.id} type="button" className="ticket-line" data-status={l.kitchenStatus} disabled={off}
                title={l.kitchenStatus === 'ready' ? t('core.kds.recall') : t('core.kds.tapLine')} onClick={() => void line(tk, l.id, next)}>{body}</button>
            : <div key={l.id} className="ticket-line" data-status={l.kitchenStatus}>{body}</div>;
        })}
        {tk.notes && <p className="ticket-note"><bdi>{tk.notes}</bdi></p>}
        {lane === 'out' && tk.dueMinor !== undefined && tk.dueMinor > 0 && !tk.driverJob && (
          <p className="ticket-note">{t('ops.kds.cashDue', { amount: money(tk.dueMinor, currency, locale) })}{ordersHref ? <> · <Link href={ordersHref}>{t('ops.kds.openOrders')}</Link></> : null}</p>
        )}
        {lane === 'done' ? (
          <div className="ticket-meta"><Badge tone="ok">{t(`core.status.${tk.status}`)}</Badge>
            {onOpen && <button type="button" className="btn btn-ghost btn-sm" onClick={() => onOpen(tk.id)}>{t('ops.orders.details')}</button>}</div>
        ) : (
          <div className="ticket-actions">
            {lane === 'new' && tk.status === 'placed' && <button className="btn btn-sm" disabled={off} onClick={() => void advance(tk, ['accepted'])}>{t('core.kds.accept')}</button>}
            {lane === 'new' && <button className="btn btn-primary" disabled={off} onClick={() => void advance(tk, ['preparing'], 'preparing')}>{t('core.kds.start')}</button>}
            {lane === 'preparing' && tk.status === 'preparing' && <button className="btn btn-primary" disabled={off} onClick={() => void advance(tk, ['ready'], 'ready')}>{t('ops.kds.markReady')}</button>}
            {lane === 'ready' && <button className="btn btn-primary" disabled={off} onClick={() => void advance(tk, [handOver], handOver === 'delivered' ? 'out' : 'done')}>{t(`ops.kds.handOver.${tk.fulfillment}`)}</button>}
            {lane === 'out' && (tk.driverJob
              ? <Badge tone="info">{t('ops.kds.withDriver')}</Badge>
              : <button className="btn btn-primary" disabled={off} onClick={() => void advance(tk, ['delivered'], 'done')}>{t('ops.kds.markDelivered')}</button>)}
            {canCancel && (tk.status === 'placed' || tk.status === 'accepted') && (
              <button className="btn btn-ghost btn-sm" disabled={off} onClick={() => void cancel(tk)}>{t('core.orders.cancel')}</button>
            )}
            {onOpen && <button type="button" className="btn btn-ghost btn-sm" onClick={() => onOpen(tk.id)}>{t('ops.orders.details')}</button>}
          </div>
        )}
      </article>
    );
  };

  const grouped = useMemo(() => {
    const g: Record<KitchenLane, KitchenTicket[]> = { new: [], preparing: [], ready: [], out: [], done: [] };
    for (const tk of feed?.tickets ?? []) g[kitchenLaneOf(tk)].push(tk);
    for (const tk of feed?.recent ?? []) g.done.push(tk);
    return g;
  }, [feed]);

  const pathTo = (id: string, lane: KitchenLane) => {
    const tk = byId.get(id);
    if (!tk) return null;
    if (kitchenLaneOf(tk) === 'out' && tk.driverJob) return null; // the driver completes it
    return kitchenPathTo(tk, lane);
  };

  return (
    <div className="kds">
      {promptDialog}
      <div className="kds-bar">
        <span className="kds-live" data-stale={stale}>{stale ? t('core.kds.offline') : t('core.kds.live')}</span>
        <span className="fine num">{t('core.kds.count', { n: feed?.tickets.length ?? 0 })}</span>
        {can86 && <button type="button" className="btn btn-sm" onClick={() => setSoldOutOpen(true)}>{t('ops.kds.soldOut')}</button>}
        <span role="status" aria-live="polite" className="kds-flash" data-tone={flash?.tone}>{flash?.text}</span>
      </div>
      {error && !feed && <Notice tone="danger">{error}</Notice>}
      <p className="board-hint">{t('ops.kds.hint')}</p>
      <KanbanBoard<KitchenLane> label={t('core.kds.title')}
        lanes={LANES.map(({ key, dot }) => ({
          key, dot, title: laneName(key), count: grouped[key].length,
          empty: feed ? t('core.kds.allClear') : t('state.loading'),
          children: grouped[key].map((tk) => card(tk, key)),
        }))}
        pathTo={pathTo}
        onMove={async (id, steps, lane) => { const tk = byId.get(id); if (tk) await advance(tk, steps, lane); }}
        onRefused={(_, lane) => say('danger', t('ops.kds.forwardOnly', { lane: laneName(lane) }))} />
      {canResolve && (
        <section className="panel kds-requests">
          <div className="panel-head"><h2>{t('ops.req.title')}</h2><span className="badge num">{requests.data?.items.length ?? 0}</span></div>
          <div className="panel-body">
            <ServiceRequestList orgId={orgId} items={requests.data?.items} timezone={timezone ?? 'UTC'} canResolve onResolved={() => void requests.reload()} />
          </div>
        </section>
      )}
      {can86 && <SoldOutDrawer open={soldOutOpen} onClose={() => setSoldOutOpen(false)} orgId={orgId} branchId={branchId} />}
    </div>
  );
}

/** Station picker shared by the full-screen KDS and the dashboard page. */
export function StationPicker({ stations, value, onChange }: { stations: string[]; value: string | null; onChange: (s: string | null) => void }) {
  const { t } = useT();
  return (
    <div className="row station-picker" role="group" aria-label={t('core.kds.station')}>
      <button type="button" className={`btn btn-sm btn-pill ${value === null ? 'btn-primary' : ''}`} aria-pressed={value === null} onClick={() => onChange(null)}>{t('core.kds.allStations')}</button>
      {stations.map((s) => (
        <button key={s} type="button" className={`btn btn-sm btn-pill ${value === s ? 'btn-primary' : ''}`} aria-pressed={value === s} onClick={() => onChange(s)}>{stationLabel(t, s)}</button>
      ))}
    </div>
  );
}
