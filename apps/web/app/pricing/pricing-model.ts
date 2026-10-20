// /pricing content model: the legacy page's structure and copy (legacy/public/pricing.js, plan-comparison.js and
// landing-pricing.js), filled from the live price list (GET /v1/public/plans). Every price, limit and module cell is
// derived from data; the copy only frames it. Pure functions, unit tested in pricing-model.test.ts.
//
// Copy is written as [English, Arabic] pairs like the legacy 'English|Arabic' strings. Arabic text uses Western
// digits 0-9 (docs/ui/ARABIC_NUMERALS.md); numbers are formatted through @resuto/contracts.
import { formatDate, formatNumber, type ModuleKey, type PublicPlan, type PublicPlansResponse } from '@resuto/contracts';

export type Locale = 'en' | 'ar';
export type Pair = readonly [string, string];
export const pick = (locale: Locale, [en, ar]: Pair) => (locale === 'ar' ? ar : en);

/** Cell kinds, as in legacy landing-pricing.js. */
export type CellKind = 'yes' | 'no' | 'planned' | 'quote' | 'confirm' | 'unknown';
export type Cell = { kind: CellKind } | { kind: 'text'; text: string };
export const WORD: Record<CellKind, Pair> = {
  yes: ['Included', 'متضمَّن'], no: ['Not included', 'غير متضمَّن'], planned: ['Planned', 'مخطط'],
  quote: ['By agreement', 'حسب الاتفاق'], confirm: ['Requires confirmation', 'يحتاج إلى تأكيد'], unknown: ['Not publicly specified', 'غير معلن'],
};
export const MARK: Record<CellKind, string> = { yes: '✓', no: '–', planned: '◷', quote: '↗', confirm: '?', unknown: '·' };

export const BUSINESS_ID = 'business';
export const FEATURED_ID = 'growth';
const FEATURED_FALLBACK_INDEX = 1;

export interface PricingCard {
  id: string;
  name: string;
  /** Monthly / yearly amount in whole currency units; null for Business ("Let’s talk"). */
  monthly: number | null;
  yearly: number | null;
  blurb: string;
  bullets: string[];
  featured: boolean;
}

export interface CompareRow { label: string; detail?: string; cells: Record<string, Cell>; rival: Cell }
export interface CompareGroup { group: string; rows: CompareRow[] }

const major = (minor: number | null | undefined) => (typeof minor === 'number' ? Math.round(minor / 100) : null);
const n = (v: number, locale: Locale) => formatNumber(v, locale);
export const currencyWord = (currency: string, locale: Locale): string =>
  currency === 'SAR' ? pick(locale, ['SAR', 'ريال']) : pick(locale, ['EGP', 'جنيه']);
/** "799 EGP / month" · "799 جنيه / شهريًا" (legacy card unit). */
export const perUnit = (currency: string, yearly: boolean, locale: Locale) =>
  `${currencyWord(currency, locale)} / ${yearly ? pick(locale, ['year', 'سنويًا']) : pick(locale, ['month', 'شهريًا'])}`;
export const amountWithUnit = (amount: number, currency: string, yearly: boolean, locale: Locale) =>
  `${n(amount, locale)} ${perUnit(currency, yearly, locale)}`;

/** Fixed, priced, public plans in sort order: Starter, Growth, Pro (Free QR and Build Your Resuto are shown apart). */
export function pricedPlans(data: PublicPlansResponse): PublicPlan[] {
  return data.plans.filter((p) => !p.isCustom && (p.prices.month?.amountMinor ?? 0) > 0);
}
export const freePlan = (data: PublicPlansResponse) => data.plans.find((p) => !p.isCustom && p.prices.month?.amountMinor === 0) ?? null;
export const customPlan = (data: PublicPlansResponse) => data.plans.find((p) => p.isCustom) ?? null;

/** True while every published yearly price equals ten monthly payments (the legacy "2 months free" promise). */
export function yearlyIsTenMonths(data: PublicPlansResponse): boolean {
  const plans = pricedPlans(data);
  return plans.length > 0 && plans.every((p) => p.prices.year && p.prices.month && p.prices.year.amountMinor === p.prices.month.amountMinor * 10);
}

