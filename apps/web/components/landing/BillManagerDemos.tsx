'use client';
import { INTL_LOCALE } from '@resuto/contracts';
// "Payments" (legacy/public/landing-bill.js) and "Manager view"
// (legacy/public/landing-manager.js) chapters. Sample data only.
import { useEffect, useRef, useState } from 'react';
import { LINKS } from './links';
import { createStage } from './stage';
import type { Landing } from './use-landing';

// ---------------------------------------------------------------- bill
const ITEMS: Array<[string, number]> = [['Seabass with lemon butter', 34500], ['Hibiscus cooler', 6500], ['Burrata & heirloom tomato', 14500], ['Wild mushroom risotto', 24500], ['Grilled chicken supreme', 28500], ['Chocolate fondant', 12500]];
const PEOPLE = ['Ahmed', 'Mariam', 'Omar', 'Lina'];
const TOTAL = ITEMS.reduce((n, i) => n + i[1], 0);
const SHARE = TOTAL / PEOPLE.length;
type PayState = 'idle' | 'paying' | 'paid';

export function BillDemo({ L }: { L: Landing }) {
  const { l, num, money, arrow, reduced } = L;
  const [states, setStates] = useState<PayState[]>(PEOPLE.map(() => 'idle'));
  const [settled, setSettled] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const paid = states.filter((s) => s === 'paid').length;

  useEffect(() => {
    if (reduced) { setStates(PEOPLE.map(() => 'paid')); setSettled(true); return; }
    if (!box.current) return;
    const set = (p: number, st: PayState) => setStates((s) => s.map((x, i) => (i === p ? st : x)));
    const stage = createStage(box.current);
    stage.whenVisible(() => stage.loop(async (c) => {
      await c.wait(800);
      for (let p = 0; p < PEOPLE.length; p++) {
        set(p, 'paying');
        await c.wait(420);
        set(p, 'paid');
        await c.wait(430);
      }
      setSettled(true);
    }, {
      hold: 3400,
      rewind: async (c) => {
        setSettled(false);
        await c.wait(380);
        setStates(PEOPLE.map(() => 'idle'));
        await c.wait(200);
      },
    }));
    return () => stage.destroy();
  }, [reduced]);

  const left = PEOPLE.length - paid;
  return (
    <section className="lp-chapter lp-payments" id="payments">
      <div className="lp-shell">
        <div className="lp-head-row" data-reveal>
          <div><span className="lp-chapter-tag">{l('Payments')}</span><h2>{l('The bill stops being the awkward part.')}</h2></div>
          <p>{l('One bill, a private link for each guest. Here four guests split it equally; they can also split by item or by a custom amount.')}</p>
        </div>
        <div className={`pb${settled ? ' is-settled' : ''}`} id="pay" data-reveal ref={box}>
          <div className="pb-bill">
            <small>{l('Table')} T5 · {l('Bill')}</small>
            <b className="pb-total"><bdi>{money(TOTAL)}</bdi></b>
            <div className="pb-bar" aria-hidden>{PEOPLE.map((_, p) => <i key={p} data-p={p} className={states[p] === 'paid' ? 'is-on' : undefined}><u /></i>)}</div>
            <span className="pb-status" id="pb-status">{left ? `${num(paid)} ${l('of')} ${num(PEOPLE.length)} ${l('paid')}` : `✓ ${l('Paid in full')}`}</span>
          </div>
          <ol className="pb-guests">
            {PEOPLE.map((name, p) => (
              <li key={name} data-p={p} data-state={states[p]}>
                <span className="pb-face"><b>{l(name).slice(0, 1)}</b><i aria-hidden>✓</i></span>
                <span className="pb-name">{l(name)}</span>
                <span className="pb-amt"><bdi>{money(SHARE)}</bdi></span>
              </li>
            ))}
          </ol>
          <div className="pb-out">
            <article className="pb-receipt">
              <span className="pb-stamp">✓ {l('Paid')}</span>
              <strong>{l('Receipt')}</strong>
              <b><bdi>{money(TOTAL)}</bdi></b>
              <span className="pb-stars" aria-hidden>{Array.from({ length: 5 }, (_, i) => <i key={i}>★</i>)}</span>
            </article>
            <p className="pb-wait">{l('Receipt')}</p>
          </div>
        </div>
        <p className="pb-foot"><a className="lp-inline" href={LINKS.demo}>{l('Open the guest experience')} {arrow}</a></p>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- manager
const HOURS: Array<[string, number]> = [['1 PM', 62000], ['2 PM', 118000], ['3 PM', 74000], ['4 PM', 41000], ['5 PM', 56000], ['6 PM', 143000], ['7 PM', 236000], ['8 PM', 291500], ['9 PM', 214000]];
const START = { orders: 37, tables: 6, ratings: [4.7, 4.6, 4.3, 4.5], count: 21, load: [['Grill', 5], ['Hot kitchen', 3], ['Cold kitchen', 2], ['Bar', 2], ['Pastry', 1]] as Array<[string, number]>, stock: [['Burrata & heirloom tomato', 5], ['Chocolate fondant', 4]] as Array<[string, number]> };
const PAYMENTS = [43000, 28500, 61000, 14500, 35500, 52000];
const TRENDS: Record<string, number[]> = { revenue: [12, 22, 28, 31, 36, 49, 70, 96, 100], orders: [3, 7, 10, 12, 15, 20, 27, 34, 37], tables: [2, 5, 4, 2, 3, 6, 9, 8, 6], rating: [4.4, 4.5, 4.5, 4.6, 4.5, 4.6, 4.6, 4.7, 4.6] };
const RATED = ['Food', 'Service', 'Speed', 'Value'];

function Spark({ v }: { v: number[] }) {
  const max = Math.max(...v), min = Math.min(...v);
  const pts = v.map((y, i) => `${((i / (v.length - 1)) * 100).toFixed(1)},${(28 - ((y - min) / (max - min || 1)) * 24).toFixed(1)}`).join(' ');
  return <svg className="mgr-spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden><polygon points={`0,30 ${pts} 100,30`} /><polyline points={pts} /></svg>;
}

export function ManagerDemo({ L }: { L: Landing }) {
  const { l, num, money, arrow, reduced, rtl } = L;
  const fresh = () => ({ s: structuredClone(START), hours: HOURS.map((h) => [...h] as [string, number]), tick: 0, bump: [] as string[], live: false });
  const [m, setM] = useState(fresh);
  const [isLive, setLive] = useState(false);
  const [swap, setSwap] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const fmt = new Intl.NumberFormat(rtl ? INTL_LOCALE.ar : 'en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

  useEffect(() => {
    if (reduced || !box.current) return;
    const stage = createStage(box.current);
    // A table pays: revenue, the order count and the current hour all move together.
    const payment = () => setM((cur) => {
      const hours = cur.hours.map((h) => [...h] as [string, number]);
      hours[hours.length - 1]![1] += PAYMENTS[cur.tick % PAYMENTS.length]!;
      const s = structuredClone(cur.s);
      s.orders++;
      s.load[0]![1] = 4 + (cur.tick % 3);
      return { ...cur, s, hours, tick: cur.tick + 1, bump: ['revenue', 'orders'], live: true };
    });
    stage.whenVisible(() => {
      setLive(true);
      stage.loop(async (c) => { for (let i = 0; i < PAYMENTS.length; i++) { await c.wait(2600); payment(); } }, {
        hold: 2600,
        rewind: async (c) => { setSwap(true); await c.wait(360); setM(fresh()); setSwap(false); },
      });
    });
    return () => stage.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced]);

  const revenue = m.hours.reduce((n, h) => n + h[1], 0);
  const rating = m.s.ratings.reduce((a, b) => a + b, 0) / m.s.ratings.length;
  const tiles: Array<[string, string, string]> = [['revenue', 'Today’s revenue', money(revenue)], ['orders', 'Orders today', num(m.s.orders)], ['tables', 'Active tables', num(m.s.tables)], ['rating', 'Guest satisfaction', `${fmt.format(rating)} ★`]];
  const maxH = Math.max(...m.hours.map((h) => h[1])) * 1.08;
  const maxLoad = Math.max(6, ...m.s.load.map((x) => x[1]));
  const [topName, topN] = [...m.s.load].sort((a, b) => b[1] - a[1])[0]!;
  const cards: Array<[string, string, string]> = [...m.s.stock.map(([item, left]): [string, string, string] => ['Low stock', l(item), `${num(left)} ${l('portions left')}`]), ['Kitchen load', l(topName), `${num(topN)} ${l('portions queued')}`]];
  return (
    <section className="lp-ops" id="operations">
      <div className="lp-shell">
        <div className="lp-head-row is-light" data-reveal>
          <div><span className="lp-chapter-tag is-dark">{l('Manager view')}</span><h2>{l('The numbers move when the room does.')}</h2></div>
          <p>{l('Revenue, orders, ratings and kitchen load in one place, updating as tables order and pay. The AI manager points at what needs attention.')}</p>
        </div>
        <div className={`mgr${isLive ? ' is-live' : ''}${swap ? ' is-swap' : ''}`} id="mgr" data-reveal ref={box}>
          <div className="mgr-tiles" id="mgr-tiles">
            {tiles.map(([id, label, value]) => <article key={`${id}-${m.tick}`} className={m.bump.includes(id) ? 'is-bump' : undefined}><small>{l(label)}</small><strong><bdi>{value}</bdi></strong><Spark v={TRENDS[id]!} /></article>)}
          </div>
          <div className="mgr-grid">
            <article className="mgr-panel mgr-chart">
              <header><h3>{l('Revenue today')}</h3><small>{l('By hour')}</small></header>
              <div className="mgr-bars" id="mgr-bars">
                {m.hours.map(([label, v], i) => <div key={`${label}-${i === m.hours.length - 1 ? m.tick : 0}`} className={[i === m.hours.length - 1 ? 'is-now' : '', m.live && i === m.hours.length - 1 ? 'is-bump' : ''].filter(Boolean).join(' ') || undefined}><i style={{ height: `${((v / maxH) * 100).toFixed(1)}%` }} /><small>{l(label)}</small></div>)}
              </div>
            </article>
            <div className="mgr-stack">
              <article className="mgr-panel"><header><h3>{l('Guest ratings')}</h3><small id="mgr-rated">{num(m.s.count)} {l('ratings')}</small></header>
                <ul className="mgr-meter" id="mgr-ratings">{RATED.map((name, i) => <li key={name}><span>{l(name)}</span><i><u style={{ transform: `scaleX(${m.s.ratings[i]! / 5})` }} /></i><b>{fmt.format(m.s.ratings[i]!)}</b></li>)}</ul>
              </article>
              <article className="mgr-panel"><header><h3>{l('Station load')}</h3><small>{l('Portions queued')}</small></header>
                <ul className="mgr-meter" id="mgr-load">{m.s.load.map(([name, n]) => <li key={name}><span>{l(name)}</span><i><u style={{ transform: `scaleX(${n / maxLoad})` }} /></i><b>{num(n)}</b></li>)}</ul>
              </article>
            </div>
            <article className="mgr-panel mgr-ai">
              <header><h3><span aria-hidden>✦</span> {l('AI manager')}</h3><small>{l('Watching service')}</small></header>
              <ol className="mgr-cards" id="mgr-cards">{cards.map(([kind, title, detail], i) => <li key={`${kind}-${title}`} style={{ ['--i' as string]: i }}><small>{l(kind)}</small><strong>{title}</strong><p>{detail}</p></li>)}</ol>
            </article>
          </div>
          <footer className="mgr-foot"><span>{l('Sample data, drawn as charts for this page. The AI manager raises low-stock and kitchen-load alerts; without a model key it uses built-in rules.')}</span><a className="lp-inline is-dark" href={LINKS.login}>{l('Open the manager screen')} {arrow}</a></footer>
        </div>
      </div>
    </section>
  );
}
