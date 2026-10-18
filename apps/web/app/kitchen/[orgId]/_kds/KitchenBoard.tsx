'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { KitchenFeed, KitchenTicket } from '@resuto/contracts';
import { Notice } from '@resuto/ui';
import { useT } from '@/lib/i18n/client';
import { pick } from '@/lib/format';
import { useSession } from '@/lib/session';
import './kds.css';

const FULFILLED: Record<string, string> = { dine_in: 'served', pickup: 'picked_up', delivery: 'delivered' };
const LATE_MIN = 15;
const VERY_LATE_MIN = 25;

/**
 * Kitchen display board (KDS). Polls every 2 s with the `since` cursor; order
 * bumps are kernel transitions, tapping a line toggles its own kitchen status,
 * and tapping a finished line again recalls it (line-level only).
 */
export function KitchenBoard({ orgId, branchId, station, onStations }: { orgId: string; branchId: string; station: string | null; onStations?: (s: string[]) => void }) {
  const { t, locale } = useT();
  const { call } = useSession();
  const [feed, setFeed] = useState<KitchenFeed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState<string | null>(null);
  const cursor = useRef<string | null>(null);
  const skew = useRef(0);

  const load = useCallback(async (full = false) => {
    try {
      const qs = new URLSearchParams({ ...(station ? { station } : {}), ...(!full && cursor.current ? { since: cursor.current } : {}) });
      const f = await call<KitchenFeed>(`/o/${orgId}/kitchen/${branchId}?${qs}`);
      skew.current = new Date(f.serverTime).getTime() - Date.now();
      cursor.current = f.cursor;
      if (!f.unchanged) setFeed(f);
      onStations?.(f.stations);
      setStale(false);
      setError(null);
    } catch (e) {
      setStale(true);
      setError((e as Error).message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call, orgId, branchId, station]);

  useEffect(() => {
    cursor.current = null;
    setFeed(null);
    void load(true);
    const poll = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 2000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(poll); clearInterval(tick); };
  }, [load]);

  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); cursor.current = null; void load(true); }
  };
  const bump = (tk: KitchenTicket, to: string) => act(tk.id, () => call(`/o/${orgId}/kitchen/orders/${tk.id}/bump`, { body: { to, version: tk.version } }));
  const line = (tk: KitchenTicket, lineId: string, status: string) => act(tk.id, () => call(`/o/${orgId}/kitchen/lines/${lineId}`, { body: { status } }));

  const tickets = feed?.tickets ?? [];
  const lanes: Array<{ key: string; title: string; dot: string; items: KitchenTicket[] }> = [
    { key: 'new', title: t('core.kds.new'), dot: '#5a8598', items: tickets.filter((x) => x.status === 'placed' || x.status === 'accepted') },
    { key: 'preparing', title: t('core.kds.preparing'), dot: '#c85e33', items: tickets.filter((x) => x.status === 'preparing' || (x.status === 'ready' && x.lines.some((l) => l.kitchenStatus !== 'ready'))) },
    { key: 'ready', title: t('core.kds.ready'), dot: '#6f9a4c', items: tickets.filter((x) => x.status === 'ready' && x.lines.every((l) => l.kitchenStatus === 'ready')) },
  ];

  return (
    <div className="kds">
      <div className="kds-bar">
        <span className="kds-live" data-stale={stale}>{stale ? t('core.kds.offline') : t('core.kds.live')}</span>
        <span className="fine">{t('core.kds.count', { n: tickets.length })}</span>
      </div>
      {error && <Notice tone="danger">{error}</Notice>}
      <div className="kds-cols">
        {lanes.map((lane) => (
          <section key={lane.key} className="kds-col" style={{ ['--dot' as string]: lane.dot }} aria-label={lane.title}>
            <header><span>{lane.title}</span><span className="badge">{lane.items.length}</span></header>
            <div className="kds-tiles">
              {!feed && <div className="kds-empty">{t('state.loading')}</div>}
              {feed && !lane.items.length && <div className="kds-empty">{t('core.kds.allClear')}</div>}
              {lane.items.map((tk) => {
                const age = Math.max(0, Math.floor((now + skew.current - new Date(tk.placedAt).getTime()) / 1000));
                const mins = Math.floor(age / 60);
                const cls = `kds-tile${tk.isNew ? ' is-new' : ''}${mins >= VERY_LATE_MIN ? ' is-very-late' : mins >= LATE_MIN ? ' is-late' : ''}`;
                return (
                  <article key={tk.id} className={cls} aria-busy={busy === tk.id}>
                    <div className="kds-tile-head">
                      <strong>#{tk.number.padStart(3, '0')}</strong>
                      <span className="kds-age" aria-label={t('core.kds.age')}>{mins}:{String(age % 60).padStart(2, '0')}</span>
                    </div>
                    <div className="kds-where">
                      {tk.tableLabel ? t('core.kds.table', { label: tk.tableLabel }) : t(`core.web.${tk.fulfillment}`)}
                      {tk.customerName ? <> · <bdi>{tk.customerName}</bdi></> : ''} · {t(`core.channel.${tk.channel}`)}
                    </div>
                    {tk.lines.map((l) => {
                      const next = l.kitchenStatus === 'queued' ? 'preparing' : l.kitchenStatus === 'preparing' ? 'ready' : 'preparing';
                      return (
                        <button key={l.id} type="button" className="kds-line" data-status={l.kitchenStatus} disabled={busy === tk.id}
                          title={l.kitchenStatus === 'ready' ? t('core.kds.recall') : t('core.kds.tapLine')}
                          onClick={() => void line(tk, l.id, next)}>
                          <span className="kds-qty">{l.quantity}</span>
                          <span>
                            <span className="kds-name">{pick(locale, l.name, l.nameAr)}</span>
                            {l.modifiers.length > 0 && <small>{l.modifiers.join(' · ')}</small>}
                            {l.notes && <small className="kds-note">“<bdi>{l.notes}</bdi>”</small>}
                            {!station && <small>{l.station}</small>}
                          </span>
                        </button>
                      );
                    })}
                    {tk.notes && <div className="kds-ticket-note"><bdi>{tk.notes}</bdi></div>}
                    <div className="kds-actions">
                      {tk.status === 'placed' && <button className="btn" disabled={busy === tk.id} onClick={() => void bump(tk, 'accepted')}>{t('core.kds.accept')}</button>}
                      {(tk.status === 'placed' || tk.status === 'accepted') && <button className="btn btn-primary" disabled={busy === tk.id} onClick={() => void bump(tk, 'preparing')}>{t('core.kds.start')}</button>}
                      {tk.status === 'preparing' && <button className="btn btn-primary" disabled={busy === tk.id} onClick={() => void bump(tk, 'ready')}>{t('core.kds.markReady')}</button>}
                      {tk.status === 'ready' && <button className="btn btn-leaf" disabled={busy === tk.id} onClick={() => void bump(tk, FULFILLED[tk.fulfillment] ?? 'served')}>{t(`core.kds.handOver.${tk.fulfillment}`)}</button>}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

/** Station picker shared by the full-screen KDS and the dashboard page. */
export function StationPicker({ stations, value, onChange }: { stations: string[]; value: string | null; onChange: (s: string | null) => void }) {
  const { t } = useT();
  return (
    <div className="row" role="group" aria-label={t('core.kds.station')} style={{ gap: 6 }}>
      <button type="button" className={`btn btn-sm btn-pill ${value === null ? 'btn-primary' : ''}`} aria-pressed={value === null} onClick={() => onChange(null)}>{t('core.kds.allStations')}</button>
      {stations.map((s) => (
        <button key={s} type="button" className={`btn btn-sm btn-pill ${value === s ? 'btn-primary' : ''}`} aria-pressed={value === s} onClick={() => onChange(s)}>{s}</button>
      ))}
    </div>
  );
}
