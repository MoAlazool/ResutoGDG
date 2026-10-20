'use client';
// /pricing: React port of legacy/public/pricing.js (nav, hero with billing toggle, four plan cards, add-ons,
// the full comparison with the Foodics column, common questions, the sales form and the dark footer strip), filled
// from the live price list. Resuto 2.0 additions keep the same visual language: the Free QR line, the Egypt/Saudi
// switch and Build Your Resuto (priced by the same quote service invoices use).
import { formatNumber, normalizeNumericInput, type ModuleKey, type PriceQuote, type PublicPlansResponse, type SalesInquiryReceipt } from '@resuto/contracts';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { api, ApiRequestError } from '@/lib/api';
import { useT } from '@/lib/i18n/client';
import { Switcher, Wordmark } from './Chrome';
import { LINKS } from './links';
import { useLanding } from './use-landing';
import {
  BUSINESS_ID, COMPETITOR, MARK, WORD, addOns, amountWithUnit, competitorChecked, comparison, currencyWord, customPlan, faq, freePlan,
  moduleDetail, perUnit, pick, pluralBranches, pricingCards, yearlyIsTenMonths, type Cell, type Locale, type Pair,
} from '../../app/pricing/pricing-model';
import './landing.css';
import './pricing-page.css';

type Country = 'EG' | 'SA';
const SIGNUP = `${LINKS.signup}?next=${encodeURIComponent('/onboarding')}`;

function Chip({ cell, locale }: { cell: Cell; locale: Locale }) {
  if (cell.kind === 'text') return <span className="cmp-v is-text"><bdi>{cell.text}</bdi></span>;
  return <span className={`cmp-v is-${cell.kind}`}><i aria-hidden>{MARK[cell.kind]}</i>{pick(locale, WORD[cell.kind])}</span>;
}

/** Figures count to their new value instead of snapping when the billing period changes (legacy countTo). */
function Amount({ value, locale, animate }: { value: number; locale: Locale; animate: boolean }) {
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
  return <b data-amount={value}>{formatNumber(shown, locale)}</b>;
}

function PricingNav({ locale }: { locale: Locale }) {
  const L = useLanding();
  const c = (p: Pair) => pick(locale, p);
  return (
    <header className="lp-nav is-stuck">
      <div className="lp-nav-inner">
        <a className="lp-logo" href="/" aria-label="Resuto"><Wordmark rtl={locale === 'ar'} /></a>
        <nav className="lp-nav-links" aria-label={c(['Sections', 'الأقسام'])}>
          <a href="#plans"><span>{c(['Plans', 'الخطط'])}</span></a>
          <a href="#compare"><span>{c(['Compare', 'المقارنة'])}</span></a>
          <a href="#faq"><span>{c(['Questions', 'الأسئلة'])}</span></a>
          <a href="/"><span>{c(['Product', 'المنتج'])}</span></a>
        </nav>
        <div className="lp-nav-end">
          <Switcher L={L} />
          <a className="lp-btn lp-btn-solid" href={LINKS.demo}><span className="lp-cta-long">{c(['Open the live demo', 'جرّب العرض المباشر'])}</span><span className="lp-cta-short">{c(['Live demo', 'عرض مباشر'])}</span></a>
        </div>
      </div>
    </header>
  );
}

