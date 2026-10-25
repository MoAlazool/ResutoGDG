// Studio AI editing (21-STUDIO, plan §6.4): turns a request in plain words into typed change-set ops. This is Resuto's
// own rules planner — deterministic, no language model, labelled as such (StudioAiPlan.planner = 'resuto_rules') — and
// the path the tests and the sandbox use. It only ever proposes draft edits, dish discounts and offers: it never
// publishes (website.publish is not in its vocabulary) and never invents facts (FAQ answers come from the restaurant's
// own branch data, copy names only the dishes and discount the owner asked for).
import type { ChangeOpRequest, SectionContent, SectionKind } from '@resuto/contracts';
import { invalid } from '../../../common/errors/domain-error';

export interface PlannerProduct { id: string; name: string; nameAr: string | null }
export interface PlannerSection { id: string; kind: string; content: SectionContent }
export interface PlannerBranch {
  name: string; nameAr: string | null; address: string | null; city: string | null; phone: string | null;
  hours: Array<{ day: number; opens: string; closes: string }>;
  acceptsPickup: boolean; acceptsDelivery: boolean; acceptsReservations: boolean;
}
export interface PlannerContext {
  restaurant: { name: string; nameAr: string | null };
  products: PlannerProduct[];
  sections: PlannerSection[];
  branches: PlannerBranch[];
}
export interface PlannerRequest { prompt: string; productIds?: string[]; locale: 'en' | 'ar' }
export interface Bilingual { en: string; ar: string }
export interface EditPlan { title: string; summary: string; ops: ChangeOpRequest[]; notes: Bilingual[] }

const ARABIC_DIGITS = /[٠-٩۰-۹]/g;
/** Arabic-Indic and Persian digits to Western digits (requests typed on an Arabic keyboard). */
export const westernDigits = (s: string) => s.replace(ARABIC_DIGITS, (d) => String((d.charCodeAt(0) & 0xf) % 10));

