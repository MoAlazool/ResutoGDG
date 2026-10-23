'use client';
// Hero "Service view": the live floor demo, service feed, legend and metrics
// (port of the hero in legacy/public/landing.js). The room is the demo restaurant's saved floor (VP-12); the
// service activity on it is sample data, labelled as such.
import { useEffect, useMemo, useRef, useState } from 'react';
import { FloorSceneContent, type SceneTable } from '../floor/FloorScene';
import { LINKS } from './links';
import { narrowView, type LandingFloor } from './floor-data';
import { onVisible, type Landing } from './use-landing';

const HERO_CYCLE = ['available', 'occupied', 'preparing', 'available', 'ready', 'reserved', 'available', 'occupied', 'payment', 'available', 'cleaning', 'available'];
const FEED = [
  { i: 7, state: 'ordering', title: 'Ordering by QR', meta: 'Menu opened in the browser' },
  { i: 5, state: 'preparing', title: 'Order sent to the kitchen', meta: '2 mains · order #042' },
  { i: 4, state: 'ready', title: 'Ready to serve', meta: 'Order #041' },
  { i: 8, state: 'payment', title: 'Bill split four ways', meta: '2 of 4 shares paid' },
  { i: 2, state: 'reserved', title: 'Reserved for 8:00 PM', meta: 'Party of 6 · Terrace' },
  { i: 10, state: 'cleaning', title: 'Needs cleaning', meta: 'Bill paid · guests left' },
  { i: 1, state: 'occupied', title: 'Guests seated', meta: 'Party of 2 · walk-in' },
  { i: 11, state: 'available', title: 'Open again', meta: 'Main Room · 4 seats' },
];
const METRICS: Array<[string, (s: string[]) => number]> = [
  ['Tables in service', (s) => s.filter((x) => !['available', 'reserved', 'cleaning'].includes(x)).length],
  ['In the kitchen', (s) => s.filter((x) => x === 'preparing').length],
  ['Ready to serve', (s) => s.filter((x) => x === 'ready').length],
  ['Bills open', (s) => s.filter((x) => x === 'payment').length],
];
const LEGEND: Array<[string, string]> = [['available', 'Open'], ['occupied', 'Seated'], ['preparing', 'Preparing'], ['ready', 'Ready'], ['payment', 'Paying'], ['cleaning', 'Cleaning']];
const STATE_WORD: Record<string, string> = { available: 'Open', occupied: 'Seated', ordering: 'Ordering', preparing: 'Preparing', ready: 'Ready', payment: 'Paying', reserved: 'Reserved', cleaning: 'Cleaning' };

interface FeedItem { key: number; state: string; label: string; title: string; meta: string; minute: number; hour: number; fresh: boolean }

export function useNarrow() {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const check = () => setNarrow(window.innerWidth < 900);
    check();
    let t: ReturnType<typeof setTimeout>;
    const on = () => { clearTimeout(t); t = setTimeout(check, 220); };
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return narrow;
}