const planName = (p: PublicPlan) => p.name; // product names stay in Latin script in both languages, as on the legacy page

export const MODULE_BULLET: Record<ModuleKey, Pair> = {
  core: ['QR menu, ordering and the kitchen board', 'قائمة وطلبات QR وشاشة المطبخ'],
  pay: ['Payment links and split bills', 'روابط الدفع وتقسيم الفاتورة'],
  connect: ['WhatsApp ordering and one inbox', 'الطلب عبر واتساب وصندوق رسائل واحد'],
  marketing: ['Customer segments, campaigns and offers', 'شرائح العملاء والحملات والعروض'],
  studio: ['Your restaurant website', 'موقع مطعمك الإلكتروني'],
  intelligence: ['AI forecasts and the owner assistant', 'توقعات ذكية ومساعد المالك'],
  driver: ['Delivery dispatch and the driver app', 'توزيع التوصيل وتطبيق السائق'],
  finance: ['Profitability and accounting exports', 'الربحية وتصدير الحسابات'],
  compliance: ['Tax documents and licence reminders', 'المستندات الضريبية وتذكير التراخيص'],
  mcp: ['Connect AI assistants (MCP)', 'ربط مساعدات الذكاء الاصطناعي (MCP)'],
};
const CORE_BULLETS: Pair[] = [
  ['QR menu & ordering', 'قائمة وطلبات QR'],
  ['Reservations & floor map', 'الحجوزات وخريطة المطعم'],
  ['Kitchen display & inventory', 'شاشة المطبخ والمخزون'],
];
const BUSINESS_BULLETS: Pair[] = [
  ['Negotiated branch limits', 'عدد فروع حسب الاتفاق'],
  ['Dedicated onboarding & migration', 'إعداد ونقل بيانات مخصص'],
  ['Custom connectors & AI configuration', 'تكاملات وإعداد ذكاء اصطناعي مخصص'],
  ['SLA & account manager', 'اتفاقية خدمة ومدير حساب'],
  ['White-label & API access', 'علامة تجارية خاصة وواجهة برمجية'],
  ['Custom analytics & permissions', 'تحليلات وصلاحيات مخصصة'],
  ['Scoped and quoted separately', 'يحدد النطاق والسعر بالاتفاق'],
];

const pluralBranches = (count: number, locale: Locale) => {
  if (locale === 'en') return count === 1 ? '1 branch' : `Up to ${n(count, locale)} branches`;
  if (count === 1) return 'فرع واحد';
  if (count === 2) return 'حتى فرعين';
  return count <= 10 ? `حتى ${n(count, locale)} فروع` : `حتى ${n(count, locale)} فرعًا`;
};
const pluralStaff = (count: number, locale: Locale) => {
  if (locale === 'en') return count === 1 ? '1 staff account' : `${n(count, locale)} staff accounts`;
  if (count === 1) return 'حساب موظف واحد';
  if (count === 2) return 'حسابان للموظفين';
  return count <= 10 ? `${n(count, locale)} حسابات للموظفين` : `${n(count, locale)} حسابًا للموظفين`;
};
export { pluralBranches, pluralStaff };

/** The four legacy cards: the priced plans from data, then Business. */
export function pricingCards(data: PublicPlansResponse, locale: Locale): PricingCard[] {
  const plans = pricedPlans(data);
  const featuredId = plans.some((p) => p.id === FEATURED_ID) ? FEATURED_ID : plans[FEATURED_FALLBACK_INDEX]?.id;
  const cards = plans.map((p, i): PricingCard => {
    const prev = plans[i - 1];
    const fresh = p.modules.filter((m) => m !== 'core' && !(prev?.modules.includes(m)));
    const bullets: string[] = [];
    if (prev) bullets.push(pick(locale, [`Everything in ${planName(prev)}`, `كل مزايا ${planName(prev)}`]));
    if (typeof p.limits.branches === 'number' && p.limits.branches !== prev?.limits.branches) bullets.push(pluralBranches(p.limits.branches, locale));
    if (!prev) bullets.push(...CORE_BULLETS.map((b) => pick(locale, b)));
    bullets.push(...fresh.map((m) => pick(locale, MODULE_BULLET[m])));
    if (typeof p.limits.staff === 'number') bullets.push(pluralStaff(p.limits.staff, locale));
    return {
      id: p.id, name: planName(p), monthly: major(p.prices.month?.amountMinor), yearly: major(p.prices.year?.amountMinor),
      blurb: (locale === 'ar' ? p.descriptionAr : p.description) ?? p.description ?? '', bullets, featured: p.id === featuredId,
    };
  });
  cards.push({
    id: BUSINESS_ID, name: 'Business', monthly: null, yearly: null, featured: false,
    blurb: pick(locale, ['Groups that need custom terms.', 'مجموعات تحتاج شروطًا خاصة.']),
    bullets: BUSINESS_BULLETS.map((b) => pick(locale, b)),
  });
  return cards;
}

