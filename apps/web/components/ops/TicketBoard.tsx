'use client';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { kitchenLaneOf, kitchenPathTo, type KitchenFeed, type KitchenLane, type KitchenTicket } from '@resuto/contracts';
import { Badge, Notice, usePrompt, OrderRef, type PageHeaderProps } from '@resuto/ui';
import { KanbanBoard, type KanbanLane } from '@/components/ops/KanbanBoard';
import {
  boardSequence, createBoardKeyReader, groupTickets, locate, nthLive, primaryStep, stepCard, stepLane, type BoardKey, type BoardMode,
} from '@/components/ops/board';
import { isNewTicket, lateness, ticketAge, type AgeUnits } from '@/components/ops/elapsed';
import { ServiceRequestList, useServiceRequests } from '@/components/ops/ServiceRequests';
import { SoldOutDrawer } from '@/components/ops/SoldOutDrawer';
import '@/components/ops/ops.css';
import { interactionPaused } from '@/lib/live-pause';
import { money, pick, time } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { usePageCommands } from '@/lib/page-commands';
import { useSession } from '@/lib/session';
import { stationLabel } from '@/lib/vocab';
import './kds.css';

const POLL_MS = 2000;
/** Lane tones: high-contrast status colours from the tokens (new = info, preparing = warn, ready = ok). */
const LANES: Array<{ key: KitchenLane; tone?: KanbanLane<KitchenLane>['tone'] }> = [
  { key: 'new', tone: 'info' }, { key: 'preparing', tone: 'warn' }, { key: 'ready', tone: 'ok' }, { key: 'out' }, { key: 'done' },
];
/** Key hint (the design system's Kbd look without pulling the form controls module into the board's first load). */
const Kbd = ({ children }: { children: ReactNode }) => <kbd className="rui-kbd" dir="ltr">{children}</kbd>;
const HAND_OVER: Record<string, string> = { dine_in: 'served', pickup: 'picked_up', delivery: 'delivered' };

export interface TicketBoardProps {
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
  /** Orders board (VS-14): open the order's details from a card (the order sheet). */
  onOpen?: (orderId: string) => void;
  /**
   * 'orders': the Orders board (j/k between cards, Enter or o opens the order, a moves it on, x selects it for a bulk
   * move). 'kds': the kitchen display (bump bar: arrows, 1-9 pick a ticket, Enter / Space / b bump it).
   */
  mode?: BoardMode;
  /** Page header (the board is the page's BoardPage). */
  header?: PageHeaderProps | ReactNode;
  /** Extra controls in the toolbar row (station picker, view switch). */
  tools?: ReactNode;
  /** Changes when an order was changed elsewhere on the page (the order sheet): the feed is read again. */
  refreshKey?: number;
}

/**
 * Ticket board (VS-10, 21-OPS), restored from the legacy KDS: five lanes (New orders, Preparing, Ready to serve, On
 * the way, Completed) with their counts, drag a card forward to advance it (each step is a server transition carrying
 * the ticket's version, so a stale or backward move is refused), buttons on every card for touch, keys for the keyboard
 * and the bump bar, the service requests panel and a "Sold out" drawer for the 86. Polls every 2 s with a cursor; a
 * poll never overlaps the previous one, never applies a response for another branch or station (PCL-19), and holds
 * still while a card is being dragged or a dialog is open (VS-20). One implementation for the Orders board and the
 * full-screen kitchen display.
 */
