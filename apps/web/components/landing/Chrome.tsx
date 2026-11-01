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
            <a className="lp-btn lp-btn-solid" href={LINKS.demo}><span className="lp-cta-long">{rtl ? 'اطلب الوصول' : 'Request access'}</span><span className="lp-cta-short">{rtl ? 'تواصل' : 'Contact'}</span></a>
            <button type="button" className="lp-burger" aria-expanded={open} aria-controls="lp-drawer" aria-label={l('Menu')} onClick={() => setOpen(!open)}><i /><i /></button>
          </div>
        </div>
        <span className="lp-nav-line" aria-hidden><i id="lp-progress" ref={bar} /></span>
      </header>
      <div className="lp-drawer" id="lp-drawer" hidden={!open}>
        <nav>
          {NAV_LINKS.map(([href, label]) => <a key={href} href={href} onClick={() => setOpen(false)}>{l(label)}</a>)}
          <a href={LINKS.pricing} onClick={() => setOpen(false)}>{l('Compare plans')}</a>
          <a href="/contact/" onClick={() => setOpen(false)}>{rtl ? 'تواصل معنا' : 'Contact sales'}</a>
        </nav>
        <a className="lp-btn lp-btn-solid" href={LINKS.demo} onClick={() => setOpen(false)}>{rtl ? 'اطلب الوصول' : 'Request access'}</a>
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

type LocalCopy = readonly [string, string];
type MetaChannel = {
  id: 'instagram' | 'messenger' | 'whatsapp';
  name: LocalCopy;
  readiness: LocalCopy;
  message: LocalCopy;
  reply: LocalCopy;
  context: LocalCopy;
  action: LocalCopy;
  followup: LocalCopy;
  insight: LocalCopy;
  note: LocalCopy;
};

const META_CHANNELS: MetaChannel[] = [
  {
    id: 'instagram', name: ['Instagram', 'إنستغرام'], readiness: ['Integration-ready · provider approval required', 'جاهز للتكامل · يتطلب موافقة المزود'],
    message: ['Hi — do you have a table for four this Friday?', 'مرحبًا — هل لديكم طاولة لأربعة أشخاص يوم الجمعة؟'],
    reply: ['Yes. I can share the available times.', 'نعم. يمكنني مشاركة المواعيد المتاحة.'],
    context: ['Returning guest · asked about the terrace', 'ضيف عائد · سأل عن التراس'], action: ['Draft reservation', 'إنشاء مسودة حجز'],
    followup: ['Availability shared in the same conversation', 'تمت مشاركة المواعيد في المحادثة نفسها'], insight: ['DM → reservation intent', 'رسالة مباشرة ← نية حجز'],
    note: ['Designed for a linked Instagram professional account after Meta app review, permissions and Page setup.', 'مصمم لحساب إنستغرام احترافي مرتبط بعد مراجعة تطبيق Meta ومنح الأذونات وإعداد الصفحة.'],
  },
  {
    id: 'messenger', name: ['Messenger', 'ماسنجر'], readiness: ['Integration-ready · Page permissions required', 'جاهز للتكامل · يتطلب أذونات الصفحة'],
    message: ['Is the tasting menu available tonight?', 'هل قائمة التذوق متاحة الليلة؟'], reply: ['It is available from 7 PM. Shall I note your party size?', 'متاحة من السابعة مساءً. هل أسجل عدد الضيوف؟'],
    context: ['Facebook Page conversation · new guest', 'محادثة صفحة فيسبوك · ضيف جديد'], action: ['Assign to host', 'إسناد إلى مسؤول الاستقبال'],
    followup: ['Host continues inside the supported reply window', 'يتابع المسؤول ضمن نافذة الرد المدعومة'], insight: ['Question → qualified dining lead', 'استفسار ← فرصة زيارة مؤهلة'],
    note: ['Designed for Facebook Page messaging after the restaurant grants the required Page access and Resuto completes provider setup.', 'مصمم لمراسلة صفحات فيسبوك بعد منح المطعم صلاحيات الصفحة المطلوبة واستكمال إعداد المزود في ريسوتو.'],
  },
  {
    id: 'whatsapp', name: ['WhatsApp Business', 'واتساب للأعمال'], readiness: ['Available after approved business setup', 'متاح بعد اعتماد إعداد حساب الأعمال'],
    message: ['Can you confirm my pickup order is ready?', 'هل يمكن تأكيد أن طلب الاستلام جاهز؟'], reply: ['Your order is ready for pickup. View order', 'طلبك جاهز للاستلام. عرض الطلب'],
    context: ['Known customer · order #R-1842', 'عميل معروف · الطلب R-1842'], action: ['Send service update', 'إرسال تحديث الخدمة'],
    followup: ['Delivery status recorded for the team', 'تم تسجيل حالة التسليم للفريق'], insight: ['Conversation → fulfilled order', 'محادثة ← طلب مكتمل'],
    note: ['Designed for the WhatsApp Business Platform. Provider onboarding is required; business-initiated messages outside the service window use approved templates.', 'مصمم لمنصة واتساب للأعمال. يلزم إعداد المزود، وتستخدم الرسائل التي تبدأها المنشأة خارج نافذة الخدمة قوالب معتمدة.'],
  },
];

