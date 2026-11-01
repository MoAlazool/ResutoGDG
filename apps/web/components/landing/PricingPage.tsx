'use client';
// /pricing: React port of legacy/public/pricing.js (nav, hero with billing toggle, four plan cards, add-ons,
// the full comparison with the Foodics column, common questions, the sales form and the dark footer strip), filled
// from the live price list. Resuto 2.0 additions keep the same visual language: the Free QR line, the Egypt/Saudi
// switch and Build Your Resuto (priced by the same quote service invoices use).
import { formatNumber, type ModuleKey, type PriceQuote, type PublicPlansResponse } from '@resuto/contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '@/lib/i18n/client';
import { Switcher, Wordmark } from './Chrome';
import { LINKS } from './links';
import { salesPlanId, scrollToHash } from './pricing-helpers';
import { useLanding } from './use-landing';
import {
  BUSINESS_ID, COMPETITOR, MARK, WORD, addOns, amountFromMinor, amountWithUnit, competitorChecked, comparison, customPlan, faq, formatAmount, freePlan,
  moduleDetail, perUnit, pick, pluralBranches, pricingCards, yearlyIsTenMonths, type Cell, type Locale, type Pair,
} from '../../app/pricing/pricing-model';
import './landing.css';
import './pricing-page.css';

type Country = 'EG' | 'SA';
const accessHref = (plan?: string) => `/contact/?subject=request-access${plan ? `&plan=${encodeURIComponent(plan)}` : ''}`;

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
      // Whole numbers while counting; the last frame lands exactly on the price (87.50, not 88).
      setShown(p < 1 ? Math.round(a + (value - a) * k) : value);
      if (p < 1) raf = requestAnimationFrame(step); else from.current = value;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, animate]);
  return <b data-amount={value}>{formatAmount(shown, locale)}</b>;
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
          <a className="lp-btn lp-btn-solid" href="/contact/?subject=request-access"><span className="lp-cta-long">{c(['Request access', 'اطلب الوصول'])}</span><span className="lp-cta-short">{c(['Contact', 'تواصل'])}</span></a>
        </div>
      </div>
    </header>
  );
}

