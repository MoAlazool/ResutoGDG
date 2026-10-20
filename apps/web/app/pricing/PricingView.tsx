'use client';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MODULE_KEYS, type ModuleKey, type PriceQuote, type PublicPlan, type PublicPlansResponse, INTL_LOCALE } from '@resuto/contracts';
import { api } from '@/lib/api';
import { money } from '@/lib/format';
import { Wordmark } from '@resuto/ui';
import { LanguageToggle, useT } from '@/lib/i18n/client';
import { MODULE_DESC_AR, PRICING_STRINGS } from './strings';
import css from './pricing.module.css';

type Country = 'EG' | 'SA';
type Interval = 'month' | 'year';
const FEATURED = 'growth';
const fill = (s: string, vars: Record<string, string | number>) => Object.entries(vars).reduce((a, [k, v]) => a.replaceAll(`{${k}}`, String(v)), s);
const num = (n: number, locale: 'en' | 'ar') => new Intl.NumberFormat(locale === 'ar' ? INTL_LOCALE.ar : 'en-EG').format(n);

export function PricingView() {
  const { locale } = useT();
  const s = PRICING_STRINGS[locale];
  const [country, setCountry] = useState<Country>('EG');
  const [interval, setBillingInterval] = useState<Interval>('month');
  const [data, setData] = useState<PublicPlansResponse | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setError(false);
    try {
      setData(await api<PublicPlansResponse>(`/public/plans?country=${country}&interval=${interval}`));
    } catch {
      setError(true);
    }
  }, [country, interval]);
  useEffect(() => { void load(); }, [load]);

  const plans = data?.plans ?? [];
  const fixedPlans = plans.filter((p) => !p.isCustom);
  const modName = (k: ModuleKey) => {
    const m = data?.modules.find((x) => x.key === k);
    return m ? (locale === 'ar' ? m.nameAr : m.name) : k;
  };
  const modPrice = (k: ModuleKey) => data?.modules.find((x) => x.key === k)?.price ?? null;
  // Annual saving computed from the live prices, never hard-coded.
  const savingPct = useMemo(() => {
    const p = plans.find((x) => x.id === FEATURED) ?? plans.find((x) => (x.prices.month?.amountMinor ?? 0) > 0);
    const m = p?.prices.month?.amountMinor ?? 0, y = p?.prices.year?.amountMinor ?? 0;
    return m > 0 && y > 0 && y < m * 12 ? Math.round((1 - y / (m * 12)) * 100) : 0;
  }, [plans]);

  const limitLines = (p: PublicPlan) => {
    const out: string[] = [];
    const l = p.limits;
    if (l.branches !== undefined) out.push(fill(s.limitBranches, { n: num(l.branches, locale) }));
    if (l.staff !== undefined) out.push(fill(s.limitStaff, { n: num(l.staff, locale) }));
    if (l.orders_per_month !== undefined) out.push(fill(s.limitOrders, { n: num(l.orders_per_month, locale) }));
    if (l.ai_requests_per_month !== undefined) out.push(l.ai_requests_per_month > 0 ? fill(s.limitAi, { n: num(l.ai_requests_per_month, locale) }) : s.noAi);
    return out;
  };

  return (
    <div className={css.page}>
      <header className={css.header}>
        <div className={`${css.wrap} ${css.headerInner}`}>
          <Link href="/" className={css.brand} aria-label={locale === 'ar' ? 'ريسوتو' : 'Resuto'}>
            {/* The Resuto wordmark, as on the landing page: the Arabic logotype in Arabic, the Latin wordmark otherwise. */}
            {locale === 'ar'
              ? <img src="/landing/resuto-arabic-logo.webp" alt="ريسوتو" width={308} height={96} style={{ height: 32, width: 'auto' }} />
              : <Wordmark size="sm" label="Resuto" />}
          </Link>
          <nav className={css.nav} aria-label="Pricing sections">
            <a href="#plans">{s.navPlans}</a><a href="#compare">{s.navCompare}</a><a href="#build">{s.navBuild}</a><a href="#faq">{s.navFaq}</a>
          </nav>
          <div className={css.headerActions}>
            <LanguageToggle />
            <Link href="/login" className={css.ghost}>{s.signIn}</Link>
            <Link href="/signup?next=/onboarding" className={css.cta}>{s.startFree}</Link>
          </div>
        </div>
      </header>

      <main>
        <section className={`${css.wrap} ${css.hero}`} id="plans">
          <div className={css.overline}>{s.overline}</div>
          <h1>{s.title}</h1>
          <p>{s.subtitle}</p>
          <div className={css.switches}>
            <div className={css.segmented} role="group" aria-label="Country">
              <button type="button" aria-pressed={country === 'EG'} onClick={() => setCountry('EG')}>{s.egypt}</button>
              <button type="button" aria-pressed={country === 'SA'} onClick={() => setCountry('SA')}>{s.saudi}</button>
            </div>
            <div className={css.segmented} role="group" aria-label="Billing interval">
              <button type="button" aria-pressed={interval === 'month'} onClick={() => setBillingInterval('month')}>{s.monthly}</button>
              <button type="button" aria-pressed={interval === 'year'} onClick={() => setBillingInterval('year')}>
                {s.yearly}{savingPct > 0 && <span className={css.save}>{fill(s.save, { pct: num(savingPct, locale) })}</span>}
              </button>
            </div>
          </div>
        </section>

        <section className={css.wrap}>
          {error && <div className="notice notice-danger" role="alert">{s.error} <button className="btn btn-sm" onClick={() => void load()}>{s.retry}</button></div>}
          {!data && !error && <div className={css.plans} aria-busy="true">{[0, 1, 2, 3, 4].map((i) => <div key={i} className={css.plan}><div className="skeleton" style={{ height: 180 }} /></div>)}</div>}
          {data && (
            <div className={css.plans}>
              {plans.map((p) => {
                const featured = p.id === FEATURED;
                const price = p.price;
                const href = p.isCustom ? '#build' : `/signup?next=${encodeURIComponent('/onboarding')}`;
                return (
                  <article key={p.id} className={`${css.plan} ${featured ? css.planFeatured : ''}`}>
                    {featured && <span className={css.tag}>{s.recommended}</span>}
                    <h3>{locale === 'ar' && p.nameAr ? p.nameAr : p.name}</h3>
                    <p className={css.planDesc}>{p.isCustom ? s.customLead : p.description}</p>
                    {price ? (
                      <div>
                        <div className={css.priceRow}>
                          <span className={css.amount}>{money(price.amountMinor, data.currency, locale)}</span>
                          <span className={css.unit}>{interval === 'month' ? s.perMonth : s.perYear}</span>
                        </div>
                        <div className={css.billed}>{interval === 'month' ? s.billedMonthly : s.billedYearly}</div>
                      </div>
                    ) : <div className={css.billed}>{s.priceMissing}</div>}
                    {p.isCustom
                      ? <a href={href} className={css.planCta}>{s.buildOwn}</a>
                      : <Link href={href} className={css.planCta}>{price && price.amountMinor > 0 ? s.startTrial : s.startFreePlan}</Link>}
                    <ul className={css.list}>
                      {p.modules.map((m) => <li key={m}>{modName(m)}</li>)}
                    </ul>
                    <ul className={`${css.list} ${css.listMuted}`}>{limitLines(p).map((l) => <li key={l}>{l}</li>)}</ul>
                  </article>
                );
              })}
            </div>
          )}
          <p className={css.note}>{s.billingNote}</p>
        </section>

        {data && (
          <section className={css.section} id="compare">
            <div className={css.wrap}>
              <div className={css.sectionHead}><h2>{s.compareTitle}</h2><p>{s.compareSub}</p></div>
              <div className={css.tableCard}>
                <table className={css.compare}>
                  <thead>
                    <tr>
                      <th scope="col">{s.feature}</th>
                      {plans.map((p) => (
                        <th key={p.id} scope="col" className={p.id === FEATURED ? css.featuredCol : undefined}>
                          {locale === 'ar' && p.nameAr ? p.nameAr : p.name}
                          <small>{p.price ? `${money(p.price.amountMinor, data.currency, locale)} ${interval === 'month' ? s.perMonth : s.perYear}` : '—'}</small>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <tr className={css.groupRow}><td colSpan={plans.length + 1}>{s.modulesGroup}</td></tr>
                    {MODULE_KEYS.map((m) => (
                      <tr key={m}>
                        <th scope="row" style={{ fontWeight: 600 }}>{modName(m)}</th>
                        {plans.map((p) => {
                          const inPlan = p.modules.includes(m);
                          const add = modPrice(m);
                          return (
                            <td key={p.id} className={p.id === FEATURED ? css.featuredCol : undefined}>
                              {inPlan ? <span className={css.yes}>✓ {s.included}</span>
                                : add ? <span className={css.addonCell}>{fill(s.addon, { price: money(add.amountMinor, data.currency, locale) })}</span>
                                  : <span className={css.no}>{s.notIncluded}</span>}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                    <tr className={css.groupRow}><td colSpan={plans.length + 1}>{s.limitsGroup}</td></tr>
                    {([['branches', s.rowBranches], ['staff', s.rowStaff], ['orders_per_month', s.rowOrders], ['ai_requests_per_month', s.rowAi]] as const).map(([key, label]) => (
                      <tr key={key}>
                        <th scope="row" style={{ fontWeight: 600 }}>{label}</th>
                        {plans.map((p) => (
                          <td key={p.id} className={`num ${p.id === FEATURED ? css.featuredCol : ''}`}>
                            {p.limits[key] === undefined ? s.unlimited : num(p.limits[key]!, locale)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        )}

        {data && <Builder data={data} country={country} interval={interval} fixedPlans={fixedPlans} s={s} modName={modName} />}

        <section className={css.section} id="faq">
          <div className={css.wrap}>
            <div className={css.sectionHead}><h2>{s.faqTitle}</h2></div>
            <div className={css.faq}>
              {([[s.q1, s.a1], [s.q2, s.a2], [s.q3, s.a3], [s.q4, s.a4]] as const).map(([q, a]) => (
                <details key={q}><summary>{q}</summary><p>{a}</p></details>
              ))}
            </div>
          </div>
        </section>
      </main>
      <footer className={`${css.wrap} ${css.footer}`}>© Resuto · {s.billingNote}</footer>
    </div>
  );
}

function Builder({ data, country, interval, fixedPlans, s, modName }: {
  data: PublicPlansResponse; country: Country; interval: Interval; fixedPlans: PublicPlan[];
  s: (typeof PRICING_STRINGS)['en']; modName: (k: ModuleKey) => string;
}) {
  const { locale } = useT();
  const custom = data.plans.find((p) => p.isCustom);
  const [planId, setPlanId] = useState<string>(custom?.id ?? fixedPlans[0]?.id ?? 'free');
  const [addons, setAddons] = useState<ModuleKey[]>(['pay', 'connect']);
  const [quote, setQuote] = useState<PriceQuote | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  const seq = useRef(0);
  const plan = data.plans.find((p) => p.id === planId);

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
  const lineName = (l: PriceQuote['lines'][number]) => {
    if (l.kind === 'plan') { const p = data.plans.find((x) => x.id === l.key); return p ? (locale === 'ar' && p.nameAr ? p.nameAr : p.name) : l.key; }
    return modName(l.key as ModuleKey);
  };

  return (
    <section className={`${css.section} ${css.sectionSand}`} id="build">
      <div className={css.wrap}>
        <div className={css.sectionHead}><h2>{s.buildTitle}</h2><p>{s.buildSub}</p></div>
        <div className={css.builder}>
          <div className={css.panel}>
            <h3 style={{ marginTop: 0 }}>{s.basePlan}</h3>
            <div className={css.selectRow}>
              <div className={css.segmented} role="group" aria-label={s.basePlan} style={{ flexWrap: 'wrap', borderRadius: 18 }}>
                {data.plans.map((p) => (
                  <button key={p.id} type="button" aria-pressed={p.id === planId} onClick={() => setPlanId(p.id)}>
                    {locale === 'ar' && p.nameAr ? p.nameAr : p.name}
                  </button>
                ))}
              </div>
            </div>
            <h3>{s.modulesPick}</h3>
            <div className={css.chips}>
              {data.modules.filter((m) => m.key !== 'core').map((m) => {
                const inPlan = plan?.modules.includes(m.key) ?? false;
                const on = inPlan || addons.includes(m.key);
                return (
                  <button key={m.key} type="button" className={css.chip} aria-pressed={on} disabled={inPlan} onClick={() => toggle(m.key)}>
                    <span className={css.chipBox} aria-hidden>{on ? '✓' : ''}</span>
                    <span><strong>{locale === 'ar' ? m.nameAr : m.name}</strong><span>{locale === 'ar' ? MODULE_DESC_AR[m.key] : m.description}</span></span>
                    <span className={css.chipPrice}>{inPlan ? s.inPlan : m.price ? money(m.price.amountMinor, data.currency, locale) : '—'}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <aside className={`${css.panel} ${css.summary}`} aria-live="polite">
            <h3 style={{ marginTop: 0 }}>{s.total}</h3>
            {state === 'error' && <div className="notice notice-danger">{s.quoteError}</div>}
            {quote && (
              <>
                <div className={css.lines}>
                  {quote.lines.filter((l) => !l.included).map((l) => (
                    <div key={`${l.kind}:${l.key}`} className={css.line}><span>{lineName(l)}</span><span className="num">{money(l.amountMinor, quote.currency, locale)}</span></div>
                  ))}
                </div>
                <div className={css.totalRow} style={{ opacity: state === 'loading' ? 0.55 : 1 }}>
                  <span>{fill(s.perInterval, { interval: interval === 'month' ? s.month : s.year })}</span>
                  <strong>{money(quote.subtotalMinor, quote.currency, locale)}</strong>
                </div>
              </>
            )}
            {!quote && state === 'loading' && <p className="muted">{s.calculating}</p>}
            <Link href="/signup?next=/onboarding" className={css.planCta} style={{ marginTop: 16 }}>{s.getStarted}</Link>
            <div className={css.external}>
              <strong>{s.externalTitle}</strong>
              <p style={{ margin: '6px 0 0' }}>{locale === 'ar' ? data.externalCostsNoteAr : data.externalCostsNote}</p>
            </div>
          </aside>
        </div>
      </div>
    </section>
  );
}
