'use client';
import { INTL_LOCALE } from '@resuto/contracts/lite';
// "Kitchen" chapter (port of legacy/public/landing-kitchen.js): one order list drives
// the board, every counter, station load and the guest's status preview.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { LINKS } from './links';
import { createTour, EASE } from './stage';
import type { Landing } from './use-landing';

const FLOW = ['received', 'preparing', 'ready', 'served'] as const;
type Status = (typeof FLOW)[number];
const COLUMNS: Array<[Status, string]> = [['received', 'New orders'], ['preparing', 'Preparing'], ['ready', 'Ready to serve'], ['served', 'Completed']];
const NEXT: Partial<Record<Status, string>> = { received: 'Start preparing', preparing: 'Mark ready', ready: 'Mark served' };
const GUEST = ['Order received', 'Preparing', 'Ready', 'Served'];
const STATIONS = ['Grill', 'Hot kitchen', 'Cold kitchen', 'Pastry', 'Bar'];
const TEMPLATES: Array<{ table: string; lines: Array<[number, string, string]> }> = [
  { table: 'T5', lines: [[1, 'Burrata & heirloom tomato', 'Cold kitchen'], [1, 'Grilled chicken supreme', 'Grill']] },
  { table: 'T2', lines: [[2, 'Roasted pumpkin soup', 'Hot kitchen'], [2, 'Hibiscus cooler', 'Bar']] },
  { table: 'T8', lines: [[1, 'Seabass with lemon butter', 'Grill'], [1, 'Wild mushroom risotto', 'Hot kitchen']] },
  { table: 'T11', lines: [[2, 'Chocolate fondant', 'Pastry'], [1, 'Hibiscus cooler', 'Bar']] },
];
const KEEP_DONE = 2;
interface Order { n: number; table: string; lines: Array<[number, string, string]>; status: Status; minute: number }

