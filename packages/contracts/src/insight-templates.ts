/**
 * Insight templates (FT-15 / DF-15). The API stores `templateKey` + `params` with each insight and the English text
 * as a fallback; every reader (staff UI, MCP) renders title, body and evidence in its own language from here.
 * Numbers, money and dates go through the shared Western-digit formatters; names and other user text are wrapped in
 * Unicode isolates (FSI…PDI) so a Latin product name keeps its direction inside an Arabic sentence.
 */
import { formatDate, formatNumber, type DisplayLocale } from './locale-format';
import { formatMoney, type Currency } from './money';

/** A name in both languages (`ar` falls back to `en`). */
export interface LocalName { en: string; ar?: string | null }

export const INSIGHT_TEMPLATE_KEYS = [
  'revenue_drop', 'item_spike', 'item_drop', 'stock_sold_out', 'stock_cover_low', 'low_stock', 'slow_kitchen',
  'inactive_valuable', 'demand_rise', 'demand_fall', 'churn_high',
] as const;
export type InsightTemplateKey = (typeof INSIGHT_TEMPLATE_KEYS)[number];

export interface RenderedInsight { title: string; body: string; evidence: Array<{ label: string; value: string }> }

const FSI = '⁨';
const PDI = '⁩';
const iso = (s: string) => `${FSI}${s}${PDI}`;
const nameOf = (n: LocalName | string | null | undefined, l: DisplayLocale) =>
  iso(typeof n === 'string' ? n : !n ? '—' : l === 'ar' ? n.ar || n.en : n.en);
const num = (n: unknown, l: DisplayLocale, digits = 1) => formatNumber(typeof n === 'number' ? n : Number(n), l, { maximumFractionDigits: digits });
const pct = (n: unknown, l: DisplayLocale) => `${num(n, l)}%`;
const money = (minor: unknown, currency: unknown, l: DisplayLocale) => formatMoney(Number(minor ?? 0), (currency as Currency) ?? 'EGP', l);
const day = (d: unknown, l: DisplayLocale) => (typeof d === 'string' ? formatDate(`${d.slice(0, 10)}T12:00:00Z`, l, 'UTC') : '—');

const UNITS: Record<string, { en: string; ar: string }> = {
  g: { en: 'g', ar: 'جم' }, kg: { en: 'kg', ar: 'كجم' }, ml: { en: 'ml', ar: 'مل' }, l: { en: 'l', ar: 'لتر' }, pcs: { en: 'pcs', ar: 'قطعة' },
};
const unit = (u: unknown, l: DisplayLocale) => (typeof u === 'string' ? UNITS[u]?.[l] ?? u : '');
const qtyUnit = (q: unknown, u: unknown, l: DisplayLocale) => `${num(q, l, 3)} ${unit(u, l)}`.trim();

const MODELS: Record<string, { en: string; ar: string }> = {
  seasonal_naive_7: { en: 'same weekday last week', ar: 'نفس يوم الأسبوع الماضي' },
  moving_average_28: { en: '28-day average', ar: 'متوسط 28 يومًا' },
  hist_gbm: { en: 'gradient boosting', ar: 'التعزيز التدرجي' },
};
const model = (m: unknown, l: DisplayLocale) => (typeof m === 'string' ? MODELS[m]?.[l] ?? m : '—');

type P = Record<string, any>;
type Def = { [L in DisplayLocale]: { title: (p: P) => string; body: (p: P) => string } } & {
  evidence: (p: P, l: DisplayLocale) => Array<[en: string, ar: string, value: string]>;
};