/** Add-ons: every module with a published price, from data, plus the quoted services (legacy add-ons row). */
export function addOns(data: PublicPlansResponse, yearly: boolean, locale: Locale): Array<{ name: string; price: string; planned?: boolean }> {
  const items = data.modules
    .filter((m) => m.key !== 'core')
    .map((m) => ({ m, amount: major((yearly ? m.prices.year : m.prices.month)?.amountMinor) }))
    .filter((x): x is { m: (typeof data.modules)[number]; amount: number } => x.amount !== null && x.amount > 0)
    .map(({ m, amount }) => ({ name: locale === 'ar' ? m.nameAr : m.name, price: amountWithUnit(amount, data.currency, yearly, locale) }));
  items.push({ name: pick(locale, ['Premium onboarding and custom integrations', 'إعداد متميز وتكاملات مخصصة']), price: pick(locale, ['Quoted separately', 'بعرض سعر مستقل']) });
  return items;
}

/** The competitor tier on the legacy page (official Foodics Egypt pricing page, checked 2026-10-06). EGP only. */
export const COMPETITOR = {
  name: 'Foodics',
  tier: ['Basic package', 'الباقة الأساسية'] as Pair,
  scope: ['Egypt · EGP · billed annually', 'مصر · بالجنيه المصري · دفع سنوي'] as Pair,
  source: 'https://www.foodics.com/ar/foodics-pricing-egypt/',
  checked: '2026-10-06',
  note: ['Foodics is a full cloud POS. Resuto is not a cashier system: it runs reservations, guest ordering, the kitchen board and bill splitting. The two can sit side by side.',
    'فودكس نظام كاشير سحابي كامل. ريسوتو ليس نظام كاشير: يدير الحجوزات وطلبات الضيوف وشاشة المطبخ وتقسيم الفاتورة، ويمكن أن يعمل النظامان معًا.'] as Pair,
};
const T = (text: string): Cell => ({ kind: 'text', text });
const K = (kind: CellKind): Cell => ({ kind });
/** Competitor facts per row, verbatim from the legacy comparison where a row maps to one; otherwise "not specified". */
const RIVAL: Partial<Record<ModuleKey | 'monthly' | 'yearly' | 'trial' | 'hardware', Pair | CellKind>> = {
  core: ['Cloud POS, menu and table management', 'نظام كاشير سحابي وإدارة القائمة والطاولات'],
  pay: ['Foodics Pay, a separate product', 'Foodics Pay، منتج منفصل'],
  marketing: ['Loyalty, gift cards, coupons and promotions', 'الولاء وبطاقات الهدايا والكوبونات والعروض'],
  finance: ['BI reports; advanced BI is in the Advanced package', 'تقارير ذكاء الأعمال؛ المتقدمة في الباقة المطورة'],
  monthly: ['EGP 3,019.89 / month, billed quarterly', '3,019.89 جنيه شهريًا بدفع ربع سنوي'],
  yearly: ['EGP 2,848.95 / month, billed annually', '2,848.95 جنيه شهريًا بدفع سنوي'],
  trial: ['Demo on request', 'عرض تجريبي عند الطلب'],
  hardware: ['Quoted with the equipment you need', 'تُسعَّر حسب التجهيزات المطلوبة'],
};
const rivalCell = (key: keyof typeof RIVAL, locale: Locale): Cell => {
  const v = RIVAL[key];
  return !v ? K('unknown') : typeof v === 'string' ? K(v) : T(pick(locale, v));
};

