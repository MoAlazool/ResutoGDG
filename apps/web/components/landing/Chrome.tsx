'use client';
// Landing chrome and static chapters (port of legacy/public/landing.js nav,
// system band, Connect, pricing teaser, closing CTA and footer).
import { useEffect, useRef, useState } from 'react';
import { setLocale } from '@/lib/i18n/client';
import { FloorSceneContent, type SceneTable } from '../floor/FloorScene';
import marks from './brand-marks';
import logos from './company-logos';
import { LINKS } from './links';
import { BUSINESS_CARD, cardAmount, type LandingPlan } from './plans';
import type { LandingFloor } from './floor-data';
import type { Landing } from './use-landing';

export type { LandingPlan } from './plans';

const NAV_LINKS: Array<[string, string]> = [['#studio', 'Floor Studio'], ['#service', 'Guest service'], ['#operations', 'Operations'], ['#connect', 'Connect'], ['#pricing', 'Pricing']];

export function Wordmark({ rtl }: { rtl: boolean }) {
  return rtl
    ? <img className="lp-logo-ar" src="/brand/resuto-arabic-logo.webp" alt="ريسوتو" width={308} height={96} />
    : <><span className="lp-logo-mark" aria-hidden>r</span><span className="lp-logo-type">resuto<i>.</i></span></>;
}

export function Switcher({ L }: { L: Landing }) {
  return (
    <button type="button" className="language-switch" lang={L.rtl ? 'en' : 'ar'} aria-label={L.rtl ? 'Switch to English' : 'التبديل إلى العربية'} onClick={() => setLocale(L.rtl ? 'en' : 'ar')}>
      {L.rtl ? 'EN' : 'العربية'}
    </button>
  );
}

export function Nav({ L }: { L: Landing }) {
  const { l, rtl } = L;
  const [open, setOpen] = useState(false);
  const [stuck, setStuck] = useState(false);
  const [here, setHere] = useState('');
  const bar = useRef<HTMLElement>(null);
  useEffect(() => {
    let ticking = false;
    const onScroll = () => {
      const doc = document.documentElement;
      const p = doc.scrollTop / Math.max(1, doc.scrollHeight - innerHeight);
      if (bar.current) bar.current.style.transform = `scaleX(${p})`;
      setStuck(doc.scrollTop > 24);
      let active = '';
      for (const [href] of NAV_LINKS) { const el = document.querySelector(href); if (el && el.getBoundingClientRect().top < innerHeight * 0.45) active = href; }
      setHere(active);
      ticking = false;
    };
    const listener = () => { if (!ticking) { ticking = true; requestAnimationFrame(onScroll); } };
    addEventListener('scroll', listener, { passive: true });
    onScroll();
    return () => removeEventListener('scroll', listener);
  }, []);
  useEffect(() => {
    document.body.classList.toggle('lp-locked', open);
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    addEventListener('keydown', esc);
    return () => { removeEventListener('keydown', esc); document.body.classList.remove('lp-locked'); };
  }, [open]);
  return (
    <>
      <header className={`lp-nav${stuck ? ' is-stuck' : ''}`} id="lp-nav">
        <div className="lp-nav-inner">
          <a className="lp-logo" href="/" aria-label="Resuto"><Wordmark rtl={rtl} /></a>
          <nav className="lp-nav-links" aria-label={l('Sections')}>
            {NAV_LINKS.map(([href, label]) => <a key={href} href={href} className={here === href ? 'is-here' : undefined}><span>{l(label)}</span></a>)}
          </nav>
          <div className="lp-nav-end">
            <Switcher L={L} />
            <a className="lp-btn lp-btn-solid" href={LINKS.demo}><span className="lp-cta-long">{l('Open the live demo')}</span><span className="lp-cta-short">{l('Live demo')}</span></a>
            <button type="button" className="lp-burger" aria-expanded={open} aria-controls="lp-drawer" aria-label={l('Menu')} onClick={() => setOpen(!open)}><i /><i /></button>
          </div>
        </div>
        <span className="lp-nav-line" aria-hidden><i id="lp-progress" ref={bar} /></span>
      </header>
      <div className="lp-drawer" id="lp-drawer" hidden={!open}>
        <nav>
          {NAV_LINKS.map(([href, label]) => <a key={href} href={href} onClick={() => setOpen(false)}>{l(label)}</a>)}
          <a href={LINKS.pricing} onClick={() => setOpen(false)}>{l('Compare plans')}</a>
          <a href={LINKS.login} onClick={() => setOpen(false)}>{l('Staff login')}</a>
        </nav>
        <a className="lp-btn lp-btn-solid" href={LINKS.demo} onClick={() => setOpen(false)}>{l('Open the live demo')}</a>
      </div>
    </>
  );
}

