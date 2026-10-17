'use client';
// "Guest service" chapter (port of the phone demo in legacy/public/landing.js):
// scan → add from the live menu → confirm → follow the status the kitchen sets.
import QRCode from 'qrcode';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { LINKS } from './links';
import { SAMPLE, type SampleDish } from './sample-data';
import { createTour } from './stage';
import { onVisible, type Landing } from './use-landing';

const STEPS: Array<[string, string, string]> = [
  ['scan', 'Scan the table', 'No app and no account. The menu opens in the browser.'],
  ['browse', 'Add from the live menu', 'Sold-out dishes are marked the moment the kitchen says so.'],
  ['cart', 'Confirm the order', 'Prices and stock are checked again when it is sent.'],
  ['track', 'Follow the order', 'The guest sees the status the kitchen sets.'],
];
const TRACK = ['Order received', 'Preparing', 'Ready', 'Served'];

export function Dish({ m, l, rtl, cls = '' }: { m: SampleDish; l: (s: string) => string; rtl: boolean; cls?: string }) {
  const style = { '--px': `${m.imageIndex % 2 ? 90 : 10}%`, '--py': `${(Math.floor((m.imageIndex || 0) / 2) * 100) / 3}%` } as CSSProperties;
  return <span className={`lp-photo ${cls}`} role="img" aria-label={rtl && m.nameAr ? m.nameAr : l(m.name)} style={style} />;
}