const MODULE_GROUPS: Array<{ group: Pair; modules: ModuleKey[] }> = [
  { group: ['Restaurant operations', 'تشغيل المطعم'], modules: ['core'] },
  { group: ['Guest payments', 'مدفوعات الضيوف'], modules: ['pay'] },
  { group: ['Customers and marketing', 'العملاء والتسويق'], modules: ['connect', 'marketing'] },
  { group: ['Website and delivery', 'الموقع والتوصيل'], modules: ['studio', 'driver'] },
  { group: ['Back office', 'الإدارة والحسابات'], modules: ['finance', 'compliance'] },
  { group: ['AI', 'الذكاء الاصطناعي'], modules: ['intelligence', 'mcp'] },
];
const MODULE_DETAIL_AR: Record<ModuleKey, string> = {
  core: 'القائمة وطلب QR والحجوزات والصالة والمطبخ والمخزون والموظفون.',
  connect: 'الطلب عبر واتساب وصندوق رسائل موحّد ومراسلة العملاء.',
  pay: 'روابط الدفع والدفع عبر QR وتقسيم الفاتورة والعرابين والمطابقة.',
  marketing: 'شرائح العملاء والحملات والعروض وقياس النتائج وتقارير الإعلانات.',
  driver: 'توزيع طلبات التوصيل وتطبيق السائق على الويب.',
  studio: 'موقع المطعم والنطاقات الخاصة والمحتوى بالذكاء الاصطناعي.',
  finance: 'الإيرادات والمصروفات والربحية وتصدير الحسابات.',
  compliance: 'الملفات الضريبية والمستندات الضريبية الإلكترونية والتراخيص وتذكيرات انتهائها.',
  intelligence: 'التنبؤ والتقسيم والتوصيات ومساعد المالك.',
  mcp: 'اتصال آمن لعملاء الذكاء الاصطناعي الخارجيين (Claude وChatGPT).',
};
export const moduleDetail = (m: PublicPlansResponse['modules'][number], locale: Locale) => (locale === 'ar' ? MODULE_DETAIL_AR[m.key] : m.description);

/**
 * The comparison table: legacy layout (groups, legend values, Business "by agreement", the Foodics column) with one
 * row per Resuto module and per plan limit. Cells come from plan_modules, plan limits and module prices.
 */