export function KitchenDemo({ L }: { L: Landing }) {
  const { l, num, arrow, reduced, rtl } = L;
  const seq = useRef(39);
  const minute = useRef(36);
  const make = (status: Status): Order => {
    const tpl = TEMPLATES[seq.current % TEMPLATES.length]!;
    return { n: ++seq.current, table: tpl.table, lines: tpl.lines, status, minute: (minute.current += 2) };
  };
  const [state, setState] = useState(() => {
    const a = make('preparing'), b = make('ready');
    return { orders: [a, b], follow: a.n as number | null };
  });
  const [station, setStation] = useState('');
  const [routing, setRouting] = useState<number | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef(state); stateRef.current = state;
  const clock = (m: number) => new Date(2024, 0, 1, 19, m).toLocaleTimeString(rtl ? INTL_LOCALE.ar : 'en-US', { hour: 'numeric', minute: '2-digit' });
  const label = (n: number) => `#${num(n).padStart(3, num(0))}`;

  const advance = (n: number) => setState((s) => {
    let orders = s.orders.map((o) => (o.n === n && o.status !== 'served' ? { ...o, status: FLOW[FLOW.indexOf(o.status) + 1]! } : o));
    const done = orders.filter((x) => x.status === 'served');
    if (done.length > KEEP_DONE) orders = orders.filter((x) => x !== done[0]);
    return { orders, follow: n };
  });
  const addOrder = () => setState((s) => { const o = make('received'); return { orders: [...s.orders, o], follow: o.n }; });

  // FLIP: remember where every card was, then glide each one to its new place.
  const rects = useRef(new Map<number, DOMRect>());
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const now = new Map<number, DOMRect>();
    box.querySelectorAll<HTMLElement>('.kds-card').forEach((el) => {
      const n = Number(el.dataset.n), b = el.getBoundingClientRect(), a = rects.current.get(n);
      now.set(n, b);
      if (reduced) return;
      if (!a) { el.animate([{ opacity: 0, transform: 'translateY(-14px) scale(.96)' }, { opacity: 1, transform: 'none' }], { duration: 420, easing: EASE.move }); return; }
      const dx = a.left - b.left, dy = a.top - b.top;
      if (dx || dy) el.animate([{ transform: `translate(${dx}px,${dy}px)`, zIndex: 3 }, { transform: 'none', zIndex: 3 }], { duration: 560, easing: EASE.move });
    });
    rects.current = now;
  }, [state, reduced]);

  useEffect(() => {
    if (!boxRef.current) return;
    let cycle = 0;
    const btn = (n: number) => `.kds-card[data-n="${n}"] [data-kds="advance"]`;
    const tour = createTour(boxRef.current, {
      t: l, reduced, hold: 500,
      manualHint: 'Advance a ticket, add a sample order, or highlight a station.',
      script: async ({ c, tap, say }) => {
        const [cooking, passed] = stateRef.current.orders.filter((o) => o.status !== 'served').sort((a, b) => FLOW.indexOf(a.status) - FLOW.indexOf(b.status)).slice(-2);
        say('A guest confirms: the order is on the board');
        await tap(c, '[data-kds="new"]', { wait: 500 });
        const fresh = stateRef.current.orders[stateRef.current.orders.length - 1]!;
        setRouting(fresh.n);
        say('Each line shows the station that cooks it');
        await c.wait(1300);
        setRouting(null);
        if (cycle++ % 2) {
          say('Highlight one station across the board');
          await tap(c, '[data-kds="station"][data-arg="Grill"]', { wait: 1100 });
          await tap(c, '[data-kds="station"][data-arg=""]', { ms: 420, wait: 200 });
        }
        if (passed) { say('Mark served: it leaves the active count'); await tap(c, btn(passed.n), { wait: 700 }); }
        if (cooking && cooking !== passed) { say('Mark ready: the guest sees it at once'); await tap(c, btn(cooking.n), { wait: 900 }); }
        say('Start preparing the new order');
        await tap(c, btn(fresh.n), { wait: 700 });
      },
    });
    return () => tour.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced, l]);

  const { orders, follow } = state;
  const queued = orders.filter((o) => o.status === 'received' || o.status === 'preparing');
  const guest = orders.find((x) => x.n === follow) ?? orders[orders.length - 1];
  const at = guest ? FLOW.indexOf(guest.status) : 0;
  return (
    <section className="lp-kitchen" id="kitchen">
      <div className="lp-shell">
        <div className="lp-head-row is-light" data-reveal>
          <div><span className="lp-chapter-tag is-dark">{l('Kitchen')}</span><h2>{l('One board. Every line knows its station.')}</h2></div>
          <p>{l('An order reaches the kitchen the moment the guest confirms it. Each line carries the station that cooks it, and the status the kitchen sets is the status the guest sees.')}</p>
        </div>
        <div className="kds" id="kds" data-station={station} ref={boxRef}>
          <div className="kds-main">
            <header className="kds-bar">
              <strong>{l('Kitchen display')}</strong>
              <span className="kds-active">{l('Active orders')} <b id="kds-active">{num(orders.filter((o) => o.status !== 'served').length)}</b></span>
              <button type="button" className="kds-new" data-kds="new" onClick={addOrder}>+ {l('Sample order')}</button>
            </header>
            <div className="kds-board">
              {COLUMNS.map(([id, colLabel]) => {
                const inCol = orders.filter((o) => o.status === id);
                return (
                  <section key={id} className="kds-col" data-col={id}>
                    <header><i />{l(colLabel)}<b data-count={id}>{num(inCol.length)}</b></header>
                    <div className="kds-list" data-list={id}>
                      {(id === 'served' ? [...inCol].reverse() : inCol).map((o) => (
                        <article key={o.n} className={`kds-card${o.n === follow ? ' is-followed' : ''}${o.n === routing ? ' is-routing' : ''}`} data-n={o.n} data-status={o.status}>
                          <header><b>{label(o.n)}</b><time>{clock(o.minute)}</time></header>
                          <span className="kds-from">{l('Table')} {o.table} · {l('Table QR')}</span>
                          <ul>{o.lines.map(([q, name, st]) => <li key={name} data-station={st} className={station && st !== station ? 'is-dim' : undefined}><span>{num(q)} × {l(name)}</span><small>{l(st)}</small></li>)}</ul>
                          {NEXT[o.status]
                            ? <button type="button" data-kds="advance" data-arg={o.n} onClick={() => advance(o.n)}>{l(NEXT[o.status]!)}</button>
                            : <span className="kds-done">✓ {l('Served')}</span>}
                        </article>
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>
            <footer className="kds-stations">
              <span className="kds-stations-label">{l('Station load')}</span>
              <div className="kds-chips" role="group" aria-label={l('Highlight a station')}>
                <button type="button" data-kds="station" data-arg="" aria-pressed={station === ''} onClick={() => setStation('')}>{l('All')}</button>
                {STATIONS.map((s) => {
                  const portions = queued.reduce((sum, o) => sum + o.lines.filter((x) => x[2] === s).reduce((n, x) => n + x[0], 0), 0);
                  return (
                    <button key={s} type="button" data-kds="station" data-arg={s} aria-pressed={station === s} onClick={() => setStation(s)}>
                      <span>{l(s)}</span><i><u data-load={s} style={{ transform: `scaleX(${Math.min(1, portions / 5)})` }} /></i><b data-portions={s}>{num(portions)}</b>
                    </button>
                  );
                })}
              </div>
            </footer>
          </div>
          <aside className="kds-guest">
            <span className="kds-guest-tag">{l('What the guest sees')}</span>
            <div className="kds-phone"><div className="kds-phone-in" id="kds-guest">
              {guest && (
                <>
                  <div className="kds-g-head"><small>{l('Order status')}</small><strong>{label(guest.n)}</strong><span>{l('Table')} {guest.table}</span></div>
                  <ol className="kds-g-steps">{GUEST.map((s, i) => <li key={s} className={i < at ? 'is-done' : i === at ? 'is-now' : undefined}><i>{i < at ? '✓' : num(i + 1)}</i>{l(s)}</li>)}</ol>
                  <ul className="kds-g-lines">{guest.lines.map(([q, name]) => <li key={name}>{num(q)} × {l(name)}</li>)}</ul>
                </>
              )}
            </div></div>
            <a className="lp-inline is-dark" href={LINKS.login}>{l('Open the kitchen screen')} {arrow}</a>
          </aside>
          <div className="kds-guide" data-guide />
        </div>
      </div>
    </section>
  );
}