export function ServiceDemo({ L }: { L: Landing }) {
  const { l, num, money, arrow, rtl, reduced } = L;
  const pickable = SAMPLE.menu.slice(0, 3);
  const table = SAMPLE.floor.tables[0]!;
  const nameOf = (m: SampleDish) => (rtl && m.nameAr ? m.nameAr : m.name);
  const [step, setStep] = useState(0);
  const [cart, setCart] = useState<string[]>([]);
  const [status, setStatus] = useState(0);
  const [qr, setQr] = useState<string | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLOListElement>(null);
  const trackTimer = useRef<ReturnType<typeof setInterval>>(undefined);
  const lines = pickable.filter((m) => cart.includes(m.id));
  const total = lines.reduce((n, m) => n + m.price, 0);

  useEffect(() => {
    QRCode.toString(new URL(LINKS.demo, window.location.origin).toString(), { type: 'svg', margin: 1, color: { dark: '#0C2620', light: '#ffffff' } })
      .then((svg) => setQr(svg)).catch(() => setQr(null));
  }, []);

  const go = (i: number) => {
    const n = (i + STEPS.length) % STEPS.length;
    setStep(n);
    // On a phone the steps are a sideways strip: keep the current one in view without moving the page.
    const strip = stripRef.current, cur = strip?.children[n] as HTMLElement | undefined;
    if (strip && cur && strip.scrollWidth > strip.clientWidth) strip.scrollTo({ left: cur.offsetLeft - strip.offsetLeft - 16, behavior: reduced ? 'auto' : 'smooth' });
    clearInterval(trackTimer.current);
    if (n === 3 && !reduced) {
      setStatus(0);
      let s = 0;
      trackTimer.current = setInterval(() => { if (document.hidden) return; s += 1; setStatus(s); if (s >= 3) clearInterval(trackTimer.current); }, 1500);
    } else if (n === 3) setStatus(1);
  };
  // Each screen slides in.
  useEffect(() => {
    const el = screenRef.current?.firstElementChild;
    if (el && !reduced) el.animate([{ opacity: 0, transform: `translateX(${rtl ? -22 : 22}px)` }, { opacity: 1, transform: 'none' }], { duration: 420, easing: 'cubic-bezier(.32,.72,0,1)' });
  }, [step, reduced, rtl]);
  const dockRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!reduced && cart.length) dockRef.current?.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.035)' }, { transform: 'scale(1)' }], { duration: 320, easing: 'cubic-bezier(.25,1,.5,1)' });
  }, [cart, reduced]);

  useEffect(() => {
    if (!stageRef.current) return;
    const root = stageRef.current.closest('.lp');
    const stopVis = onVisible(stageRef.current, (v) => { if (v) root?.classList.add('lp-media-on'); });
    const tour = createTour(stageRef.current, {
      t: l, reduced, pointer: 'touch', hold: 1800,
      manualHint: 'Click a step, add a dish, then confirm the order.',
      script: async ({ c, tap, say, cursor }) => {
        await cursor.hide(c, 1);
        say('Scan the QR on the table');
        go(0);
        await c.wait(2200);
        say('The menu opens: add what you want');
        go(1);
        await c.wait(1100);
        cursor.set(screenRef.current!, 0.5, 0.82); await cursor.show(c, 260);
        await tap(c, `[data-lp="add"][data-arg="${CSS.escape(pickable[0]!.id)}"]`, { ms: 640, wait: 750 });
        if (pickable[2]) await tap(c, `[data-lp="add"][data-arg="${CSS.escape(pickable[2].id)}"]`, { ms: 560, wait: 950 });
        say('Review the order');
        await tap(c, '[data-lp="cart"]', { ms: 620, wait: 1700 });
        say('Confirm: it goes straight to the kitchen');
        await tap(c, '[data-lp="confirm"]', { ms: 600, wait: 500 });
        await cursor.hide(c, 200);
        say('Then follow the status the kitchen sets');
        await c.wait(5200);
      },
      rewind: async () => { setCart([]); setStatus(0); },
      onTakeover: () => clearInterval(trackTimer.current),
    });
    return () => { tour.destroy(); stopVis(); clearInterval(trackTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced, l]);

  const toggle = (id: string) => setCart((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  const id = STEPS[step]![0];
  let screen: React.ReactNode;
  if (id === 'scan') {
    screen = (
      <div className="lp-scr lp-scr-scan">
        <span className="lp-scr-eyebrow">{SAMPLE.restaurant}</span><strong>{table.label}</strong>
        <div className="lp-qr">
          {qr ? <span className="lp-qr-svg" role="img" aria-label={l('Table QR code')} dangerouslySetInnerHTML={{ __html: qr }} /> : <span className="lp-qr-svg" />}
          <span className="lp-qr-scan" aria-hidden />
        </div>
        <p>{l('Scan to open the menu')}</p><small>{l('Opens in the browser. Nothing to install.')}</small>
      </div>
    );
  } else if (id === 'browse') {
    screen = (
      <div className="lp-scr lp-scr-menu">
        <div className="lp-scr-bar"><strong>{l('Menu')}</strong><span>{table.label}</span></div>
        <div className="lp-scr-tabs">{['Starters', 'Mains', 'Desserts'].map((c, i) => <span key={c} className={i ? undefined : 'is-on'}>{l(c)}</span>)}</div>
        <div className="lp-scr-list">
          {pickable.map((m) => (
            <article key={m.id} className={`lp-scr-dish${cart.includes(m.id) ? ' is-added' : ''}`}>
              <Dish m={m} l={l} rtl={rtl} />
              <div><b>{nameOf(m)}</b><small><bdi>{money(m.price)}</bdi></small></div>
              <button type="button" data-lp="add" data-arg={m.id} aria-pressed={cart.includes(m.id)} aria-label={`${l('Add')} ${nameOf(m)}`} onClick={() => toggle(m.id)}><span aria-hidden>{cart.includes(m.id) ? '✓' : '+'}</span></button>
            </article>
          ))}
        </div>
        <button type="button" className="lp-scr-dock" data-lp="cart" ref={dockRef} disabled={!cart.length} onClick={() => { if (cart.length) go(2); }}>
          <span>{num(cart.length)} {l('in your order')}</span><b>{money(total)}</b>
        </button>
      </div>
    );
  } else if (id === 'cart') {
    screen = (
      <div className="lp-scr lp-scr-cart">
        <div className="lp-scr-bar"><strong>{l('Your order')}</strong><span>{table.label}</span></div>
        <div className="lp-scr-list">
          {lines.length ? lines.map((m) => (
            <article key={m.id} className="lp-scr-dish"><Dish m={m} l={l} rtl={rtl} /><div><b>{nameOf(m)}</b><small>{num(1)} × <bdi>{money(m.price)}</bdi></small></div></article>
          )) : <p className="lp-scr-empty">{l('Nothing added yet.')}</p>}
          <div className="lp-scr-total"><span>{l('Total')}</span><b><bdi>{money(total)}</bdi></b></div>
        </div>
        <button type="button" className="lp-scr-cta" data-lp="confirm" disabled={!cart.length} onClick={() => { if (cart.length) go(3); }}>{l('Confirm order')}</button>
      </div>
    );
  } else {
    screen = (
      <div className="lp-scr lp-scr-track">
        <div className="lp-scr-bar"><strong>{l('Order status')}</strong><span><bdi dir="ltr">#{num(42)}</bdi> · {table.label}</span></div>
        <ol className="lp-track">{TRACK.map((s, i) => <li key={s} className={i < status ? 'done' : i === status ? 'now' : undefined}><i />{l(s)}</li>)}</ol>
        <ul className="lp-track-lines">{lines.map((m) => <li key={m.id}>{num(1)} × {nameOf(m)}</li>)}</ul>
      </div>
    );
  }

  return (
    <section className="lp-service" id="service">
      <div className="lp-shell">
        <div className="lp-head-row" data-reveal>
          <div><span className="lp-chapter-tag">{l('Guest service')}</span><h2>{l('The table becomes the waiter’s second pair of hands.')}</h2></div>
          <p>{l('A guest scans the table, orders in Arabic or English and follows the kitchen, while the floor team keeps working the room.')}</p>
        </div>
        <div className="lp-service-stage" data-reveal ref={stageRef}>
          <ol className="lp-service-steps" id="service-steps" ref={stripRef}>
            {STEPS.map(([sid, title, detail], i) => (
              <li key={sid} className={i === step ? 'is-on' : undefined}>
                <button type="button" data-lp="service" data-arg={i} aria-current={i === step ? 'step' : undefined} onClick={() => go(i)}><span>{num(i + 1)}</span><strong>{l(title)}</strong><small>{l(detail)}</small></button>
              </li>
            ))}
          </ol>
          <div className="lp-phone-wrap">
            <div className="lp-phone"><span className="lp-phone-notch" aria-hidden /><div className="lp-phone-screen" id="phone-screen" ref={screenRef}>{screen}</div></div>
            <div className="lp-phone-glow" aria-hidden />
          </div>
          <div className="lp-service-notes">
            <div data-guide />
            <article><strong>{l('A menu assistant that stays honest')}</strong><p>{l('Guests can ask for a suggestion. It only proposes dishes from the live menu, lists stated allergens, and the guest still confirms the order.')}</p></article>
            <article><strong>{l('Every table has an identity')}</strong><p>{l('The QR belongs to the table, not to a printed page, so moving furniture never breaks a code.')}</p></article>
            <a className="lp-inline" href={LINKS.demo}>{l('Open the guest experience')} {arrow}</a>
          </div>
        </div>
      </div>
    </section>
  );
}