export function comparison(data: PublicPlansResponse, yearly: boolean, locale: Locale): CompareGroup[] {
  const plans = pricedPlans(data);
  const cells = (f: (p: PublicPlan) => Cell, business: Cell): Record<string, Cell> =>
    ({ ...Object.fromEntries(plans.map((p) => [p.id, f(p)])), [BUSINESS_ID]: business });
  const groups: CompareGroup[] = MODULE_GROUPS.map(({ group, modules }) => ({
    group: pick(locale, group),
    rows: modules.map((key) => {
      const mod = data.modules.find((m) => m.key === key);
      const addOn = major((yearly ? mod?.prices.year : mod?.prices.month)?.amountMinor);
      return {
        label: mod ? (locale === 'ar' ? mod.nameAr : mod.name) : key,
        detail: mod ? moduleDetail(mod, locale) : undefined,
        cells: cells((p) => (p.modules.includes(key) ? K('yes')
          : addOn ? T(`${pick(locale, ['Add-on', 'إضافة'])} · ${amountWithUnit(addOn, data.currency, yearly, locale)}`) : K('no')), K('quote')),
        rival: rivalCell(key, locale),
      };
    }),
  }));
  const limit = (key: string, fmt: (v: number) => Cell): Cell[] => plans.map((p) => (typeof p.limits[key] === 'number' ? fmt(p.limits[key]!) : K('confirm')));
  const row = (label: Pair, values: Cell[], business: Cell, rival: Cell): CompareRow =>
    ({ label: pick(locale, label), cells: { ...Object.fromEntries(plans.map((p, i) => [p.id, values[i]!])), [BUSINESS_ID]: business }, rival });
  groups.push({
    group: pick(locale, ['Team and branches', 'الفريق والفروع']),
    rows: [
      row(['Branches', 'الفروع'], limit('branches', (v) => T(v > 1 ? pick(locale, [`Up to ${n(v, locale)}`, `حتى ${n(v, locale)}`]) : n(v, locale))), T(pick(locale, ['Negotiated', 'حسب الاتفاق'])), K('unknown')),
      row(['Staff accounts', 'حسابات الموظفين'], limit('staff', (v) => T(n(v, locale))), K('quote'), K('unknown')),
      row(['Orders per month', 'الطلبات شهريًا'], limit('orders_per_month', (v) => T(n(v, locale))), K('quote'), K('unknown')),
      row(['AI requests per month', 'طلبات الذكاء الاصطناعي شهريًا'], limit('ai_requests_per_month', (v) => (v > 0 ? T(n(v, locale)) : K('no'))), K('quote'), K('unknown')),
    ],
  });
  const ten = yearlyIsTenMonths(data);
  const rivalIfEgp = (key: keyof typeof RIVAL) => (data.currency === 'EGP' ? rivalCell(key, locale) : K('unknown'));
  groups.push({
    group: pick(locale, ['Commercial terms', 'الشروط التجارية']),
    rows: [
      row(['Monthly price', 'السعر الشهري'], plans.map((p) => { const a = major(p.prices.month?.amountMinor); return a === null ? K('confirm') : T(amountWithUnit(a, data.currency, false, locale)); }),
        T(pick(locale, ['Custom', 'حسب الاتفاق'])), rivalIfEgp('monthly')),
      row(['Yearly billing', 'الدفع السنوي'], plans.map((p) => {
        const a = major(p.prices.year?.amountMinor);
        if (a === null) return K('confirm');
        return T(`${amountWithUnit(a, data.currency, true, locale)}${ten ? pick(locale, [' (10 months)', ' (10 أشهر)']) : ''}`);
      }), T(pick(locale, ['Custom', 'حسب الاتفاق'])), rivalIfEgp('yearly')),
      row(['Free trial', 'تجربة مجانية'], plans.map(() => T(pick(locale, ['14 days, no card', '14 يومًا بدون بطاقة']))), K('quote'), rivalIfEgp('trial')),
      row(['Hardware', 'الأجهزة'], plans.map(() => T(pick(locale, ['None required: runs in a browser', 'غير مطلوبة: يعمل في المتصفح']))),
        T(pick(locale, ['None required: runs in a browser', 'غير مطلوبة: يعمل في المتصفح'])), rivalIfEgp('hardware')),
    ],
  });
  return groups;
}

export const competitorChecked = (locale: Locale) => formatDate(`${COMPETITOR.checked}T00:00:00Z`, locale, 'UTC', 'long');