export function TicketBoard({
  orgId, branchId, station, onStations, timezone, currency = 'EGP', canCancel, canResolve, can86, ordersHref, onOpen, mode = 'kds', header, tools, refreshKey,
}: TicketBoardProps) {
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
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [prompt, promptDialog] = usePrompt(locale);
  const cursor = useRef<string | null>(null);
  const skew = useRef(0);
  const seq = useRef(0);
  const scope = `${branchId}|${station ?? ''}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const onStationsRef = useRef(onStations);
  onStationsRef.current = onStations;
  const root = useRef<HTMLDivElement>(null);
  /** The next focus change came from a key: move DOM focus and scroll the card into view. */
  const keyMove = useRef(false);
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

  const refresh = useCallback(() => { cursor.current = null; return load(true); }, [load]);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    void refresh();
  }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const say = (tone: 'ok' | 'danger', text: string) => { setFlash({ tone, text }); setTimeout(() => setFlash((f) => (f?.text === text ? null : f)), 4000); };

  const tickets = useMemo(() => [...(feed?.tickets ?? []), ...(feed?.recent ?? [])], [feed]);
  const byId = useMemo(() => new Map(tickets.map((x) => [x.id, x])), [tickets]);
  const grouped = useMemo(() => groupTickets(feed?.tickets ?? [], feed?.recent ?? []), [feed]);
  const sequence = useMemo(() => boardSequence(grouped), [grouped]);
  const laneName = (k: KitchenLane) => t(`ops.kds.lane.${k}`);

  // A ticket that left the board (cancelled, or older than the Completed lane) drops out of the focus and selection.
  useEffect(() => {
    if (!feed) return;
    if (focusedId && !byId.has(focusedId)) setFocusedId(null);
    if ([...selected].some((id) => !byId.has(id) || !primaryStep(byId.get(id)!))) setSelected((s) => new Set([...s].filter((id) => byId.has(id) && primaryStep(byId.get(id)!))));
  }, [feed]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Applies bump steps in order, each with the version the previous step returned. Returns whether it worked. */
  const run = async (tk: KitchenTicket, steps: string[]) => {
    let version = tk.version;
    for (const to of steps) {
      const r = await call<{ version: number }>(`/o/${orgId}/kitchen/orders/${tk.id}/bump`, { body: { to, version } });
      version = r.version;
    }
  };
  const advance = async (tk: KitchenTicket, steps: string[], lane?: KitchenLane) => {
    setBusy(tk.id);
    try {
      await run(tk, steps);
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

  /** Bulk move (orders board): each selected order to its own next step, one at a time with its own version. */
  const advanceSelected = async () => {
    if (bulkBusy) return;
    setBulkBusy(true);
    let ok = 0;
    const failed: string[] = [];
    let lastError = '';
    for (const id of sequence.filter((x) => selected.has(x))) {
      const tk = byId.get(id);
      const step = tk ? primaryStep(tk) : null;
      if (!tk || !step) continue;
      try { await run(tk, step.steps); ok++; } catch (e) { failed.push(tk.number); lastError = (e as Error).message; }
    }
    setSelected(new Set());
    setBulkBusy(false);
    say(failed.length ? 'danger' : 'ok', failed.length
      ? t('ops.board.bulkSome', { ok, failed: failed.length, error: lastError })
      : t('ops.board.bulkDone', { n: ok }));
    await refresh();
  };

  const toggleSelect = (id: string) => {
    const tk = byId.get(id);
    if (!tk || !primaryStep(tk)) return false;
    setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
    return true;
  };

  // ---------------------------------------------------------------------------------------------------------------
  // Keys: j/k and arrows move between cards, Left/Right between lanes (mirrored in Arabic), Enter opens (orders) or
  // bumps (kitchen), a / b bump, x selects for a bulk move, 1-9 pick a ticket on the bump bar, Escape clears.
  // ---------------------------------------------------------------------------------------------------------------
  const moveFocus = (id: string | null) => {
    if (!id) return false;
    keyMove.current = true;
    setFocusedId(id);
    return true;
  };
  const bumpFocused = () => {
    const at = locate(grouped, focusedId);
    const tk = focusedId ? byId.get(focusedId) : undefined;
    if (!at || !tk || busy === tk.id) return false;
    const step = primaryStep(tk, at.lane);
    if (!step) return false;
    if (mode === 'kds') {
      // The bump bar keeps working down the lane: focus the ticket that takes this one's place.
      const lane = grouped[at.lane];
      const nextId = lane[at.index + 1]?.id ?? lane[at.index - 1]?.id ?? null;
      if (nextId) moveFocus(nextId);
    }
    void advance(tk, step.steps, step.to);
    return true;
  };
  const keyAction = (k: BoardKey): boolean => {
    if (k === 'next' || k === 'prev') return moveFocus(stepCard(sequence, focusedId, k === 'next' ? 1 : -1));
    if (k === 'nextLane' || k === 'prevLane') return moveFocus(stepLane(grouped, focusedId, k === 'nextLane' ? 1 : -1));
    if (k === 'first') return moveFocus(sequence[0] ?? null);
    if (k === 'last') return moveFocus(sequence[sequence.length - 1] ?? null);
    if (k.startsWith('pick')) return moveFocus(nthLive(grouped, Number(k.slice(4))));
    if (k === 'open') { if (!focusedId || !onOpen) return false; onOpen(focusedId); return true; }
    if (k === 'bump') return bumpFocused();
    if (k === 'select') return mode === 'orders' && !!focusedId && toggleSelect(focusedId);
    if (k === 'clear') { if (!selected.size) return false; setSelected(new Set()); return true; }
    return false;
  };
  const keyRef = useRef(keyAction);
  keyRef.current = keyAction;
  useEffect(() => {
    const read = createBoardKeyReader(mode);
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const rtl = !!root.current && getComputedStyle(root.current).direction === 'rtl';
      const k = read(e, rtl);
      if (!k) return;
      // On the orders board, arrows, Home/End, Enter and Space act only once the board has focus (they scroll the page
      // otherwise); the letters work from anywhere on the page. The kitchen display is the whole screen.
      if (mode === 'orders' && e.key.length !== 1 && e.key !== 'Escape' && !root.current?.contains(document.activeElement)) return;
      if (mode === 'orders' && e.key === ' ' && !root.current?.contains(document.activeElement)) return;
      if (keyRef.current(k)) e.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mode]);
  useEffect(() => {
    if (!keyMove.current || !focusedId) return;
    keyMove.current = false;
    const el = root.current?.querySelector<HTMLElement>(`[data-ticket="${CSS.escape(focusedId)}"]`);
    el?.focus({ preventScroll: true });
    el?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [focusedId, feed]);

  // The ⌘K palette and the ? cheat sheet list the board's keys (lib/page-commands.ts).
  const focusedTicket = focusedId ? byId.get(focusedId) : undefined;
  const canBump = !!focusedTicket && !!primaryStep(focusedTicket);
  usePageCommands({
    title: mode === 'orders' ? t('ops.orders.board') : t('core.kds.title'),
    commands: [
      { id: 'next', key: 'j', label: t('ops.board.key.next'), keywords: 'next down order ticket', enabled: sequence.length > 0, run: () => { keyAction('next'); } },
      { id: 'prev', key: 'k', label: t('ops.board.key.prev'), keywords: 'previous up order ticket', enabled: sequence.length > 0, run: () => { keyAction('prev'); } },
      ...(mode === 'orders' ? [
        { id: 'open', key: 'o', label: t('ops.board.key.open'), keywords: 'open details order sheet', enabled: !!focusedTicket && !!onOpen, run: () => { keyAction('open'); } },
        { id: 'bump', key: 'a', label: t('ops.board.key.bump'), keywords: 'advance next step status move bump', enabled: canBump, run: () => { keyAction('bump'); } },
        { id: 'select', key: 'x', label: t('ops.board.key.select'), keywords: 'select bulk', enabled: canBump, run: () => { keyAction('select'); } },
      ] : [
        { id: 'bump', key: 'b', label: t('ops.board.key.bump'), keywords: 'bump advance next step ready', enabled: canBump, run: () => { keyAction('bump'); } },
      ]),
    ],
  });

  const serverNow = now + skew.current;
  const where = (tk: KitchenTicket) => {
    if (tk.tableLabel) return t('core.kds.table', { label: tk.tableLabel });
    // A counter-session order (FT-07) is always the counter's, even if the branch changed its service model since.
    if (tk.counter || (tk.fulfillment === 'pickup' && feed?.serviceMode === 'counter')) return t('ops.kds.counter');
    return t(`core.web.${tk.fulfillment}`);
  };

  const tabStop = focusedId && byId.has(focusedId) ? focusedId : sequence[0] ?? null;
  const card = (tk: KitchenTicket, lane: KitchenLane) => {
    const age = Math.max(0, Math.floor((serverNow - Date.parse(tk.placedAt)) / 1000));
    const late = lane === 'done' ? 'fresh' : lateness(age);
    const isNew = isNewTicket(tk.status, tk.placedAt, serverNow);
    const live = lane !== 'done';
    const isSelected = selected.has(tk.id);
    const cls = ['ticket', isNew && 'is-new', late !== 'fresh' && `is-${late}`, !live && 'is-done', isSelected && 'is-selected'].filter(Boolean).join(' ');
    const handOver = HAND_OVER[tk.fulfillment] ?? 'served';
    const off = busy === tk.id || bulkBusy;
    const number = tk.number.padStart(3, '0');
    return (
      <article key={tk.id} className={cls} data-ticket={tk.id} data-late={late} tabIndex={tabStop === tk.id ? 0 : -1}
        data-focused={focusedId === tk.id || undefined} onFocus={(e) => { if (e.target === e.currentTarget) setFocusedId(tk.id); }}
        data-card={live && lane !== 'out' || (lane === 'out' && !tk.driverJob) ? tk.id : undefined} aria-busy={off || undefined}>
        <div className="ticket-top">
          {mode === 'orders' && primaryStep(tk, lane) && (
            <input type="checkbox" className="ticket-select" checked={isSelected} disabled={bulkBusy}
              aria-label={t('ops.board.selectOrder', { number })} onChange={() => toggleSelect(tk.id)} />
          )}
          <strong className="ticket-number"><OrderRef n={number} /></strong>
          <span className="ticket-age" title={t('ops.kds.placedAt', { time: time(tk.placedAt, locale, timezone) })}>
            {live ? <>{time(tk.placedAt, locale, timezone)} · <span className="ticket-elapsed" aria-label={t('core.kds.age')}>{ticketAge(age, ageUnits)}</span></> : time(tk.fulfilledAt ?? tk.placedAt, locale, timezone)}
          </span>
        </div>
        <div className="ticket-source">{where(tk)}{tk.customerName ? <span> · <bdi>{tk.customerName}</bdi></span> : null}<span> · {tk.counter ? t('ops.counter.channel') : t(`core.channel.${tk.channel}`)}</span></div>
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

  const pathTo = (id: string, lane: KitchenLane) => {
    const tk = byId.get(id);
    if (!tk) return null;
    if (kitchenLaneOf(tk) === 'out' && tk.driverJob) return null; // the driver completes it
    return kitchenPathTo(tk, lane);
  };

  const keysHint = mode === 'orders'
    ? <><Kbd>j</Kbd> <Kbd>k</Kbd> {t('ops.board.hintMove')} · <Kbd>Enter</Kbd> {t('ops.board.hintOpen')} · <Kbd>a</Kbd> {t('ops.board.hintBump')} · <Kbd>?</Kbd></>
    : <><Kbd>1</Kbd>–<Kbd>9</Kbd> {t('ops.board.hintPick')} · <Kbd>↑</Kbd> <Kbd>↓</Kbd> <Kbd>←</Kbd> <Kbd>→</Kbd> {t('ops.board.hintMove')} · <Kbd>Enter</Kbd> {t('ops.board.hintBump')}</>;

  const toolbar = (
    <div className="kds-bar">
      <span className="kds-live" data-stale={stale}>{stale ? t('core.kds.offline') : t('core.kds.live')}</span>
      <span className="fine num">{t('core.kds.count', { n: feed?.tickets.length ?? 0 })}</span>
      {tools}
      {can86 && <button type="button" className="btn btn-sm" onClick={() => setSoldOutOpen(true)}>{t('ops.kds.soldOut')}</button>}
      <span className="fine board-keys" aria-hidden="true">{keysHint}</span>
      <span role="status" aria-live="polite" className="kds-flash" data-tone={flash?.tone}>{flash?.text}</span>
      {mode === 'orders' && selected.size > 0 && (
        <div className="board-bulk" role="group" aria-label={t('ops.board.bulk')}>
          <span className="num">{t('ops.board.selected', { n: selected.size })}</span>
          <button type="button" className="btn btn-sm btn-primary" disabled={bulkBusy} aria-busy={bulkBusy || undefined} onClick={() => void advanceSelected()}>{t('ops.board.advanceSelected')}</button>
          <button type="button" className="btn btn-sm btn-ghost" disabled={bulkBusy} onClick={() => setSelected(new Set())}>{t('ops.board.clear')}</button>
        </div>
      )}
      {error && !feed && <Notice tone="danger">{error}</Notice>}
    </div>
  );

  return (
    <div className="kds" ref={root} data-mode={mode}>
      {promptDialog}
      <KanbanBoard<KitchenLane> label={t('core.kds.title')} header={header} toolbar={toolbar}
        lanes={LANES.map(({ key, tone }) => ({
          key, tone, title: laneName(key), count: grouped[key].length,
          empty: feed ? t('core.kds.allClear') : t('state.loading'),
          children: grouped[key].map((tk) => card(tk, key)),
        }))}
        pathTo={pathTo}
        onMove={async (id, steps, lane) => { const tk = byId.get(id); if (tk) await advance(tk, steps, lane); }}
        onRefused={(_, lane) => say('danger', t('ops.kds.forwardOnly', { lane: laneName(lane) }))}
        footer={canResolve ? (
          <section className="panel kds-requests">
            <div className="panel-head"><h2>{t('ops.req.title')}</h2><span className="badge num">{requests.data?.items.length ?? 0}</span></div>
            <div className="panel-body">
              <ServiceRequestList orgId={orgId} items={requests.data?.items} timezone={timezone ?? 'UTC'} canResolve onResolved={() => void requests.reload()} />
            </div>
          </section>
        ) : undefined} />
      {can86 && <SoldOutDrawer open={soldOutOpen} onClose={() => setSoldOutOpen(false)} orgId={orgId} branchId={branchId} />}
    </div>
  );
}

/** Station picker of the kitchen display. */
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