export function Hero({ L, floor }: { L: Landing; floor: LandingFloor }) {
  const { l, num, clock, arrow, reduced } = L;
  const tables = floor.tables;
  const plan = useMemo(() => ({
    width: floor.width, height: floor.height,
    zones: floor.zones.map((z) => ({ ...z, label: l(z.label) })),
    objects: floor.objects.map((o) => ({ ...o, label: l(o.label) })),
  }), [l, floor]);
  const narrow = useNarrow();
  const tableAt = (i: number) => tables[((i % tables.length) + tables.length) % tables.length]!;
  const seatIndex = (i: number) => ((i % tables.length) + tables.length) % tables.length;
  const [states, setStates] = useState<string[]>(() => tables.map((_, i) => HERO_CYCLE[i % HERO_CYCLE.length]!));
  const [pulse, setPulse] = useState<string | null>(null);
  const [detail, setDetail] = useState(seatIndex(8));
  const [feed, setFeed] = useState<FeedItem[]>(() => FEED.slice(0, 4).map((ev, n) => ({
    key: -n, state: ev.state, label: tableAt(ev.i).label, title: ev.title, meta: ev.meta, hour: 19, minute: 38 + n, fresh: false,
  })).reverse());
  const [time, setTime] = useState({ h: 19, m: 42 });
  const tick = useRef({ at: 0, minute: 42 });
  const stageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (reduced || !stageRef.current) return;
    let id: ReturnType<typeof setInterval> | null = null;
    const step = () => {
      if (document.hidden) return;
      const ev = FEED[tick.current.at % FEED.length]!, at = seatIndex(ev.i);
      tick.current.at++;
      const minute = tick.current.minute;
      setStates((s) => s.map((x, i) => (i === at ? ev.state : x)));
      setPulse(tables[at]!.id);
      setTimeout(() => setPulse(null), 1500);
      setFeed((f) => [{ key: tick.current.at, state: ev.state, label: tableAt(ev.i).label, title: ev.title, meta: ev.meta, hour: 19, minute, fresh: true }, ...f].slice(0, 4));
      requestAnimationFrame(() => requestAnimationFrame(() => setFeed((f) => f.map((x) => ({ ...x, fresh: false })))));
      tick.current.minute = (minute + 1) % 60;
      setTime({ h: tick.current.minute < 42 ? 20 : 19, m: tick.current.minute });
      setDetail(at);
    };
    const stop = onVisible(stageRef.current, (vis) => {
      if (vis && !id) id = setInterval(step, 2300);
      if (!vis && id) { clearInterval(id); id = null; }
    });
    return () => { stop(); if (id) clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced]);

  const sceneTables: SceneTable[] = tables.map((x, i) => ({
    ...x, zone: x.zone, minSpendMinor: null, internalNotes: null, state: states[i], hidden: false,
  })) as SceneTable[];
  const x = tables[detail]!;
  const s = states[detail]!;
  return (
    <section className="lp-hero">
      <div className="lp-hero-glow" aria-hidden />
      <div className="lp-shell lp-hero-head">
        <h1><span>{l('Run the room.')}</span><em>{l('Resuto runs everything else.')}</em></h1>
        <p>{l('One system for the whole service: a floor plan your guests book from, QR ordering, the kitchen board, split bills and a manager view. In Arabic and English.')}</p>
        <div className="lp-hero-cta">
          <a className="lp-btn lp-btn-solid lp-btn-lg" href={LINKS.demo}>{l('Open the live demo')} {arrow}</a>
          <a className="lp-btn lp-btn-ghost lp-btn-lg" href="#studio">{l('See the Floor Studio')}</a>
        </div>
      </div>
      <div className="lp-shell">
        <div className="lp-stage" id="hero-stage" ref={stageRef}>
          <header className="lp-stage-bar">
            <span className="lp-dots" aria-hidden><i /><i /><i /></span>
            <strong>{l('Service view')}</strong>
            <span className="lp-stage-clock" id="hero-clock">{clock(time.h, time.m)}</span>
            {/* The badge says Live only over the demo restaurant's saved floor; the built-in fallback room is sample data. */}
            {floor.live ? <span className="lp-stage-live"><i />{l('Live')}</span> : <span className="lp-stage-live is-sample">{l('Sample data')}</span>}
          </header>
          <div className="lp-stage-body">
            <div className="lp-stage-floor">
              <div id="hero-floor">
                <svg className="lp-floor-svg" viewBox={narrow ? narrowView(floor) : `0 0 ${plan.width} ${plan.height}`} role="group" aria-label={l('Live floor plan of the restaurant')}>
                  <FloorSceneContent layout={{ ...plan, background: null, tables: sceneTables }} mode="operations"
                    seatsLabel={(n) => `${num(n)} ${l('seats')}`} onTableActivate={(id) => { const i = tables.findIndex((t) => t.id === id); if (i >= 0) setDetail(i); }}
                    tableAria={(t) => `${t.label}, ${num(t.capacity)} ${l('seats')}, ${l(STATE_WORD[t.state ?? 'available'] ?? 'Open')}`} classOf={(id) => (id === pulse ? 'is-pulse' : undefined)} />
                </svg>
              </div>
              <span className="lp-try">{l('Click any table')}</span>
            </div>
            <aside className="lp-stage-side">
              <div className="lp-side-head"><span>{l('Service feed')}</span><small>{l('Auto-updating')}</small></div>
              <ul className="lp-feed" id="hero-feed">
                {feed.map((f) => (
                  <li key={f.key} className={f.fresh ? 'is-new' : undefined}>
                    <i className={`lp-dot lp-state-${f.state}`} /><span><b>{f.label}</b> {l(f.title)}<small>{l(f.meta)}</small></span><time>{clock(f.hour, f.minute)}</time>
                  </li>
                ))}
              </ul>
              <div className="lp-legend" id="hero-legend">
                {LEGEND.map(([state, label]) => {
                  const n = states.filter((st) => st === state || (state === 'occupied' && st === 'ordering') || (state === 'available' && st === 'reserved')).length;
                  return n ? <span key={state}><i className={`lp-dot lp-state-${state}`} />{l(label)}<b>{num(n)}</b></span> : null;
                })}
              </div>
              <div className="lp-side-table" id="hero-table" aria-live="polite">
                <div className="lp-side-table-head"><strong>{x.label}</strong><span className={`lp-state-line lp-state-${s}`}><i />{l(STATE_WORD[s] ?? 'Open')}</span></div>
                <p>{l(x.zone ?? '')} · {num(x.capacity)} {l('seats')}{x.features?.length ? ` · ${l(x.features[0]!)}` : ''}</p>
                <a className="lp-inline" href={LINKS.reserve}>{l('Reserve this table')} {arrow}</a>
              </div>
            </aside>
          </div>
          <footer className="lp-stage-metrics" id="hero-metrics">
            {METRICS.map(([label, count]) => <Metric key={label} label={l(label)} value={num(count(states))} animate={!reduced} />)}
            <div className="lp-stage-note">{l('Sample service data')}</div>
          </footer>
        </div>
      </div>
    </section>
  );
}

function Metric({ label, value, animate }: { label: string; value: string; animate: boolean }) {
  const ref = useRef<HTMLElement>(null);
  const prev = useRef(value);
  useEffect(() => {
    if (prev.current !== value && animate) ref.current?.animate([{ transform: 'translateY(6px)', opacity: 0.2 }, { transform: 'none', opacity: 1 }], { duration: 360, easing: 'cubic-bezier(.25,1,.5,1)' });
    prev.current = value;
  }, [value, animate]);
  return <div><small>{label}</small><strong ref={ref}>{value}</strong></div>;
}