/** Common questions (legacy FAQ, kept true to Resuto 2.0; prices from data). Also published as FAQ structured data. */
export function faq(data: PublicPlansResponse, locale: Locale): Array<[string, string]> {
  const plans = pricedPlans(data);
  const unit = currencyWord(data.currency, locale);
  const list = plans.map((p) => `${p.name} ${pick(locale, ['is', 'بسعر'])} ${n(major(p.prices.month?.amountMinor) ?? 0, locale)} ${unit}`);
  const priceSentence = locale === 'ar'
    ? `${list.join('، و')} شهريًا.${yearlyIsTenMonths(data) ? ' الدفع السنوي يساوي عشرة أشهر بدل اثني عشر.' : ''} وخطة Business بسعر حسب الاتفاق.`
    : `${list.slice(0, -1).join(', ')}${list.length > 1 ? ' and ' : ''}${list.at(-1) ?? ''} a month.${yearlyIsTenMonths(data) ? ' Paying yearly costs ten months instead of twelve.' : ''} Business is priced by agreement.`;
  const free = freePlan(data);
  const qa: Array<[Pair, Pair] | null> = [
    [['How much does Resuto cost?', 'كم سعر ريسوتو؟'], [priceSentence, priceSentence]],
    [['Is there a free trial?', 'هل توجد تجربة مجانية؟'], ['Yes. Every priced plan starts with a 14-day trial and you do not need a card to create the workspace.', 'نعم. كل خطة مسعّرة تبدأ بتجربة 14 يومًا، ولا تحتاج بطاقة لإنشاء مساحة العمل.']],
    free ? [['Is there a free plan?', 'هل توجد خطة مجانية؟'], [`Yes. ${free.name} covers a digital menu and QR table ordering for one branch, with a monthly order limit. Upgrade any time.`, `نعم. خطة ${free.name} تشمل قائمة رقمية وطلب الطاولات عبر QR لفرع واحد مع حد شهري للطلبات. يمكنك الترقية في أي وقت.`]] : null,
    [['Will I be charged when the trial ends?', 'هل سيُخصم مني عند انتهاء التجربة؟'], ['Not automatically. Online card payment for Resuto subscriptions is not available yet: after the trial, paid plans are invoiced by Resuto.', 'ليس تلقائيًا. الدفع الإلكتروني لاشتراكات ريسوتو غير متاح بعد: بعد التجربة تصدر ريسوتو فاتورة الخطة المدفوعة.']],
    [['Can I change plans later?', 'هل يمكنني تغيير الخطة لاحقًا؟'], ['Upgrades apply immediately. Downgrades take effect at the end of your billing period, and only if your branches and staff fit the smaller plan.', 'الترقية تُطبّق فورًا. التخفيض يسري في نهاية فترة الفوترة، وبشرط أن تناسب فروعك وموظفوك الخطة الأصغر.']],
    [['Which payment methods can guests use?', 'ما طرق الدفع المتاحة للضيوف؟'], ['Guests pay by card through your own Paymob, Stripe or Moyasar account once you connect it. Their processing fees are charged by them and are not part of the Resuto subscription.', 'يدفع الضيوف بالبطاقة عبر حسابك في Paymob أو Stripe أو Moyasar بعد ربطه. رسوم المعالجة يحصّلها المزوّد وليست جزءًا من اشتراك ريسوتو.']],
    [['Who charges the payment and WhatsApp fees?', 'من يحصّل رسوم الدفع وواتساب؟'], ['Your payment provider, Meta for WhatsApp conversations, and ad platforms bill you directly from your own accounts. Resuto never marks those up.', 'مزوّد الدفع، وميتا لمحادثات واتساب، ومنصات الإعلانات يحاسبونك مباشرة من حساباتك. ريسوتو لا تضيف عليها أي هامش.']],
    [['Do you hold my customers’ money?', 'هل تحتفظ ريسوتو بأموال عملائي؟'], ['No. Each restaurant connects its own payment provider account; Resuto records payments and reconciles them.', 'لا. يربط كل مطعم حساب مزوّد الدفع الخاص به، وتسجّل ريسوتو المدفوعات وتطابقها.']],
    [['Do I need any hardware?', 'هل أحتاج إلى أجهزة؟'], ['No. Resuto runs in a browser on the phones, tablets and screens you already have, and guests order from their own phones.', 'لا. ريسوتو يعمل في المتصفح على الهواتف والأجهزة اللوحية والشاشات المتوفرة لديك، والضيوف يطلبون من هواتفهم.']],
    [['Does it work in Arabic?', 'هل يعمل بالعربية؟'], ['Yes. Every screen works in Arabic and English, for guests and for staff, including right-to-left layout.', 'نعم. كل الشاشات تعمل بالعربية والإنجليزية للضيوف والموظفين، مع دعم الاتجاه من اليمين إلى اليسار.']],
  ];
  return qa.filter((x): x is [Pair, Pair] => !!x).map(([q, a]) => [pick(locale, q), pick(locale, a)]);
}

/** Cheapest published monthly price, for the page title ("plans from 799 EGP a month"). */
export function fromPrice(data: PublicPlansResponse): number | null {
  const amounts = pricedPlans(data).map((p) => major(p.prices.month?.amountMinor)).filter((x): x is number => x !== null);
  return amounts.length ? Math.min(...amounts) : null;
}