export function PricingPage({ initial }: { initial: PublicPlansResponse | null }) {
  const { locale: loc } = useT();
  const locale = loc as Locale;
  const c = useCallback((p: Pair) => pick(locale, p), [locale]);
  const [country, setCountry] = useState<Country>(initial?.country ?? 'EG');
  const [byCountry, setByCountry] = useState<Partial<Record<Country, PublicPlansResponse>>>(initial ? { [initial.country]: initial } : {});
  const [failed, setFailed] = useState(false);
  const [yearly, setYearly] = useState(false);
  const [focus, setFocus] = useState('growth');
  const [reduced, setReduced] = useState(true);
  const data = byCountry[country] ?? null;

  useEffect(() => { setReduced(window.matchMedia('(prefers-reduced-motion: reduce)').matches); }, []);
  // ?plan=pro highlights that plan's card and comparison column (links from the landing teaser).
  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get('plan');
    if (wanted && /^[a-z0-9_-]{2,40}$/.test(wanted)) setFocus(wanted);
    if (window.location.hash) document.querySelector(window.location.hash)?.scrollIntoView();
  }, []);

  const load = useCallback(async (which: Country) => {
    setFailed(false);
    try {
      const body = await api<PublicPlansResponse>(`/public/plans?country=${which}&interval=month`);
      setByCountry((m) => ({ ...m, [which]: body }));
    } catch {
      setFailed(true);
    }
  }, []);
  useEffect(() => { if (!byCountry[country]) void load(country); }, [country, byCountry, load]);

  const cards = useMemo(() => (data ? pricingCards(data, locale) : []), [data, locale]);
  const groups = useMemo(() => (data ? comparison(data, yearly, locale) : []), [data, yearly, locale]);
  const questions = useMemo(() => (data ? faq(data, locale) : []), [data, locale]);
  const ten = data ? yearlyIsTenMonths(data) : false;
  const free = data ? freePlan(data) : null;
  const egp = (data?.currency ?? 'EGP') === 'EGP';
  const planIds = cards.map((x) => x.id);
  const focusId = planIds.includes(focus) ? focus : 'growth';

  return (
    <div className="lp pr">
      <a className="skip-link" href="#plans">{c(['Skip to content', 'تخطَّ إلى المحتوى'])}</a>
      <PricingNav locale={locale} />
      <main className="lp-main">
        <section className="pr-hero" id="plans">
          <div className="lp-shell">
            <div className="pr-head">
              <span className="lp-chapter-tag">{c(['Pricing', 'الأسعار'])}</span>
              <h1>{c(['One price for the whole service.', 'سعر واحد للخدمة كلها.'])}</h1>
              <p>{country === 'SA'
                ? c(['Reservations, QR ordering, the kitchen board and split bills, priced in Saudi riyals. Start with a 14-day trial; no card is needed.', 'الحجوزات وطلبات QR وشاشة المطبخ وتقسيم الفاتورة، بأسعار بالريال السعودي. ابدأ بتجربة 14 يومًا دون بطاقة.'])
                : c(['Reservations, QR ordering, the kitchen board and split bills, priced in Egyptian pounds. Start with a 14-day trial; no card is needed.', 'الحجوزات وطلبات QR وشاشة المطبخ وتقسيم الفاتورة، بأسعار بالجنيه المصري. ابدأ بتجربة 14 يومًا دون بطاقة.'])}</p>
              <div className="pr-switches">
                <div className="lp-seg lp-seg-pill billing-toggle" role="group" aria-label={c(['Billing period', 'فترة الدفع'])}>
                  <button type="button" className={yearly ? undefined : 'is-on'} aria-pressed={!yearly} onClick={() => setYearly(false)}>{c(['Monthly', 'شهري'])}</button>
                  <button type="button" className={yearly ? 'is-on' : undefined} aria-pressed={yearly} onClick={() => setYearly(true)}>{ten ? c(['Yearly · 2 months free', 'سنوي · شهران مجانًا']) : c(['Yearly', 'سنوي'])}</button>
                </div>
                <div className="lp-seg lp-seg-pill lp-seg-sm" role="group" aria-label={c(['Country', 'الدولة'])}>
                  <button type="button" className={country === 'EG' ? 'is-on' : undefined} aria-pressed={country === 'EG'} onClick={() => setCountry('EG')}>{c(['Egypt · EGP', 'مصر · جنيه'])}</button>
                  <button type="button" className={country === 'SA' ? 'is-on' : undefined} aria-pressed={country === 'SA'} onClick={() => setCountry('SA')}>{c(['Saudi Arabia · SAR', 'السعودية · ريال'])}</button>
                </div>
              </div>
            </div>

            {failed && !data && (
              <div className="pr-free" role="alert"><b>{c(['Prices could not be loaded.', 'تعذّر تحميل الأسعار.'])}</b>
                <button type="button" className="lp-btn lp-btn-line-ink lp-btn-sm" onClick={() => void load(country)}>{c(['Retry', 'إعادة المحاولة'])}</button></div>
            )}
            {!data && !failed && <div className="pr-grid" aria-busy="true">{[0, 1, 2, 3].map((i) => <article key={i} className="pr-card" style={{ minHeight: 420 }} />)}</div>}

            {data && (
              <>
                <div className="pr-grid pricing-grid" id="pr-grid">
                  {cards.map((p) => {
                    const amount = yearly ? p.yearly : p.monthly;
                    const sales = p.id === BUSINESS_ID;
                    return (
                      <article key={p.id} className={`price-card pr-card${p.featured ? ' is-featured' : ''}${focusId === p.id ? ' is-focus' : ''}`} data-plan={p.id}>
                        <header><h2><bdi>{p.name}</bdi></h2>{p.featured && <span className="pr-badge">{c(['Most popular', 'الأكثر اختيارًا'])}</span>}</header>
                        <p className="pr-for">{p.blurb}</p>
                        <div className="pr-price">
                          {amount !== null
                            ? <><Amount value={amount} locale={locale} animate={!reduced} /><span>{perUnit(data.currency, yearly, locale)}</span></>
                            : <><b className="is-talk">{c(['Let’s talk', 'لنتحدث'])}</b><span>{c(['Custom pricing', 'سعر حسب احتياجك'])}</span></>}
                        </div>
                        <small className="pr-billed">{sales ? c(['Scoped and quoted separately', 'يحدد النطاق والسعر بالاتفاق'])
                          : yearly ? (ten ? c(['Billed annually · 10 months for 12', 'دفع سنوي · 10 أشهر مقابل 12']) : c(['Billed annually', 'دفع سنوي'])) : c(['Billed monthly', 'دفع شهري'])}</small>
                        <a className={`lp-btn ${p.featured ? 'lp-btn-solid' : 'lp-btn-line-ink'} lp-btn-full`} href={sales ? '#sales' : SIGNUP}>
                          {sales ? c(['Contact sales', 'تواصل للمبيعات']) : c(['Start 14-day trial', 'ابدأ تجربة 14 يومًا'])}
                        </a>
                        <ul>{p.bullets.map((b) => <li key={b}>{b}</li>)}</ul>
                      </article>
                    );
                  })}
                </div>
                <p className="pr-terms">{c(['Launch pricing. Online card payment for Resuto subscriptions is not available yet: paid plans are invoiced by Resuto after the trial, and nothing is charged automatically. Payment gateway, delivery, WhatsApp and SMS provider fees are separate.', 'أسعار الإطلاق. الدفع الإلكتروني لاشتراكات ريسوتو غير متاح بعد: تصدر ريسوتو فواتير الخطط المدفوعة بعد التجربة، ولا يتم أي خصم تلقائي. رسوم بوابات الدفع والتوصيل وواتساب والرسائل منفصلة.'])}</p>
                {free && (
                  <p className="pr-free">
                    <b><bdi>{free.name}</bdi></b>
                    <span>{((locale === 'ar' ? free.descriptionAr : free.description) ?? free.description ?? '').replace(/[.。]\s*$/, '')}
                      {typeof free.limits.orders_per_month === 'number' && <> · {c(['up to', 'حتى'])} {formatNumber(free.limits.orders_per_month, locale)} {c(['orders a month', 'طلب شهريًا'])}</>}</span>
                    <a href={SIGNUP}>{c(['Start free', 'ابدأ مجانًا'])} {locale === 'ar' ? '←' : '→'}</a>
                  </p>
                )}
                <div className="pr-addons" aria-label={c(['Add-ons', 'الإضافات'])}>
                  <h2>{c(['Add-ons', 'إضافات'])}</h2>
                  <ul>{addOns(data, yearly, locale).map((a) => <li key={a.name}><b>{a.name}</b><span><bdi>{a.price}</bdi></span></li>)}</ul>
                </div>
              </>
            )}
          </div>
        </section>

        {data && (
          <section className="pr-compare" id="compare">
            <div className="lp-shell">
              <div className="pr-sec-head">
                <h2>{c(['Compare every plan', 'قارن كل الخطط'])}</h2>
                <p>{egp
                  ? c(['Every module and limit for the four Resuto plans, from the live price list, beside the Foodics Basic package in Egypt. Each cell says whether something is included, an add-on, priced by agreement or not specified.', 'كل وحدة وحدّ في خطط ريسوتو الأربع من قائمة الأسعار الحالية، بجانب الباقة الأساسية من فودكس في مصر. كل خانة توضح هل الميزة متضمَّنة أم إضافة أم بسعر حسب الاتفاق أم غير معلنة.'])
                  : c(['Every module and limit for the four Resuto plans, from the live price list.', 'كل وحدة وحدّ في خطط ريسوتو الأربع من قائمة الأسعار الحالية.'])}</p>
              </div>
              <div className="cmp-wrap" id="pr-table">
                <ul className="cmp-legend">{(['yes', 'no', 'quote', 'confirm', ...(egp ? ['unknown'] as const : [])] as const).map((k) => <li key={k}><Chip cell={{ kind: k }} locale={locale} /></li>)}</ul>
                <label className="cmp-pick"><span>{c(['Plan to compare', 'الخطة للمقارنة'])}</span>
                  <select value={focusId} onChange={(e) => setFocus(e.target.value)}>{cards.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
                </label>
                <div className="cmp-scroll" tabIndex={0} role="region" aria-label={c(['Plan comparison', 'مقارنة الخطط'])}>
                  <table className="cmp" data-focus={focusId}>
                    <thead>
                      <tr>
                        <th scope="col">{c(['Feature', 'الميزة'])}</th>
                        {cards.map((p) => {
                          const amount = yearly ? p.yearly : p.monthly;
                          return (
                            <th key={p.id} scope="col" data-plan={p.id} className={focusId === p.id ? 'is-on' : undefined}>
                              <button type="button" onClick={() => setFocus(p.id)} aria-pressed={focusId === p.id}>
                                <b><bdi>{p.name}</bdi></b>
                                <small>{amount !== null ? <bdi>{amountWithUnit(amount, data.currency, yearly, locale)}</bdi> : c(['Let’s talk', 'لنتحدث'])}</small>
                              </button>
                            </th>
                          );
                        })}
                        {egp && <th scope="col" data-plan="rival"><b>{COMPETITOR.name} · {c(COMPETITOR.tier)}</b><small>{c(COMPETITOR.scope)}</small></th>}
                      </tr>
                    </thead>
                    <tbody>
                      {groups.map((g) => (
                        <Group key={g.group} group={g} planIds={planIds} egp={egp} locale={locale} />
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="cmp-notes">
                  {egp && <p><b>{COMPETITOR.name}:</b> {c(COMPETITOR.note)}</p>}
                  {egp && <p>{c(['Competitor details are from the official page for that package, last checked', 'بيانات المنافس من الصفحة الرسمية لتلك الباقة، آخر مراجعة'])} {competitorChecked(locale)}: <a href={COMPETITOR.source} target="_blank" rel="noopener noreferrer"><bdi>foodics.com/ar/foodics-pricing-egypt</bdi></a>. {c(['“Not publicly specified” means the page does not say; it does not mean the feature is missing.', '«غير معلن» تعني أن الصفحة لا تذكر ذلك، ولا تعني أن الميزة غير موجودة.'])}</p>}
                  <p>{locale === 'ar' ? data.externalCostsNoteAr : data.externalCostsNote}</p>
                </div>
              </div>
            </div>
          </section>
        )}

        {data && <Builder data={data} country={country} yearly={yearly} locale={locale} />}

        {data && (
          <section className="pr-faq" id="faq">
            <div className="lp-shell">
              <div className="pr-sec-head"><h2>{c(['Common questions', 'أسئلة شائعة'])}</h2></div>
              <div className="pr-qa">{questions.map(([q, a], i) => <details key={q} open={i === 0}><summary>{q}</summary><p>{a}</p></details>)}</div>
            </div>
          </section>
        )}

        <SalesForm locale={locale} planId={planIds.includes(focus) && focus !== BUSINESS_ID ? focus : null} />
      </main>
      <footer className="pr-foot">
        <div className="lp-shell">
          <a href="/">{c(['Resuto home', 'الرئيسية'])}</a>
          <a href={LINKS.demo}>{c(['Restaurant demo', 'تجربة المطعم'])}</a>
          <a href={LINKS.reserve}>{c(['Reserve a table', 'احجز طاولة'])}</a>
          <a href={LINKS.menu}>{c(['Menu', 'القائمة'])}</a>
          <small>© <bdi>{new Date().getFullYear()}</bdi> Resuto</small>
        </div>
      </footer>
    </div>
  );
}

function Group({ group, planIds, egp, locale }: { group: ReturnType<typeof comparison>[number]; planIds: string[]; egp: boolean; locale: Locale }) {
  return (
    <>
      <tr className="cmp-group"><th colSpan={planIds.length + (egp ? 2 : 1)} scope="colgroup"><span>{group.group}</span></th></tr>
      {group.rows.map((r) => (
        <tr key={r.label}>
          <th scope="row">{r.label}{r.detail && <small>{r.detail}</small>}</th>
          {planIds.map((id) => <td key={id} data-plan={id}><Chip cell={r.cells[id] ?? { kind: 'unknown' }} locale={locale} /></td>)}
          {egp && <td data-plan="rival"><Chip cell={r.rival} locale={locale} /></td>}
        </tr>
      ))}
    </>
  );
}

/** Build Your Resuto: a base plan plus modules, priced by POST /public/pricing/quote (the invoice's pricing service). */
function Builder({ data, country, yearly, locale }: { data: PublicPlansResponse; country: Country; yearly: boolean; locale: Locale }) {
  const c = (p: Pair) => pick(locale, p);
  const custom = customPlan(data);
  const [planId, setPlanId] = useState(custom?.id ?? data.plans[0]?.id ?? 'free');
  const [addons, setAddons] = useState<ModuleKey[]>(['pay', 'connect']);
  const [quote, setQuote] = useState<PriceQuote | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  const seq = useRef(0);
  const plan = data.plans.find((p) => p.id === planId);
  const interval = yearly ? 'year' : 'month';

  useEffect(() => {
    const id = ++seq.current;
    setState('loading');
    const timer = setTimeout(async () => {
      try {
        const q = await api<PriceQuote>('/public/pricing/quote', { body: { planId, country, interval, addons } });
        if (id === seq.current) { setQuote(q); setState('idle'); }
      } catch {
        if (id === seq.current) setState('error');
      }
    }, 180);
    return () => clearTimeout(timer);
  }, [planId, country, interval, addons]);

  const toggle = (m: ModuleKey) => setAddons((a) => (a.includes(m) ? a.filter((x) => x !== m) : [...a, m]));
  const planLabel = (id: string) => data.plans.find((p) => p.id === id)?.name ?? id;
  const lineName = (l: PriceQuote['lines'][number]) => {
    if (l.kind === 'plan') return planLabel(l.key);
    const m = data.modules.find((x) => x.key === l.key);
    return m ? (locale === 'ar' ? m.nameAr : m.name) : l.key;
  };
  const money = (minor: number) => `${formatNumber(Math.round(minor / 100), locale)} ${currencyWord(data.currency, locale)}`;

  return (
    <section className="pr-build" id="build">
      <div className="lp-shell">
        <div className="pr-sec-head">
          <h2>{c(['Build your Resuto', 'ابنِ ريسوتو الخاص بك'])}</h2>
          <p>{c(['Start from any plan and add modules. The quote is calculated by the same pricing service your invoice uses.', 'ابدأ من أي خطة وأضف الوحدات. يُحسب العرض بخدمة التسعير نفسها التي تُصدر فاتورتك.'])}</p>
        </div>
        <div className="pr-build-in">
          <div className="pr-build-card">
            <h3>{c(['Starting plan', 'الخطة الأساسية'])}</h3>
            <div className="lp-seg lp-seg-pill lp-seg-sm" role="group" aria-label={c(['Starting plan', 'الخطة الأساسية'])} style={{ flexWrap: 'wrap', borderRadius: 18 }}>
              {data.plans.map((p) => (
                <button key={p.id} type="button" className={p.id === planId ? 'is-on' : undefined} aria-pressed={p.id === planId} onClick={() => setPlanId(p.id)}><bdi>{p.name}</bdi></button>
              ))}
            </div>
            <h3>{c(['Add modules', 'أضف وحدات'])}</h3>
            <div className="pr-chips">
              {data.modules.filter((m) => m.key !== 'core').map((m) => {
                const inPlan = plan?.modules.includes(m.key) ?? false;
                const on = inPlan || addons.includes(m.key);
                const price = (yearly ? m.prices.year : m.prices.month)?.amountMinor;
                return (
                  <button key={m.key} type="button" className="pr-chip" aria-pressed={on} disabled={inPlan} onClick={() => toggle(m.key)}>
                    <i aria-hidden>{on ? '✓' : ''}</i>
                    <span><strong>{locale === 'ar' ? m.nameAr : m.name}</strong><small>{moduleDetail(m, locale)}</small></span>
                    <em>{inPlan ? c(['In plan', 'ضمن الخطة']) : typeof price === 'number' ? <bdi>{money(price)}</bdi> : '—'}</em>
                  </button>
                );
              })}
            </div>
          </div>
          <aside className="pr-build-card pr-summary" aria-live="polite">
            <h3>{c(['Total', 'الإجمالي'])}</h3>
            {state === 'error' && <p className="pr-error" role="alert">{c(['Could not calculate this quote. Try again.', 'تعذّر حساب العرض. حاول مرة أخرى.'])}</p>}
            {quote && (
              <>
                <div className="pr-lines">
                  {quote.lines.filter((l) => !l.included).map((l) => (
                    <div key={`${l.kind}:${l.key}`}><span><bdi>{lineName(l)}</bdi></span><bdi>{money(l.amountMinor)}</bdi></div>
                  ))}
                </div>
                <div className="pr-total" style={{ opacity: state === 'loading' ? 0.55 : 1 }}>
                  <span>{yearly ? c(['per year', 'سنويًا']) : c(['per month', 'شهريًا'])}</span>
                  <strong><bdi>{money(quote.subtotalMinor)}</bdi></strong>
                </div>
              </>
            )}
            {!quote && state === 'loading' && <p>{c(['Calculating…', 'جارٍ الحساب…'])}</p>}
            <a className="lp-btn lp-btn-solid lp-btn-full" href={SIGNUP}>{c(['Get started with this setup', 'ابدأ بهذا الإعداد'])}</a>
            <p>{locale === 'ar' ? data.externalCostsNoteAr : data.externalCostsNote}</p>
          </aside>
        </div>
        <p className="pr-terms">{pluralBranches(custom?.limits.branches ?? 1, locale)} · {c(['Build Your Resuto includes Resuto Core.', 'تشمل خطة ابنِ ريسوتو الوحدة الأساسية.'])}</p>
      </div>
    </section>
  );
}

/** Sales form (legacy "Let’s shape your setup."): stored for the Resuto team via POST /public/sales-inquiries. */
function SalesForm({ locale, planId }: { locale: Locale; planId: string | null }) {
  const c = (p: Pair) => pick(locale, p);
  const arrow = locale === 'ar' ? '←' : '→';
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<SalesInquiryReceipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = useRef<string | null>(null);

  async function submit(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    if (busy) return;
    const f = new FormData(ev.currentTarget);
    key.current ??= crypto.randomUUID();
    setBusy(true);
    setError(null);
    try {
      const receipt = await api<SalesInquiryReceipt>('/public/sales-inquiries', { body: {
        restaurant: String(f.get('restaurant') ?? '').trim(), email: String(f.get('email') ?? '').trim(),
        branches: Number(normalizeNumericInput(String(f.get('branches') ?? '1'))),
        requirements: String(f.get('requirements') ?? '').trim(), website: String(f.get('website') ?? ''),
        planId, locale, key: key.current,
      } });
      setDone(receipt);
    } catch (e) {
      const kind = e instanceof ApiRequestError ? e.kind : 'server';
      setError(kind === 'validation' ? c(['Check the form: every field is required and the email must be valid.', 'راجع النموذج: كل الحقول مطلوبة ويجب أن يكون البريد صحيحًا.'])
        : kind === 'rate_limited' ? c(['We already have your recent requests. The team will reply to them.', 'وصلتنا طلباتك الأخيرة بالفعل، وسيرد عليها الفريق.'])
          : kind === 'offline' ? c(['You are offline. Your answers are still here; send again when you are connected.', 'لا يوجد اتصال. إجاباتك ما زالت هنا؛ أرسل مرة أخرى عند الاتصال.'])
            : c(['The request was not sent. Your answers are still here; try again in a moment.', 'لم يُرسل الطلب. إجاباتك ما زالت هنا؛ حاول مرة أخرى بعد قليل.']));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="pr-sales sales-panel" id="sales">
      <div className="lp-shell pr-sales-in">
        <div>
          <h2>{c(['Let’s shape your setup.', 'لنصمم ما يناسبك.'])}</h2>
          <p>{c(['Tell us what you need. Your request is saved for the Resuto team, who reply by email. Automatic email notifications are not enabled.', 'أخبرنا بما تحتاجه. يُحفظ طلبك لفريق ريسوتو الذي يرد عليك بالبريد. إشعارات البريد التلقائية غير مفعّلة.'])}</p>
        </div>
        <form id="sales-form" className="pr-form" onSubmit={submit} noValidate={false}>
          {done ? (
            <p role="status">{c(['Request received. Reference:', 'تم استلام الطلب. الرقم:'])} <bdi>{done.reference}</bdi></p>
          ) : (
            <>
              <label>{c(['Restaurant / company', 'المطعم / الشركة'])}<input name="restaurant" required maxLength={120} autoComplete="organization" /></label>
              <label>{c(['Email', 'البريد الإلكتروني'])}<input name="email" type="email" required maxLength={200} autoComplete="email" dir="ltr" /></label>
              <label>{c(['Branches', 'الفروع'])}<input name="branches" type="text" inputMode="numeric" pattern="[0-9٠-٩]{1,3}" defaultValue="1" required dir="ltr" /></label>
              <label className="is-wide">{c(['What do you need?', 'ماذا تحتاج؟'])}<textarea name="requirements" required maxLength={1000} rows={3} /></label>
              <label className="pr-trap" aria-hidden>Website<input name="website" tabIndex={-1} autoComplete="off" /></label>
              {error && <p role="alert">{error}</p>}
              <button className="lp-btn lp-btn-solid" type="submit" disabled={busy}>{busy ? c(['Sending…', 'جارٍ الإرسال…']) : <>{c(['Send inquiry', 'إرسال الطلب'])} {arrow}</>}</button>
            </>
          )}
        </form>
      </div>
    </section>
  );
}