const OCCASIONS: Array<{ test: RegExp; en: string; ar: string }> = [
  { test: /\beid\b|عيد/i, en: 'Eid', ar: 'العيد' },
  { test: /\bramadan\b|رمضان/i, en: 'Ramadan', ar: 'رمضان' },
  { test: /\biftar\b|إفطار|افطار/i, en: 'Iftar', ar: 'الإفطار' },
  { test: /\bsuhoor\b|سحور/i, en: 'Suhoor', ar: 'السحور' },
  { test: /\bnational day\b|اليوم الوطني/i, en: 'National Day', ar: 'اليوم الوطني' },
  { test: /\bnew year\b|رأس السنة/i, en: 'New Year', ar: 'رأس السنة' },
  { test: /\bvalentine/i, en: "Valentine's", ar: 'عيد الحب' },
  { test: /\bmother'?s day\b|عيد الأم/i, en: "Mother's Day", ar: 'عيد الأم' },
  { test: /\bblack friday\b|الجمعة البيضاء/i, en: 'Black Friday', ar: 'الجمعة البيضاء' },
  { test: /\bsummer\b|الصيف|صيف/i, en: 'Summer', ar: 'الصيف' },
  { test: /\bwinter\b|الشتاء|شتاء/i, en: 'Winter', ar: 'الشتاء' },
  { test: /\bweekend\b|نهاية الأسبوع|الويكند/i, en: 'Weekend', ar: 'نهاية الأسبوع' },
  { test: /\blunch\b|غداء|الغداء/i, en: 'Lunch', ar: 'الغداء' },
];

const KIND_RULES: Array<{ kind: SectionKind; test: RegExp }> = [
  { kind: 'faq', test: /\bfaqs?\b|\bquestions?\b|\bq\s*&\s*a\b|أسئلة|الأسئلة/i },
  { kind: 'social', test: /\bsocial\b|\binstagram\b|\btiktok\b|\bfacebook\b|\bfollow us\b|تابعونا|التواصل الاجتماعي|السوشيال/i },
  { kind: 'menu_full', test: /\b(full|whole|entire|complete)\s+menu\b|القائمة الكاملة|القائمة كاملة|كل القائمة|المنيو كامل/i },
  { kind: 'promo_banner', test: /\bbanner\b|\bannouncement\b|\bribbon\b|بانر|بنر|إعلان|اعلان|شريط/i },
  { kind: 'offers', test: /\boffers?\b|\bdeals?\b|\bdiscounts?\b|\bsale\b|\bspecials?\b|\boff\b|عروض|عرض|خصم|تخفيض|تخفيضات/i },
  { kind: 'menu_highlights', test: /\bhighlights?\b|\bfavourites?\b|\bfavorites?\b|\bbest ?sellers?\b|المميزة|الأكثر طلبًا|المفضلة/i },
];

const PERCENT = /(\d{1,2}(?:[.,]\d{1,2})?)\s*(?:%|٪|percent\b|per cent\b|في المئة|في المائة|بالمئة|بالمائة)/i;
const CODE = /(?:\bcode|\bcoupon|\bpromo code|كود|كوبون|الكود|رمز)\s*[:"'“”«»]?\s*([A-Za-z0-9_-]{3,32})/i;
const RETITLE = /\b(hero|about|gallery|menu highlights|offers|faq|contact|location|hours)\b[^"“”«»]*?\b(?:headline|title|heading)\b[^"“”«»]*?["“«]([^"”»]{1,140})["”»]/i;

const KIND_WORD: Record<string, string> = { 'menu highlights': 'menu_highlights' };
const DAY_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_AR = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

const fmtPct = (bps: number) => String(bps / 100);
const joinEn = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const joinAr = (xs: string[]) => xs.join('، ');

/** Dishes named in the request ("… with the Koshari and the Feteer …"), matched on whole names in either language. */
function namedProducts(prompt: string, products: PlannerProduct[]): string[] {
  const p = prompt.toLowerCase();
  return products.filter((x) => (x.name.length >= 3 && p.includes(x.name.toLowerCase())) || (!!x.nameAr && x.nameAr.length >= 2 && prompt.includes(x.nameAr)))
    .map((x) => x.id);
}

function hoursText(b: PlannerBranch): Bilingual | null {
  if (!b.hours.length) return null;
  const en = b.hours.map((h) => `${DAY_EN[h.day]} ${h.opens}–${h.closes}`).join(', ');
  const ar = b.hours.map((h) => `${DAY_AR[h.day]} ${h.opens}–${h.closes}`).join('، ');
  return { en, ar };
}

/** Questions guests ask, answered only from the restaurant's own published data (no invented facts). */
function faqItems(ctx: PlannerContext) {
  const b = ctx.branches[0];
  const items: NonNullable<SectionContent['items']> = [];
  if (!b) return items;
  const hours = hoursText(b);
  if (hours) items.push({ title: { en: 'When are you open?', ar: 'ما مواعيد العمل؟' }, body: hours });
  const where = [b.address, b.city].filter(Boolean).join(', ');
  if (where) items.push({ title: { en: 'Where are you?', ar: 'أين تقعون؟' }, body: { en: where, ar: where } });
  if (b.acceptsDelivery || b.acceptsPickup) {
    items.push({ title: { en: 'Can I order online?', ar: 'هل يمكنني الطلب أونلاين؟' }, body: b.acceptsDelivery && b.acceptsPickup
      ? { en: 'Yes — order on our website for pickup or delivery.', ar: 'نعم — اطلب من موقعنا للاستلام أو التوصيل.' }
      : b.acceptsDelivery ? { en: 'Yes — order on our website for delivery.', ar: 'نعم — اطلب من موقعنا للتوصيل.' }
        : { en: 'Yes — order on our website and pick it up.', ar: 'نعم — اطلب من موقعنا واستلم طلبك.' } });
  }
  if (b.acceptsReservations) items.push({ title: { en: 'Do you take reservations?', ar: 'هل تقبلون الحجوزات؟' }, body: { en: 'Yes — book a table on our website.', ar: 'نعم — احجز طاولتك من موقعنا.' } });
  if (b.phone) items.push({ title: { en: 'How can I reach you?', ar: 'كيف أتواصل معكم؟' }, body: { en: `Call us on ${b.phone}.`, ar: `اتصل بنا على ${b.phone}.` } });
  return items.slice(0, 12);
}

/** The typed ops for a request, or 422 ai_request_unclear when nothing in it maps to a website change. */
export function planStudioEdit(req: PlannerRequest, ctx: PlannerContext): EditPlan {
  const prompt = westernDigits(req.prompt.normalize('NFC')).trim();
  const notes: Bilingual[] = [];
  const ops: ChangeOpRequest[] = [];
  const byId = new Map(ctx.products.map((p) => [p.id, p]));

  // Retitling an existing section: `Change the hero headline to "…"`.
  const retitle = prompt.match(RETITLE);
  if (retitle) {
    const kind = KIND_WORD[retitle[1]!.toLowerCase()] ?? retitle[1]!.toLowerCase();
    const target = ctx.sections.find((s) => s.kind === kind);
    if (!target) throw invalid('ai_request_unclear', `The website has no ${kind} section to change`, { kind });
    const text = retitle[2]!.trim();
    const headline = { ...(target.content.headline ?? {}), [req.locale]: text };
    ops.push({ type: 'website.section.update', input: { sectionId: target.id, content: { ...target.content, headline } } });
    notes.push({ en: `Change the ${kind} headline (${req.locale === 'ar' ? 'Arabic' : 'English'}) to "${text}"`, ar: `تغيير عنوان قسم ${kind} إلى «${text}»` });
    return { title: `Edit the ${kind} headline`, summary: prompt.slice(0, 1000), ops, notes };
  }

  const percent = prompt.match(PERCENT);
  const bps = percent ? Math.round(Number(percent[1]!.replace(',', '.')) * 100) : null;
  const codeMatch = prompt.match(CODE);
  // "QR code menu" names no offer code: a code has a digit or is written in capitals ("EID15", "SUMMER").
  const code = codeMatch && (/\d/.test(codeMatch[1]!) || codeMatch[1] === codeMatch[1]!.toUpperCase()) ? codeMatch[1]!.toUpperCase() : null;
  const occasion = OCCASIONS.find((o) => o.test.test(prompt)) ?? null;
  const picked = [...new Set([...(req.productIds ?? []), ...namedProducts(prompt, ctx.products)])].slice(0, 12);
  const unknown = picked.filter((id) => !byId.has(id));
  if (unknown.length) throw invalid('unknown_product', 'One or more menu items do not exist', { productIds: unknown });
  const names = picked.map((id) => byId.get(id)!);

  let kind = KIND_RULES.find((r) => r.test.test(prompt))?.kind ?? null;
  if (!kind && bps !== null) kind = 'offers';
  if (!kind && names.length) kind = 'menu_highlights';
  if (!kind) {
    throw invalid('ai_request_unclear', 'Say which section to add — for example "Add an Eid offers section with these 3 dishes at 15% off" or "Add a FAQ section"');
  }

  const content: SectionContent = {};
  const occ = occasion ?? { en: '', ar: '' };
  const enNames = names.map((p) => p.name);
  const arNames = names.map((p) => p.nameAr || p.name);
  if (kind === 'offers' || kind === 'promo_banner') {
    content.headline = occasion ? { en: `${occ.en} offers`, ar: `عروض ${occ.ar}` } : { en: 'Special offers', ar: 'عروض خاصة' };
    if (bps !== null) {
      content.badge = { en: `${fmtPct(bps)}% off`, ar: `خصم ${fmtPct(bps)}%` };
      if (names.length) content.body = { en: `${fmtPct(bps)}% off ${joinEn(enNames)}.`, ar: `خصم ${fmtPct(bps)}% على ${joinAr(arNames)}.` };
      else if (code) content.body = { en: `${fmtPct(bps)}% off your order with the code ${code}.`, ar: `خصم ${fmtPct(bps)}% على طلبك بالكود ${code}.` };
    }
    if (kind === 'offers' && names.length) content.productIds = picked;
    if (kind === 'promo_banner') content.ctaLabel = { en: 'Order now', ar: 'اطلب الآن' };
    if (code) content.promotionCode = code;
  } else if (kind === 'menu_highlights') {
    content.headline = occasion ? { en: `${occ.en} favourites`, ar: `مفضلات ${occ.ar}` } : { en: 'House favourites', ar: 'المفضلات لدينا' };
    if (names.length) content.productIds = picked;
  } else if (kind === 'faq') {
    content.headline = { en: 'Questions and answers', ar: 'أسئلة وأجوبة' };
    content.items = faqItems(ctx);
    if (!content.items.length) notes.push({ en: 'No branch details yet: add opening hours and an address so the questions can be answered.', ar: 'لا توجد بيانات للفرع بعد: أضف مواعيد العمل والعنوان لتتم الإجابة عن الأسئلة.' });
  } else if (kind === 'social') {
    content.headline = { en: 'Follow us', ar: 'تابعونا' };
  } else if (kind === 'menu_full') {
    content.headline = { en: 'Our menu', ar: 'قائمتنا' };
  }

  ops.push({ type: 'website.section.add', input: { kind, content, isVisible: true } });
  notes.push({ en: `Add a ${kind.replace('_', ' ')} section to the draft${content.headline ? ` ("${content.headline.en}")` : ''}`,
    ar: `إضافة قسم ${kind} إلى المسودة${content.headline ? ` («${content.headline.ar}»)` : ''}` });

  if (bps !== null && code) {
    ops.push({ type: 'promotion.create', input: {
      name: (content.headline?.en || `${fmtPct(bps)}% off`).slice(0, 80), nameAr: (content.headline?.ar || null)?.slice(0, 80) ?? null,
      code, kind: 'percent', value: bps, minOrderMinor: 0, isActive: true,
    } as ChangeOpRequest['input'] } as ChangeOpRequest);
    notes.push({ en: `Create the offer code ${code} (${fmtPct(bps)}% off an order)`, ar: `إنشاء كود العرض ${code} (خصم ${fmtPct(bps)}% على الطلب)` });
  } else if (bps !== null && names.length && (kind === 'offers' || kind === 'menu_highlights' || kind === 'promo_banner')) {
    for (const p of names) ops.push({ type: 'product.discount.set', input: { productId: p.id, discountBps: bps } });
    notes.push({ en: `Put ${joinEn(enNames)} at ${fmtPct(bps)}% off (the price guests pay changes once approved)`,
      ar: `خصم ${fmtPct(bps)}% على ${joinAr(arNames)} (يتغير السعر للضيوف بعد الموافقة)` });
  } else if (bps !== null) {
    notes.push({ en: 'No dishes were picked and no offer code was given, so no price changes: pick dishes or name a code.',
      ar: 'لم تُختر أطباق ولم يُذكر كود عرض، لذلك لن تتغير الأسعار: اختر أطباقًا أو اذكر كودًا.' });
  }
  notes.push({ en: 'Nothing is published: approve the change, then publish the website yourself.', ar: 'لن يُنشر شيء: وافق على التغيير ثم انشر الموقع بنفسك.' });

  const title = (content.headline?.en || `Add a ${kind} section`).slice(0, 200);
  return { title, summary: prompt.slice(0, 1000), ops, notes };
}