const T: Record<InsightTemplateKey, Def> = {
  revenue_drop: {
    en: {
      title: (p) => `Revenue down ${pct(p.dropPct, 'en')} at ${nameOf(p.branch, 'en')}`,
      body: (p) => `Revenue on ${day(p.date, 'en')} was ${money(p.revenueMinor, p.currency, 'en')} against an average of ${money(p.baselineMinor, p.currency, 'en')} on the same weekday over the previous ${num(p.weeks, 'en', 0)} weeks.`,
    },
    ar: {
      title: (p) => `انخفض الإيراد ${pct(p.dropPct, 'ar')} في ${nameOf(p.branch, 'ar')}`,
      body: (p) => `بلغ الإيراد يوم ${day(p.date, 'ar')} ${money(p.revenueMinor, p.currency, 'ar')} مقابل متوسط ${money(p.baselineMinor, p.currency, 'ar')} في نفس يوم الأسبوع خلال آخر ${num(p.weeks, 'ar', 0)} أسابيع.`,
    },
    evidence: (p, l) => [
      ['Day', 'اليوم', day(p.date, l)],
      ['Revenue', 'الإيراد', money(p.revenueMinor, p.currency, l)],
      ['Same-weekday average', 'متوسط نفس اليوم', money(p.baselineMinor, p.currency, l)],
      ['Drop', 'الانخفاض', pct(p.dropPct, l)],
      ['Orders that day', 'طلبات ذلك اليوم', num(p.orders, l, 0)],
    ],
  },
  item_spike: {
    en: {
      title: (p) => `${nameOf(p.product, 'en')} sold far above normal`,
      body: (p) => `${nameOf(p.product, 'en')} sold ${num(p.quantity, 'en', 0)} on ${day(p.date, 'en')}; the previous ${num(p.windowDays, 'en', 0)}-day average was ${num(p.mean, 'en')} per day.`,
    },
    ar: {
      title: (p) => `مبيعات ${nameOf(p.product, 'ar')} أعلى بكثير من المعتاد`,
      body: (p) => `بيع من ${nameOf(p.product, 'ar')} ${num(p.quantity, 'ar', 0)} يوم ${day(p.date, 'ar')}، بينما كان المتوسط في آخر ${num(p.windowDays, 'ar', 0)} يومًا ${num(p.mean, 'ar')} في اليوم.`,
    },
    evidence: (p, l) => [
      ['Day', 'اليوم', day(p.date, l)], ['Sold', 'المباع', num(p.quantity, l, 0)],
      ['Daily average', 'المتوسط اليومي', num(p.mean, l)], ['Deviation (z-score)', 'الانحراف (z)', num(p.z, l)],
    ],
  },
  item_drop: {
    en: {
      title: (p) => `${nameOf(p.product, 'en')} sold far below normal`,
      body: (p) => `${nameOf(p.product, 'en')} sold ${num(p.quantity, 'en', 0)} on ${day(p.date, 'en')}; the previous ${num(p.windowDays, 'en', 0)}-day average was ${num(p.mean, 'en')} per day.`,
    },
    ar: {
      title: (p) => `مبيعات ${nameOf(p.product, 'ar')} أقل بكثير من المعتاد`,
      body: (p) => `بيع من ${nameOf(p.product, 'ar')} ${num(p.quantity, 'ar', 0)} يوم ${day(p.date, 'ar')}، بينما كان المتوسط في آخر ${num(p.windowDays, 'ar', 0)} يومًا ${num(p.mean, 'ar')} في اليوم.`,
    },
    evidence: (p, l) => [
      ['Day', 'اليوم', day(p.date, l)], ['Sold', 'المباع', num(p.quantity, l, 0)],
      ['Daily average', 'المتوسط اليومي', num(p.mean, l)], ['Deviation (z-score)', 'الانحراف (z)', num(p.z, l)],
    ],
  },
  stock_sold_out: {
    en: {
      title: (p) => `${nameOf(p.product, 'en')} is sold out`,
      body: (p) => `None left at ${nameOf(p.branch, 'en')}; it sold ${num(p.averageDailySales, 'en')} per day on average over the last ${num(p.windowDays, 'en', 0)} days.`,
    },
    ar: {
      title: (p) => `نفد ${nameOf(p.product, 'ar')}`,
      body: (p) => `لم يتبقَّ شيء في ${nameOf(p.branch, 'ar')}؛ متوسط مبيعاته ${num(p.averageDailySales, 'ar')} في اليوم خلال آخر ${num(p.windowDays, 'ar', 0)} يومًا.`,
    },
    evidence: (p, l) => [
      ['In stock', 'المتوفر', num(p.stock, l, 0)], ['Average daily sales', 'متوسط المبيعات اليومية', num(p.averageDailySales, l)],
    ],
  },
  stock_cover_low: {
    en: {
      title: (p) => `${nameOf(p.product, 'en')} may sell out within ${num(p.coverDays, 'en')} days`,
      body: (p) => `${num(p.stock, 'en', 0)} left at ${nameOf(p.branch, 'en')}; it sold ${num(p.averageDailySales, 'en')} per day on average over the last ${num(p.windowDays, 'en', 0)} days.`,
    },
    ar: {
      title: (p) => `قد ينفد ${nameOf(p.product, 'ar')} خلال ${num(p.coverDays, 'ar')} يوم`,
      body: (p) => `تبقّى ${num(p.stock, 'ar', 0)} في ${nameOf(p.branch, 'ar')}؛ متوسط مبيعاته ${num(p.averageDailySales, 'ar')} في اليوم خلال آخر ${num(p.windowDays, 'ar', 0)} يومًا.`,
    },
    evidence: (p, l) => [
      ['In stock', 'المتوفر', num(p.stock, l, 0)], ['Average daily sales', 'متوسط المبيعات اليومية', num(p.averageDailySales, l)],
      ['Days of cover', 'أيام التغطية', num(p.coverDays, l)],
    ],
  },
  low_stock: {
    en: {
      title: (p) => `${nameOf(p.item, 'en')} is below its reorder level`,
      body: (p) => `${qtyUnit(p.quantity, p.unit, 'en')} in stock at ${nameOf(p.branch, 'en')}; reorder level ${qtyUnit(p.reorderLevel, p.unit, 'en')}.`,
    },
    ar: {
      title: (p) => `${nameOf(p.item, 'ar')} أقل من حد إعادة الطلب`,
      body: (p) => `المتوفر ${qtyUnit(p.quantity, p.unit, 'ar')} في ${nameOf(p.branch, 'ar')}؛ حد إعادة الطلب ${qtyUnit(p.reorderLevel, p.unit, 'ar')}.`,
    },
    evidence: (p, l) => [
      ['In stock', 'المتوفر', qtyUnit(p.quantity, p.unit, l)], ['Reorder level', 'حد إعادة الطلب', qtyUnit(p.reorderLevel, p.unit, l)],
    ],
  },
  slow_kitchen: {
    en: {
      title: (p) => `Kitchen ${pct(p.slowerPct, 'en')} slower at ${nameOf(p.branch, 'en')}`,
      body: (p) => `Median time from order to ready on ${day(p.date, 'en')} was ${num(p.medianMinutes, 'en')} min (${num(p.orders, 'en', 0)} orders) vs ${num(p.baselineMedianMinutes, 'en')} min over the previous ${num(p.baselineDays, 'en', 0)} days.`,
    },
    ar: {
      title: (p) => `المطبخ أبطأ بنسبة ${pct(p.slowerPct, 'ar')} في ${nameOf(p.branch, 'ar')}`,
      body: (p) => `كان الوسيط من الطلب حتى الجاهزية يوم ${day(p.date, 'ar')} ${num(p.medianMinutes, 'ar')} دقيقة (${num(p.orders, 'ar', 0)} طلبات) مقابل ${num(p.baselineMedianMinutes, 'ar')} دقيقة خلال آخر ${num(p.baselineDays, 'ar', 0)} يومًا.`,
    },
    evidence: (p, l) => [
      ['Day', 'اليوم', day(p.date, l)], ['Median minutes', 'الوسيط بالدقائق', num(p.medianMinutes, l)],
      ['Baseline median minutes', 'الوسيط المرجعي بالدقائق', num(p.baselineMedianMinutes, l)], ['Orders', 'الطلبات', num(p.orders, l, 0)],
    ],
  },
  inactive_valuable: {
    en: {
      title: (p) => `${num(p.customers, 'en', 0)} valuable customers have gone quiet`,
      body: (p) => `${num(p.customers, 'en', 0)} customers in your top ${num(p.topSharePct, 'en', 0)}% by spend (${money(p.spendMinor, p.currency, 'en')} in the last year) are overdue by more than twice their usual gap. Consider a win-back message.`,
    },
    ar: {
      title: (p) => `${num(p.customers, 'ar', 0)} من العملاء المميزين توقفوا عن الطلب`,
      body: (p) => `${num(p.customers, 'ar', 0)} من أعلى ${num(p.topSharePct, 'ar', 0)}% إنفاقًا (${money(p.spendMinor, p.currency, 'ar')} خلال آخر سنة) تأخروا أكثر من ضعف المدة المعتادة بين طلباتهم. فكّر في رسالة لاستعادتهم.`,
    },
    evidence: (p, l) => [
      ['Customers', 'العملاء', num(p.customers, l, 0)], ['Spend in the last year', 'الإنفاق خلال آخر سنة', money(p.spendMinor, p.currency, l)],
    ],
  },
  demand_rise: {
    en: {
      title: (p) => `Demand for ${nameOf(p.product, 'en')} expected to rise ${pct(p.changePct, 'en')}`,
      body: (p) => `Forecast for the next 7 days is ${num(p.next7, 'en')} units (${model(p.model, 'en')}) vs ${num(p.last7, 'en', 0)} sold in the last 7 days at ${nameOf(p.branch, 'en')}.`,
    },
    ar: {
      title: (p) => `يُتوقع ارتفاع الطلب على ${nameOf(p.product, 'ar')} بنسبة ${pct(p.changePct, 'ar')}`,
      body: (p) => `التوقع للأيام السبعة القادمة ${num(p.next7, 'ar')} وحدة (${model(p.model, 'ar')}) مقابل ${num(p.last7, 'ar', 0)} بيعت في آخر 7 أيام في ${nameOf(p.branch, 'ar')}.`,
    },
    evidence: (p, l) => [
      ['Next 7 days (forecast)', 'الأيام السبعة القادمة (توقع)', num(p.next7, l)], ['Last 7 days (sold)', 'آخر 7 أيام (مباع)', num(p.last7, l, 0)],
      ['Model', 'النموذج', model(p.model, l)],
    ],
  },
  demand_fall: {
    en: {
      title: (p) => `Demand for ${nameOf(p.product, 'en')} expected to fall ${pct(p.changePct, 'en')}`,
      body: (p) => `Forecast for the next 7 days is ${num(p.next7, 'en')} units (${model(p.model, 'en')}) vs ${num(p.last7, 'en', 0)} sold in the last 7 days at ${nameOf(p.branch, 'en')}.`,
    },
    ar: {
      title: (p) => `يُتوقع انخفاض الطلب على ${nameOf(p.product, 'ar')} بنسبة ${pct(p.changePct, 'ar')}`,
      body: (p) => `التوقع للأيام السبعة القادمة ${num(p.next7, 'ar')} وحدة (${model(p.model, 'ar')}) مقابل ${num(p.last7, 'ar', 0)} بيعت في آخر 7 أيام في ${nameOf(p.branch, 'ar')}.`,
    },
    evidence: (p, l) => [
      ['Next 7 days (forecast)', 'الأيام السبعة القادمة (توقع)', num(p.next7, l)], ['Last 7 days (sold)', 'آخر 7 أيام (مباع)', num(p.last7, l, 0)],
      ['Model', 'النموذج', model(p.model, l)],
    ],
  },
  churn_high: {
    en: {
      title: (p) => `${num(p.customers, 'en', 0)} customers at high churn risk`,
      body: (p) => `${num(p.customers, 'en', 0)} customers have a churn risk of 70% or more for the next ${num(p.windowDays, 'en', 0)} days (${p.isHeuristic ? 'recency rules' : 'logistic regression'}).`,
    },
    ar: {
      title: (p) => `${num(p.customers, 'ar', 0)} عملاء معرضون بشدة لخطر الانقطاع`,
      body: (p) => `لدى ${num(p.customers, 'ar', 0)} عملاء احتمال انقطاع 70% أو أكثر خلال الـ ${num(p.windowDays, 'ar', 0)} يومًا القادمة (${p.isHeuristic ? 'قواعد آخر طلب' : 'الانحدار اللوجستي'}).`,
    },
    evidence: (p, l) => [
      ['Customers', 'العملاء', num(p.customers, l, 0)],
      ['Method', 'الطريقة', p.isHeuristic ? (l === 'ar' ? 'قواعد آخر طلب' : 'recency rules') : (l === 'ar' ? 'الانحدار اللوجستي' : 'logistic regression')],
    ],
  },
};

export const isInsightTemplateKey = (k: unknown): k is InsightTemplateKey => typeof k === 'string' && (INSIGHT_TEMPLATE_KEYS as readonly string[]).includes(k);

/** Renders an insight in `locale`; returns null for an unknown key (callers then show the stored fallback text). */
export function renderInsight(key: string | null | undefined, params: Record<string, unknown> | null | undefined, locale: DisplayLocale): RenderedInsight | null {
  if (!isInsightTemplateKey(key)) return null;
  const def = T[key];
  const p = params ?? {};
  const l: DisplayLocale = locale === 'ar' ? 'ar' : 'en';
  return {
    title: def[l].title(p),
    body: def[l].body(p),
    evidence: def.evidence(p, l).map(([en, ar, value]) => ({ label: l === 'ar' ? ar : en, value })),
  };
}

/** Strips the Unicode isolates (for plain-text consumers that do their own bidi handling, e.g. logs and tests). */
export const stripIsolates = (s: string) => s.replace(/[⁦-⁩]/g, '');