const SYSTEM: Array<[string, string, string]> = [
  ['#studio', 'Floor Studio', 'One saved room'], ['#reserve', 'Reservations', 'Guests pick a real table'], ['#import', 'Menu import', 'PDF, photo or CSV'],
  ['#service', 'Guest ordering', 'QR menu, no app'], ['#kitchen', 'Kitchen', 'One board, station labels'], ['#payments', 'Payments', 'Split, pay, rate'],
  ['#operations', 'Manager view', 'Revenue, stock, load'],
];
export function SystemBand({ L }: { L: Landing }) {
  const { l } = L;
  return (
    <section className="lp-system" aria-label={l('How Resuto fits together')}>
      <div className="lp-shell">
        <div className="lp-system-head" data-reveal><h2>{l('Not seven tools. One order, followed all the way through.')}</h2><p>{l('Every part works from the same floor, the same menu and the same bill, so nothing is typed in twice.')}</p></div>
        <div className="lp-system-rail" data-reveal>
          <svg className="lp-system-line" viewBox="0 0 1200 40" preserveAspectRatio="none" aria-hidden><path className="lp-line-base" d="M0 20H1200" /><path className="lp-flow" d="M0 20H1200" /></svg>
          <ol>{SYSTEM.map(([href, title, detail], i) => <li key={href} style={{ ['--i' as string]: i }}><a href={href}><i aria-hidden /><strong>{l(title)}</strong><small>{l(detail)}</small></a></li>)}</ol>
        </div>
      </div>
    </section>
  );
}