function ChannelGlyph({ id }: { id: MetaChannel['id'] }) {
  if (id === 'instagram') return <svg viewBox="0 0 24 24" aria-hidden><path className="brand-fill" d="M7.8 2h8.4A5.8 5.8 0 0 1 22 7.8v8.4a5.8 5.8 0 0 1-5.8 5.8H7.8A5.8 5.8 0 0 1 2 16.2V7.8A5.8 5.8 0 0 1 7.8 2Zm-.2 2A3.6 3.6 0 0 0 4 7.6v8.8A3.6 3.6 0 0 0 7.6 20h8.8a3.6 3.6 0 0 0 3.6-3.6V7.6A3.6 3.6 0 0 0 16.4 4H7.6Zm9.65 1.5a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5ZM12 7a5 5 0 1 1 0 10 5 5 0 0 1 0-10Zm0 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z" /></svg>;
  if (id === 'messenger') return <svg viewBox="0 0 24 24" aria-hidden><path className="brand-cut" d="m5.4 14.8 5.1-5.4 2.7 2.35 5.35-2.9-5.8 6.1-2.65-2.35-4.7 2.2Z" /></svg>;
  return <img src={marks.whatsapp} alt="" width={24} height={24} />;
}

export function Connect({ L }: { L: Landing }) {
  const { l, rtl, reduced } = L;
  const [selected, setSelected] = useState<MetaChannel['id']>('instagram');
  const channel = META_CHANNELS.find((item) => item.id === selected)!;
  const c = (pair: LocalCopy) => pair[rtl ? 1 : 0];
  useEffect(() => {
    if (reduced) return;
    const timer = window.setInterval(() => setSelected((current) => {
      const index = META_CHANNELS.findIndex((item) => item.id === current);
      return META_CHANNELS[(index + 1) % META_CHANNELS.length]!.id;
    }), 7200);
    return () => window.clearInterval(timer);
  }, [reduced]);
  return (
    <section className="lp-chapter lp-connect" id="connect">
      <div className="lp-shell meta-story">
        <header className="meta-story-head" data-reveal>
          <span className="lp-chapter-tag">{rtl ? 'منظومة Meta' : 'Meta ecosystem'}</span>
          <h2>{rtl ? 'من المحادثات إلى تشغيل المطعم. تجربة واحدة مترابطة.' : 'From conversations to restaurant operations. One connected experience.'}</h2>
          <p>{rtl ? 'صُمم ريسوتو ليجمع محادثات العملاء والسياق وإجراءات الفريق وقياس الأداء في مسار واضح — مع إعداد كل قناة وموافقاتها بصورة مستقلة.' : 'Resuto is designed to bring customer conversations, context, team actions and performance signals into one clear workflow — with each channel connected and approved independently.'}</p>
        </header>

        <div className="meta-console" data-channel={selected} data-reveal>
          <div className="meta-channel-tabs" role="group" aria-label={rtl ? 'اختر قناة المحادثة' : 'Choose a messaging channel'}>
            {META_CHANNELS.map((item) => <button key={item.id} type="button" aria-pressed={selected === item.id} className={selected === item.id ? 'is-on' : undefined} onClick={() => setSelected(item.id)}><span className={`meta-glyph is-${item.id}`}><ChannelGlyph id={item.id} /></span><span><strong>{c(item.name)}</strong><small>{c(item.readiness)}</small></span></button>)}
          </div>

          <ol className="meta-process" aria-label={rtl ? 'كيف تنتقل المحادثة إلى إجراء تشغيلي' : 'How a conversation becomes an operational action'}>
            <li><b>01</b><span><strong>{rtl ? 'رسالة العميل' : 'Customer message'}</strong><small>{rtl ? `يبدأ العميل المحادثة على ${c(channel.name)}.` : `The guest starts a conversation on ${c(channel.name)}.`}</small></span></li>
            <li><b>02</b><span><strong>{rtl ? 'الاستقبال والتوحيد' : 'Receive & unify'}</strong><small>{rtl ? 'بعد إعداد المزود، يوجّه Webhook الرسالة إلى صندوق ريسوتو الموحد.' : 'After provider setup, a webhook routes it into the Resuto inbox.'}</small></span></li>
            <li><b>03</b><span><strong>{rtl ? 'إضافة السياق' : 'Add context'}</strong><small>{rtl ? 'يظهر سجل المحادثة وبيانات العميل أو الطلب المتاحة للفريق.' : 'Available conversation, customer and order context appears for staff.'}</small></span></li>
            <li><b>04</b><span><strong>{rtl ? 'إجراء المطعم' : 'Restaurant action'}</strong><small>{c(channel.action)}</small></span></li>
            <li><b>05</b><span><strong>{rtl ? 'متابعة وقياس' : 'Follow up & learn'}</strong><small>{rtl ? 'يُرسل الرد وفق سياسة القناة، وتدعم الإشارات المصرح بها التقارير.' : 'The reply follows channel policy; authorized signals can inform reporting.'}</small></span></li>
          </ol>

          <div className="meta-workspace" key={selected}>
            <section className="meta-phone" aria-label={`${c(channel.name)} ${rtl ? 'مثال محاكاة' : 'simulated example'}`}>
              <header><span className={`meta-glyph is-${selected}`}><ChannelGlyph id={selected} /></span><div><strong>{c(channel.name)}</strong><small>{rtl ? 'محادثة عميل محاكاة' : 'Simulated customer conversation'}</small></div><i aria-hidden /></header>
              <div className="meta-thread"><p className="is-customer">{c(channel.message)}</p><p className="is-team">{c(channel.reply)}</p><span>{rtl ? 'مثال توضيحي · لا توجد بيانات حقيقية' : 'Illustrative example · no live data'}</span></div>
            </section>

            <div className="meta-route" aria-hidden><i /><i /><i /></div>

            <section className="meta-inbox" aria-label={rtl ? 'مسار صندوق الوارد الموحد' : 'Unified inbox workflow'}>
              <header><div><span>{rtl ? 'صندوق ريسوتو الموحد' : 'Resuto unified inbox'}</span><strong>{c(channel.context)}</strong></div><em>{rtl ? 'محاكاة' : 'SIMULATED'}</em></header>
              <ol className="meta-steps">
                <li className="is-active"><b>01</b><span><small>{rtl ? 'الرسالة' : 'Customer message'}</small><strong>{c(channel.name)}</strong></span></li>
                <li><b>02</b><span><small>{rtl ? 'السياق' : 'Unified context'}</small><strong>{c(channel.context)}</strong></span></li>
                <li><b>03</b><span><small>{rtl ? 'إجراء المطعم' : 'Restaurant action'}</small><strong>{c(channel.action)}</strong></span></li>
                <li><b>04</b><span><small>{rtl ? 'المتابعة' : 'Customer follow-up'}</small><strong>{c(channel.followup)}</strong></span></li>
              </ol>
              <footer><span>{rtl ? 'إشارة للنمو' : 'Business signal'}</span><strong>{c(channel.insight)}</strong></footer>
            </section>
          </div>

          <aside className="meta-accuracy"><span>{rtl ? 'حالة الجاهزية' : 'Readiness note'}</span><p>{c(channel.note)}</p></aside>
        </div>

        <div className="meta-proof" data-reveal>
          <p>{rtl ? 'توجد الموصلات ومسارات صندوق الوارد في قاعدة الكود، لكنها تحتاج بيانات اعتماد فعلية وإعداد المزود والمراجعات المطبقة قبل الإطلاق لكل مطعم. لا يعني العرض شراكة أو اعتمادًا من Meta.' : 'The connectors and inbox workflows exist in the codebase, but real credentials, provider configuration and applicable reviews are required before restaurant activation. This presentation does not imply a Meta partnership or approval.'}</p>
          <a className="lp-inline" href="/contact/?subject=partnerships">{rtl ? 'ناقش جاهزية التكامل ←' : 'Discuss integration readiness →'}</a>
        </div>

        <div className="itx itx-secondary">
          <div className="itx-head" data-reveal><h3>{l('Runs on its own.')} {l('Connects where it is ready.')}</h3><p>{l('Resuto works without any of these. Connect the ones you already use.')}</p></div>
        <ul className="itx-row" data-reveal>
          {INTEGRATIONS.map(([name, logo, mark, kind = ''], i) => (
            <li key={name} className={kind || undefined} style={{ ['--i' as string]: i }} title={name}>
              {logo ? <img src={logo} alt={name} loading="lazy" /> : <b role="img" aria-label={name}>{mark}</b>}
            </li>
          ))}
        </ul>
        </div>
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
        <p className="lp-pricing-note" data-reveal>{priced ? (L.rtl ? 'أسعار إطلاق عامة. تواصل مع فريق المبيعات لتأكيد التوفر والنطاق النهائي؛ رسوم المزودين منفصلة.' : 'Public launch pricing. Contact sales to confirm availability and final scope; provider fees are separate.') : ownT('platform.pricingUnavailable')} <a className="lp-inline" href={`${LINKS.pricing}#compare`}>{l('Compare every feature')}</a></p>
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
  const { l, num, rtl } = L;
  const tables = floor.tables.map((x, i) => ({ ...x, minSpendMinor: null, internalNotes: null, state: HERO_CYCLE[i % HERO_CYCLE.length] })) as SceneTable[];
  return (
    <section className="lp-cta">
      <div className="lp-cta-floor" aria-hidden>
        <svg viewBox={`0 0 ${floor.width} ${floor.height}`}>
          <FloorSceneContent layout={{ width: floor.width, height: floor.height, zones: floor.zones.map((z) => ({ ...z, label: l(z.label) })), objects: floor.objects.map((o) => ({ ...o, label: l(o.label) })), background: null, tables }}
            mode="operations" seatsLabel={(n) => `${num(n)} ${l('seats')}`} />
        </svg>
      </div>
      <div className="lp-shell lp-cta-inner">
        <div className="lp-cta-copy" data-reveal>
          <span className="lp-cta-kicker">{rtl ? 'الخطوة التالية' : 'The next service starts here'}</span>
          <h2>{rtl ? 'اجمع تشغيل مطعمك حول صورة واحدة واضحة.' : 'Bring your restaurant into one clear operating view.'}</h2>
          <p>{rtl ? 'شاركنا عدد الفروع وطريقة عمل فريقك وما تريد تحسينه. سنراجع معك مدى ملاءمة ريسوتو، ونطاق الإطلاق، والجاهزية المتاحة عبر محادثة مباشرة.' : 'Tell us about your locations, team workflow and priorities. We will discuss product fit, rollout scope and current availability with you directly.'}</p>
          <div className="lp-cta-actions">
            <a className="lp-btn lp-btn-solid lp-btn-lg" href="/contact/?subject=request-access">{rtl ? 'اطلب الوصول' : 'Request access'} <span aria-hidden>{rtl ? '←' : '→'}</span></a>
            <a className="lp-btn lp-btn-line" href="/contact/">{rtl ? 'تواصل مع المبيعات' : 'Contact sales'}</a>
            <a className="lp-cta-text-link" href={LINKS.pricing}>{rtl ? 'راجع الأسعار والخطط' : 'Review plans and pricing'} <span aria-hidden>{rtl ? '←' : '→'}</span></a>
          </div>
          <ul className="lp-cta-list"><li>{rtl ? 'العربية والإنجليزية' : 'Arabic and English'}</li><li>{rtl ? 'من صالة واحدة إلى عدة فروع' : 'From one room to multiple branches'}</li><li>{rtl ? 'نطاق واضح قبل الإطلاق' : 'Clear scope before rollout'}</li></ul>
        </div>
      </div>
    </section>
  );
}

export function Footer({ L, ownT }: { L: Landing; ownT: (k: string) => string }) {
  const { l, rtl } = L;
  return (
    <footer className="lp-foot">
      <div className="lp-shell lp-foot-grid">
        <div className="lp-foot-brand"><a className="lp-logo" href="/"><Wordmark rtl={rtl} /></a><p>{rtl ? 'بيئة تشغيل مترابطة تجمع تجربة الضيف وفريق المطعم حول صالة واحدة حية.' : 'A connected restaurant operating environment, built around one live floor and the teams who run it.'}</p><a className="lp-foot-email" href="mailto:contact@resuto.app"><span>{rtl ? 'تواصل معنا' : 'Talk to Resuto'}</span><strong>contact@resuto.app</strong></a></div>
        <div className="lp-foot-navs">
          <nav aria-label={l('Product')}><h4>{l('Product')}</h4><a href="/#studio">{l('Floor Studio')}</a><a href="/#service">{l('Guest service')}</a><a href="/#operations">{l('Operations')}</a><a href="/#connect">{rtl ? 'المنظومة والتكاملات' : 'Ecosystem & integrations'}</a></nav>
          <nav aria-label={rtl ? 'الشركة' : 'Company'}><h4>{rtl ? 'الشركة' : 'Company'}</h4><a href="/about/">{rtl ? 'عن ريسوتو' : 'About Resuto'}</a><a href="/contact/">{rtl ? 'تواصل معنا' : 'Contact'}</a><a href="/pricing/">{rtl ? 'الأسعار' : 'Pricing'}</a><a href="/contact/?subject=request-access">{rtl ? 'اطلب الوصول' : 'Request access'}</a></nav>
          <nav aria-label={rtl ? 'قانوني' : 'Legal'}><h4>{rtl ? 'قانوني' : 'Legal'}</h4><a href="/privacy/">{rtl ? 'سياسة الخصوصية' : 'Privacy policy'}</a><a href="/terms/">{rtl ? 'الشروط' : 'Terms'}</a><a href="mailto:founder@resuto.app">{rtl ? 'تواصل الأعمال' : 'Business contact'}</a></nav>
        </div>
        <div className="lp-foot-legal"><small>© {new Date().getFullYear()} Resuto</small><small>{rtl ? 'توب هاندلز ذ.م.م. هي جهة التواصل التجاري لريسوتو؛ تأسست في وايومنغ، الولايات المتحدة عام 2025، وتنسّق أعمالها من مصر.' : 'Top Handles LLC is Resuto’s business contact; incorporated in Wyoming, USA in 2025, with operations coordinated from Egypt.'}</small></div>
      </div>
    </footer>
  );
}