export function PricingPage({ initial, countries }: { initial: PublicPlansResponse; countries?: Partial<Record<Country, PublicPlansResponse>> }) {
  const { locale: loc } = useT();
  const locale = loc as Locale;
  const c = useCallback((p: Pair) => pick(locale, p), [locale]);
  const available = useMemo(() => ({ [initial.country]: initial, ...countries }), [initial, countries]);
  const [country, setCountry] = useState<Country>(initial.country as Country);
  const [yearly, setYearly] = useState(false);
  const [focus, setFocus] = useState('growth');
  /** The plan the visitor actually chose (?plan= or a click), for the sales inquiry; the comparison's focus defaults to Growth. */
  const [chosen, setChosen] = useState<string | null>(null);
  const choose = useCallback((id: string) => { setFocus(id); setChosen(id); }, []);
  const [reduced, setReduced] = useState(true);
  const data = available[country] ?? initial;

  useEffect(() => { setReduced(window.matchMedia('(prefers-reduced-motion: reduce)').matches); }, []);
  // ?plan=pro highlights that plan's card and comparison column (links from the landing teaser).
  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get('plan');
    if (wanted && /^[a-z0-9_-]{2,40}$/.test(wanted)) { setFocus(wanted); setChosen(wanted); }
    scrollToHash(window.location.hash);
  }, []);

  const cards = useMemo(() => pricingCards(data, locale), [data, locale]);
  const groups = useMemo(() => comparison(data, yearly, locale), [data, yearly, locale]);
  const questions = useMemo(() => faq(data, locale), [data, locale]);
  const ten = yearlyIsTenMonths(data);
  const free = freePlan(data);
  const egp = data.currency === 'EGP';
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
                ? c(['Reservations, QR ordering, the kitchen board and split bills, priced in Saudi riyals. Request access to discuss rollout.', 'الحجوزات وطلبات QR وشاشة المطبخ وتقسيم الفاتورة، بأسعار بالريال السعودي. اطلب الوصول لمناقشة الإطلاق.'])
                : c(['Reservations, QR ordering, the kitchen board and split bills, priced in Egyptian pounds. Request access to discuss rollout.', 'الحجوزات وطلبات QR وشاشة المطبخ وتقسيم الفاتورة، بأسعار بالجنيه المصري. اطلب الوصول لمناقشة الإطلاق.'])}</p>
              <div className="pr-switches">
                <div className="lp-seg lp-seg-pill billing-toggle" role="group" aria-label={c(['Billing period', 'فترة الدفع'])}>
                  <button type="button" className={yearly ? undefined : 'is-on'} aria-pressed={!yearly} onClick={() => setYearly(false)}>{c(['Monthly', 'شهري'])}</button>
                  <button type="button" className={yearly ? 'is-on' : undefined} aria-pressed={yearly} onClick={() => setYearly(true)}>{ten ? c(['Yearly · 2 months free', 'سنوي · شهران مجانًا']) : c(['Yearly', 'سنوي'])}</button>
                </div>
                <div className="lp-seg lp-seg-pill lp-seg-sm" role="group" aria-label={c(['Country', 'الدولة'])}>
                  {available.EG && <button type="button" className={country === 'EG' ? 'is-on' : undefined} aria-pressed={country === 'EG'} onClick={() => setCountry('EG')}>{c(['Egypt · EGP', 'مصر · جنيه'])}</button>}
                  {available.SA && <button type="button" className={country === 'SA' ? 'is-on' : undefined} aria-pressed={country === 'SA'} onClick={() => setCountry('SA')}>{c(['Saudi Arabia · SAR', 'السعودية · ريال'])}</button>}
                </div>
              </div>
            </div>

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
                        <a className={`lp-btn ${p.featured ? 'lp-btn-solid' : 'lp-btn-line-ink'} lp-btn-full`} href={accessHref(p.id)}
                          onClick={() => setChosen(p.id)}>
                          {sales ? c(['Contact sales', 'تواصل للمبيعات']) : c(['Request access', 'اطلب الوصول'])}
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
                    <a href={accessHref(free.id)}>{c(['Request access', 'اطلب الوصول'])} {locale === 'ar' ? '←' : '→'}</a>
                  </p>
                )}
                <div className="pr-addons" aria-label={c(['Add-ons', 'الإضافات'])}>
                  <h2>{c(['Add-ons', 'إضافات'])}</h2>
                  <ul>{addOns(data, yearly, locale).map((a) => <li key={a.name}><b>{a.name}</b><span><bdi>{a.price}</bdi></span></li>)}</ul>
                </div>
              </>
          </div>
        </section>

        {(
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
                  <select value={focusId} onChange={(e) => choose(e.target.value)}>{cards.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
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
                              <button type="button" onClick={() => choose(p.id)} aria-pressed={focusId === p.id}>
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

        <Builder data={data} country={country} yearly={yearly} locale={locale} />

        {(
          <section className="pr-faq" id="faq">
            <div className="lp-shell">
              <div className="pr-sec-head"><h2>{c(['Common questions', 'أسئلة شائعة'])}</h2></div>
              <div className="pr-qa">{questions.map(([q, a], i) => <details key={q} open={i === 0}><summary>{q}</summary><p>{a}</p></details>)}</div>
            </div>
          </section>
        )}

        <SalesForm locale={locale} planId={salesPlanId(chosen, planIds)} />
      </main>
      <footer className="pr-foot">
        <div className="lp-shell">
          <a href="/">{c(['Resuto home', 'الرئيسية'])}</a>
          <a href="/contact/">{c(['Contact sales', 'تواصل مع المبيعات'])}</a>
          <a href="/about/">{c(['About', 'عن ريسوتو'])}</a>
          <a href="/privacy/">{c(['Privacy', 'الخصوصية'])}</a>
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

/** Build Your Resuto: a static calculation from the versioned public catalog bundled with the marketing build. */
function Builder({ data, country, yearly, locale }: { data: PublicPlansResponse; country: Country; yearly: boolean; locale: Locale }) {
  const c = (p: Pair) => pick(locale, p);
  const custom = customPlan(data);
  const [planId, setPlanId] = useState(custom?.id ?? data.plans[0]?.id ?? 'free');
  const [addons, setAddons] = useState<ModuleKey[]>(['pay', 'connect']);
  const plan = data.plans.find((p) => p.id === planId);
  const interval = yearly ? 'year' : 'month';
  const quote = useMemo<PriceQuote>(() => {
    const planAmount = (yearly ? plan?.prices.year : plan?.prices.month)?.amountMinor ?? 0;
    const lines: PriceQuote['lines'] = [{ kind: 'plan', key: planId, amountMinor: planAmount }];
    const enabled = new Set<ModuleKey>((plan?.modules ?? []) as ModuleKey[]);
    for (const key of addons) {
      if (enabled.has(key)) continue;
      const module = data.modules.find((item) => item.key === key);
      const amountMinor = (yearly ? module?.prices.year : module?.prices.month)?.amountMinor ?? 0;
      lines.push({ kind: 'module', key, amountMinor });
      enabled.add(key);
    }
    return {
      planId, country, currency: data.currency, interval, lines,
      subtotalMinor: lines.reduce((sum, line) => sum + (line.included ? 0 : line.amountMinor), 0),
      modules: [...enabled], externalCostsNote: data.externalCostsNote, externalCostsNoteAr: data.externalCostsNoteAr,
    };
  }, [addons, country, data, interval, plan, planId, yearly]);

  const toggle = (m: ModuleKey) => setAddons((a) => (a.includes(m) ? a.filter((x) => x !== m) : [...a, m]));
  const planLabel = (id: string) => data.plans.find((p) => p.id === id)?.name ?? id;
  const lineName = (l: PriceQuote['lines'][number]) => {
    if (l.kind === 'plan') return planLabel(l.key);
    const m = data.modules.find((x) => x.key === l.key);
    return m ? (locale === 'ar' ? m.nameAr : m.name) : l.key;
  };
  const money = (minor: number) => amountFromMinor(minor, data.currency, locale);

  return (
    <section className="pr-build" id="build">
      <div className="lp-shell">
        <div className="pr-sec-head">
          <h2>{c(['Build your Resuto', 'ابنِ ريسوتو الخاص بك'])}</h2>
          <p>{c(['Start from any plan and add modules. This estimate uses the same versioned public price catalog shown above; sales confirms the final scope.', 'ابدأ من أي خطة وأضف الوحدات. يستخدم هذا التقدير قائمة الأسعار العامة نفسها المعروضة أعلاه؛ ويؤكد فريق المبيعات النطاق النهائي.'])}</p>
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
              <>
                <div className="pr-lines">
                  {quote.lines.filter((l) => !l.included).map((l) => (
                    <div key={`${l.kind}:${l.key}`}><span><bdi>{lineName(l)}</bdi></span><bdi>{money(l.amountMinor)}</bdi></div>
                  ))}
                </div>
                <div className="pr-total">
                  <span>{yearly ? c(['per year', 'سنويًا']) : c(['per month', 'شهريًا'])}</span>
                  <strong><bdi>{money(quote.subtotalMinor)}</bdi></strong>
                </div>
              </>
            <a className="lp-btn lp-btn-solid lp-btn-full" href={accessHref(planId)}>{c(['Request this setup', 'اطلب هذا الإعداد'])}</a>
            <p>{locale === 'ar' ? data.externalCostsNoteAr : data.externalCostsNote}</p>
          </aside>
        </div>
        <p className="pr-terms">{pluralBranches(custom?.limits.branches ?? 1, locale)} · {c(['Build Your Resuto includes Resuto Core.', 'تشمل خطة ابنِ ريسوتو الوحدة الأساسية.'])}</p>
      </div>
    </section>
  );
}

/** Static deployment contact panel: no fake submission or backend dependency. */
function SalesForm({ locale, planId }: { locale: Locale; planId: string | null }) {
  const c = (p: Pair) => pick(locale, p);
  return (
    <section className="pr-sales sales-panel" id="sales">
      <div className="lp-shell pr-sales-in">
        <div>
          <h2>{c(['Let’s shape your setup.', 'لنصمم ما يناسبك.'])}</h2>
          <p>{c(['Tell us what you need. This static site does not submit data to a server; contact sales by email and the team will reply directly.', 'أخبرنا بما تحتاجه. هذا الموقع الثابت لا يرسل بيانات إلى خادم؛ تواصل مع المبيعات بالبريد وسيرد عليك الفريق مباشرة.'])}</p>
        </div>
        <div className="pr-form">
          <p><b>{c(['Chosen plan', 'الخطة المختارة'])}:</b> <bdi>{planId ?? c(['Not selected', 'غير محددة'])}</bdi></p>
          <a className="lp-btn lp-btn-solid" href={`mailto:contact@resuto.app?subject=${encodeURIComponent(`Resuto ${planId ?? 'sales'} inquiry`)}`}>{c(['Email contact@resuto.app', 'راسل contact@resuto.app'])}</a>
          <a className="lp-btn lp-btn-line-ink" href={accessHref(planId ?? undefined)}>{c(['Request access page', 'صفحة طلب الوصول'])}</a>
        </div>
      </div>
    </section>
  );
}