// Logos only. Names are kept for screen readers.
const INTEGRATIONS: Array<[string, string | null, string?, string?]> = [['Stripe', marks.stripe ?? null], ['Paymob', logos.paymob ?? null, '', 'is-word'], ['Tap Payments', null, 'tap'], ['Foodics', logos.foodics ?? null, '', 'is-word'], ['Odoo', marks.odoo ?? null], ['WhatsApp', marks.whatsapp ?? null], ['Meta', marks.meta ?? null], ['Google Gemini', marks.googlegemini ?? null]];
export function Connect({ L }: { L: Landing }) {
  const { l } = L;
  return (
    <section className="lp-chapter lp-connect" id="connect">
      <div className="lp-shell itx">
        <div className="itx-head" data-reveal><h2>{l('Runs on its own.')} {l('Connects where it is ready.')}</h2><p>{l('Resuto works without any of these. Connect the ones you already use.')}</p></div>
        <ul className="itx-row" data-reveal>
          {INTEGRATIONS.map(([name, logo, mark, kind = ''], i) => (
            <li key={name} className={kind || undefined} style={{ ['--i' as string]: i }} title={name}>
              {logo ? <img src={logo} alt={name} loading="lazy" /> : <b role="img" aria-label={name}>{mark}</b>}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

const CARD_BULLETS: Record<string, string[]> = {
  starter: ['QR menu and ordering', 'Floor plan and reservations', 'Pickup, ratings and basic analytics'],
  growth: ['Everything in Starter', 'AI waiter and kitchen display', 'Split payments and integrations'],
  pro: ['Everything in Growth', 'Up to three branches', 'AI operational insights'],
  business: ['Negotiated branch limits', 'Dedicated onboarding and migration', 'SLA, API and white label'],
};
const FALLBACK_PLANS: LandingPlan[] = ['starter', 'growth', 'pro'].map((id) => ({
  id, name: id[0]!.toUpperCase() + id.slice(1), nameAr: null, monthlyMinor: null, yearlyMinor: null, currency: 'EGP',
}));

/**
 * Pricing teaser (legacy landing-pricing.js): Starter, Growth and Pro with their published monthly/yearly prices, then
 * Business ("Let’s talk", quoted by the sales team). Plan names stay in Latin script in both languages, as on the
 * legacy page; they are product names. Without prices (API unavailable) the cards link to /pricing instead.
 */
export function Pricing({ L, plans, ownT }: { L: Landing; plans: LandingPlan[] | null; ownT: (k: string, vars?: Record<string, string | number>) => string }) {
  const { l, num, reduced } = L;
  const [yearly, setYearly] = useState(false);
  const priced = !!plans?.length;
  const list = [...(priced ? plans! : FALLBACK_PLANS).slice(0, 3), BUSINESS_CARD];
  const hasYearly = priced && plans!.some((p) => p.yearlyMinor !== null);
  // "2 months free" only while the published yearly prices really are ten monthly payments.
  const twoFree = priced && plans!.every((p) => p.monthlyMinor === null || p.yearlyMinor === null || p.yearlyMinor === p.monthlyMinor * 10);
  return (
    <section className="lp-chapter lp-pricing" id="pricing">
      <div className="lp-shell">
        <div className="lp-pricing-head" data-reveal>
          <div><span className="lp-chapter-tag">{l('Pricing')}</span><h2>{l('Egyptian pricing, from one room to three branches.')}</h2></div>
          {hasYearly && (
            <div className="lp-seg lp-seg-pill" role="group" aria-label={l('Billing period')}>
              <button type="button" className={yearly ? undefined : 'is-on'} aria-pressed={!yearly} onClick={() => setYearly(false)}>{l('Monthly')}</button>
              <button type="button" className={yearly ? 'is-on' : undefined} aria-pressed={yearly} onClick={() => setYearly(true)}>{twoFree ? l('Yearly · 2 months free') : l('Yearly')}</button>
            </div>
          )}
        </div>
        <div className="lp-plans" id="plan-grid">
          {list.map((p, i) => {
            const a = priced ? cardAmount(p, yearly) : null;
            const sales = p.id === BUSINESS_CARD.id;
            return (
              <article key={p.id} className={`lp-plan${i === 1 ? ' is-featured' : ''}`} style={{ ['--i' as string]: i }} data-plan={p.id}>
                <h3><bdi>{p.name}</bdi></h3>
                <div className="lp-plan-price">
                  {a !== null ? <><CountUp value={a} num={num} animate={!reduced} /><small>{l('EGP')} / {yearly ? l('year') : l('month')}</small></>
                    : <b className="lp-plan-talk">{sales || priced ? l('Let’s talk') : ownT('platform.seePricing')}</b>}
                </div>
                <ul>{(CARD_BULLETS[p.id] ?? (p.description ? [p.description] : [])).map((f) => (
                  <li key={f}>{f === 'Up to three branches' && p.branches ? ownT('platform.pricing.upToBranches', { n: p.branches }) : l(f)}</li>
                ))}</ul>
                <a className={`lp-btn ${i === 1 ? 'lp-btn-solid' : 'lp-btn-line-ink'} lp-btn-full`} href={sales ? `${LINKS.pricing}#sales` : a !== null ? `${LINKS.pricing}?plan=${p.id}#compare` : LINKS.pricing}>{sales ? l('Talk to us') : l('See what is included')}</a>
              </article>
            );
          })}
        </div>
        <p className="lp-pricing-note" data-reveal>{priced ? l('Launch pricing. You can create a workspace and start a 14-day trial without a card. Subscription billing is not enabled yet, so nothing is charged.') : ownT('platform.pricingUnavailable')} <a className="lp-inline" href={`${LINKS.pricing}#compare`}>{l('Compare every feature')}</a></p>
      </div>
    </section>
  );
}

function CountUp({ value, num, animate }: { value: number; num: (n: number) => string; animate: boolean }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    if (!animate || from.current === value) { setShown(value); from.current = value; return; }
    const a = from.current, start = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / 520), k = 1 - Math.pow(1 - p, 3);
      setShown(Math.round(a + (value - a) * k));
      if (p < 1) raf = requestAnimationFrame(step); else from.current = value;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, animate]);
  return <b data-amount={value}>{num(shown)}</b>;
}

const HERO_CYCLE = ['available', 'occupied', 'preparing', 'available', 'ready', 'reserved', 'available', 'occupied', 'payment', 'available', 'cleaning', 'available'];
export function Cta({ L, ownT, floor }: { L: Landing; ownT: (k: string) => string; floor: LandingFloor }) {
  const { l, arrow, num } = L;
  const tables = floor.tables.map((x, i) => ({ ...x, minSpendMinor: null, internalNotes: null, state: HERO_CYCLE[i % HERO_CYCLE.length] })) as SceneTable[];
  return (
    <section className="lp-cta">
      <div className="lp-cta-floor" aria-hidden>
        <svg viewBox={`0 0 ${floor.width} ${floor.height}`}>
          <FloorSceneContent layout={{ width: floor.width, height: floor.height, zones: floor.zones.map((z) => ({ ...z, label: l(z.label) })), objects: floor.objects.map((o) => ({ ...o, label: l(o.label) })), background: null, tables }}
            mode="operations" seatsLabel={(n) => `${num(n)} ${l('seats')}`} />
        </svg>
      </div>
      <div className="lp-shell lp-cta-inner" data-reveal>
        <h2>{l('Your dining room is already running. Resuto just keeps up with it.')}</h2>
        <p>{l('Open the demo restaurant, reserve a table, scan a QR, order, split the bill and watch the manager screen react. Nothing is charged and nothing is installed.')}</p>
        <div className="lp-hero-cta">
          <a className="lp-btn lp-btn-solid lp-btn-lg" href={LINKS.demo}>{l('Open the live demo')} {arrow}</a>
          <a className="lp-btn lp-btn-line" href={LINKS.signup}>{ownT('platform.signup')}</a>
          <a className="lp-btn lp-btn-line" href={LINKS.pricing}>{l('Compare plans')}</a>
        </div>
        <ul className="lp-cta-list">{['No account for guests', 'One saved floor everywhere', 'Arabic and English throughout'].map((x) => <li key={x}>{l(x)}</li>)}</ul>
      </div>
    </section>
  );
}

export function Footer({ L, ownT }: { L: Landing; ownT: (k: string) => string }) {
  const { l, rtl } = L;
  return (
    <footer className="lp-foot">
      <div className="lp-shell lp-foot-grid">
        <div><a className="lp-logo" href="/"><Wordmark rtl={rtl} /></a><p>{l('The operating system for restaurants — reservations, ordering, kitchen and payments around one live floor.')}</p></div>
        <div className="lp-foot-navs">
          <nav aria-label={l('Product')}><h4>{l('Product')}</h4><a href="#studio">{l('Floor Studio')}</a><a href="#service">{l('Guest service')}</a><a href="#kitchen">{l('Kitchen')}</a><a href="#payments">{l('Payments')}</a></nav>
          <nav aria-label={l('Ecosystem')}><h4>{l('Ecosystem')}</h4><a href="#connect">{l('Resuto Native')}</a><a href="#connect">{l('Resuto Connect')}</a><a href="#operations">{l('AI manager')}</a><a href={LINKS.pricing}>{l('Pricing')}</a></nav>
          <nav aria-label={l('Try it')}><h4>{l('Try it')}</h4><a href={LINKS.demo}>{l('Restaurant demo')}</a><a href={LINKS.reserve}>{l('Reserve a table')}</a><a href={LINKS.menu}>{l('Menu')}</a><a href={LINKS.signup}>{ownT('platform.signup')}</a><a href={LINKS.login}>{l('Staff login')}</a></nav>
        </div>
        <small>© {new Date().getFullYear()} Resuto</small>
      </div>
    </footer>
  );
}
