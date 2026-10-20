import {
  toWesternDigits, type AssistantReason, type AssistantRequest, type AssistantResult, type PublicMenu, type PublicMenuProduct, type SuggestionsResult,
} from '@resuto/contracts';

/**
 * "Help me choose" and cart suggestions (legacy /api/recommend and /api/suggest; audit VP-20, FT-20).
 *
 * Deterministic rules over the live menu: what the guest asked for (party, budget, vegetarian, not spicy, quick,
 * allergens to avoid, in English or Arabic), the courses the categories describe, and how often this branch's guests
 * ordered each dish. No generative model is called, nothing is metered, and only real, available menu items are ever
 * proposed; the guest still reviews and confirms the cart. Allergens are as the restaurant listed them.
 */
export type Course = 'starter' | 'main' | 'side' | 'dessert' | 'drink';

export interface Candidate {
  product: PublicMenuProduct;
  course: Course;
  /** Units ordered at this branch recently (0 when unknown). */
  popularity: number;
  /** Unit price including the cheapest choice of every required option group. */
  unitMinor: number;
  /** The option picked for each required group (so the cart line is valid without opening the dish sheet). */
  modifiers: Array<{ groupId: string; optionId: string }>;
}

const has = (re: RegExp, ...texts: Array<string | null | undefined>) => texts.some((t) => !!t && re.test(t.toLowerCase()));

const DRINK = /drink|beverage|juice|soda|cola|water|coffee|espresso|latte|tea\b|lemonade|cooler|smoothie|shake|mocktail|cocktail|\bbar\b|مشروب|عصير|مياه|قهوة|شاي|ليموناد|كركديه|سموذي|ميلك ?شيك/;
const DESSERT = /dessert|sweet|pastry|cake|fondant|ice cream|pudding|حلو|حلويات|كيك|جاتوه|آيس ?كريم|ايس ?كريم|بودنج|فوندان/;
const STARTER = /starter|appeti[sz]er|mezze|meze|soup|small plate|مقبلات|شوربة|شوربه|مزة|مازة/;
const SIDE = /\bside|fries|extras?\b|add-?ons?|bread|rice\b|جانبي|إضافات|اضافات|بطاطس|خبز/;

/** The course a dish belongs to, from its category (then its own name for drinks and sides in a catch-all category). */
export function courseOf(category: { name: string; nameAr: string | null }, p: { name: string; nameAr: string | null }): Course {
  if (has(DRINK, category.name, category.nameAr)) return 'drink';
  if (has(DESSERT, category.name, category.nameAr)) return 'dessert';
  if (has(STARTER, category.name, category.nameAr)) return 'starter';
  if (has(SIDE, category.name, category.nameAr)) return 'side';
  if (has(DRINK, p.name, p.nameAr)) return 'drink';
  if (has(DESSERT, p.name, p.nameAr)) return 'dessert';
  if (has(SIDE, p.name, p.nameAr)) return 'side';
  return 'main';
}

/** Products a guest can add right now, with the cheapest valid choice for each required option group. */
export function candidates(menu: PublicMenu, popularity: Map<string, number>): Candidate[] {
  const out: Candidate[] = [];
  for (const c of menu.categories) {
    for (const p of c.products) {
      if (!p.available) continue;
      let unit = p.priceMinor;
      const modifiers: Candidate['modifiers'] = [];
      let ok = true;
      for (const g of p.modifierGroups) {
        if (g.minSelect <= 0) continue;
        const opts = g.options.filter((o) => o.available).sort((a, b) => a.priceDeltaMinor - b.priceDeltaMinor || a.name.localeCompare(b.name));
        if (opts.length < g.minSelect) { ok = false; break; }
        for (const o of opts.slice(0, g.minSelect)) { unit += o.priceDeltaMinor; modifiers.push({ groupId: g.id, optionId: o.id }); }
      }
      if (ok) out.push({ product: p, course: courseOf(c, p), popularity: popularity.get(p.id) ?? 0, unitMinor: unit, modifiers });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Reading the request (English and Arabic, Arabic-Indic digits, Arabic number words)
// ---------------------------------------------------------------------------------------------------------------
const WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, couple: 2,
  'واحد': 1, 'اتنين': 2, 'اثنين': 2, 'إثنين': 2, 'تلاتة': 3, 'تلاته': 3, 'ثلاثة': 3, 'ثلاثه': 3, 'أربعة': 4, 'اربعة': 4, 'اربعه': 4, 'أربعه': 4,
  'خمسة': 5, 'خمسه': 5, 'ستة': 6, 'سته': 6, 'سبعة': 7, 'سبعه': 7, 'تمانية': 8, 'ثمانية': 8, 'تسعة': 9, 'عشرة': 10,
};
const ALLERGEN_WORDS: Array<[string, RegExp]> = [
  ['milk', /dairy|milk|lactose|cheese|cream|ألبان|البان|لبن|حليب|لاكتوز|جبن/],
  ['eggs', /\beggs?\b|بيض/],
  ['wheat', /wheat|gluten|قمح|جلوتين|جلوتن|غلوتين/],
  ['fish', /\bfish\b|seafood|سمك|أسماك|اسماك/],
  ['shellfish', /shellfish|shrimp|prawn|جمبري|قشريات/],
  ['tree_nuts', /\bnuts?\b|almond|walnut|cashew|pistachio|مكسرات|لوز|جوز|كاجو|فستق/],
  ['peanuts', /peanut|فول سوداني/],
  ['sesame', /sesame|tahini|سمسم|طحينة/],
  ['soy', /\bsoy|صويا/],
];
/**
 * Saying you avoid something: just before the allergens ("no nuts", "allergic to milk and peanuts", "بدون لبن ومكسرات")
 * or just after them ("nut allergy", "dairy and gluten free"). A cue covers the whole list it introduces or closes.
 */
const AVOID_BEFORE = /\b(?:no|without|avoid(?:ing)?|allergic to|allerg(?:y|ies) to|intolerant to|free of|can'?t (?:eat|have)|cannot (?:eat|have)|(?:don'?t|do not) (?:eat|have))\b|بدون|من غير|مش عايز|ماعدا|ما عدا|حساسية من|حساسية|ممنوع/g;
const AVOID_AFTER = /allerg|\bfree\b|intoleran|حساسية/g;
/** Words that keep a list of allergens going ("no nuts, dairy or eggs", "بدون لبن ولا بيض"). */
const LIST_GLUE = new Set([
  'and', 'or', 'nor', 'also', 'any', 'either', 'neither', 'plus', 'the', 'to', 'of', 'all', 'n',
  'و', 'أو', 'او', 'ولا', 'لا', 'ال', 'وال', 'أي', 'اي', 'كمان', 'ايضا', 'أيضا',
]);
const isGlue = (gap: string) => gap.split(/[\s\p{P}\p{S}]+/u).every((w) => !w || LIST_GLUE.has(w));
const ALLERGEN_SCAN = ALLERGEN_WORDS.map(([code, re]) => [code, new RegExp(re.source, 'g')] as const);

/** Allergens the guest says to avoid. Mentioning an ingredient ("extra cheese") is not avoiding it. */
export function avoidedAllergens(text: string): string[] {
  const spans = ALLERGEN_SCAN.flatMap(([code, re]) => [...text.matchAll(re)].map((m) => ({ code, start: m.index, end: m.index + m[0].length })))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const before = [...text.matchAll(AVOID_BEFORE)].map((m) => m.index + m[0].length);
  const after = [...text.matchAll(AVOID_AFTER)].map((m) => m.index);
  const out = new Set<string>();
  // Forward: a cue, then allergens joined only by list words.
  let chainEnd = -1;
  for (const s of spans) {
    const cued = before.some((e) => e <= s.start && isGlue(text.slice(e, s.start)));
    const chained = chainEnd >= 0 && chainEnd <= s.start && isGlue(text.slice(chainEnd, s.start));
    if (cued || chained) { out.add(s.code); chainEnd = s.end; } else if (s.start >= chainEnd) chainEnd = -1;
  }
  // Backward: allergens joined only by list words, then a cue ("nuts and dairy allergy", "gluten-free").
  let chainStart = -1;
  for (const s of [...spans].reverse()) {
    const cued = after.some((b) => b >= s.end && isGlue(text.slice(s.end, b)));
    const chained = chainStart >= 0 && chainStart >= s.end && isGlue(text.slice(s.end, chainStart));
    if (cued || chained) { out.add(s.code); chainStart = s.start; } else if (s.end <= chainStart) chainStart = -1;
  }
  return [...out];
}

export interface Understood { party: number; budgetMinor: number | null; vegetarian: boolean; mild: boolean; quick: boolean; exclude: string[]; wants: Course[] }

const num = (raw: string) => {
  const n = Number(raw.replace(/[,،٬]/g, '').replace(/٫/g, '.'));
  return Number.isFinite(n) ? n : null;
};

export function understand(req: AssistantRequest): Understood {
  const text = toWesternDigits(req.text ?? '').toLowerCase().replace(/[\u2018\u2019\u02bc]/g, "'").replace(/\s+/g, ' ');
  const words = text.replace(/(\p{L}+)/gu, (w) => (WORDS[w] !== undefined ? String(WORDS[w]) : w));
  let party: number | null = null;
  const partyRe = [
    /(?:for|we are|we're|party of|table for|group of)\s*(\d{1,2})\b/, /(\d{1,2})\s*(?:people|persons|guests|pax|of us|adults)/,
    /(?:إحنا|احنا|نحن|عددنا|عدد)\s*(\d{1,2})/, /(\d{1,2})\s*(?:أشخاص|اشخاص|أفراد|افراد|ضيوف|نفر|فرد)/,
  ];
  for (const re of partyRe) { const m = re.exec(words); if (m) { party = Number(m[1]); break; } }
  if (party === null && /لشخصين|شخصين|for two|for 2|two of us|couple/.test(words)) party = 2;
  if (party === null && /لشخص واحد|for one|just me|alone|لوحدي/.test(words)) party = 1;

  let budget: number | null = null;
  const budgetRe = [
    /(?:under|below|less than|budget(?: of| is)?|max(?:imum)?|up to|within|around|about)\s*(?:egp|sar|le|l\.e\.?|£|sr)?\s*(\d[\d,.]*)/,
    /(\d[\d,.]*)\s*(?:egp|sar|le\b|l\.e|pounds?|riyals?|sr\b|جنيه|جنية|ج\.م|ج م|ريال|ر\.س)/,
    /(?:ميزانية|ميزانيتنا|ميزانيتي|الميزانية|حدود|في حدود|أقل من|اقل من|تحت|مش أكتر من|مش اكتر من|معانا|معايا)\s*(\d[\d,.]*)/,
  ];
  for (const re of budgetRe) { const m = re.exec(text); if (m) { budget = num(m[1]!); break; } }

  const exclude = new Set<string>(req.exclude ?? []);
  for (const allergen of avoidedAllergens(text)) exclude.add(allergen);
  // Wheat and gluten go together whichever the guest named.
  if (exclude.has('wheat') || exclude.has('gluten')) { exclude.add('wheat'); exclude.add('gluten'); }
  const wants: Course[] = [];
  if (/\bdrinks?\b|beverage|مشروب|مشروبات|عصير/.test(text)) wants.push('drink');
  if (/dessert|sweet|حلو|حلويات/.test(text)) wants.push('dessert');
  if (/starter|appeti[sz]er|مقبلات/.test(text)) wants.push('starter');
  return {
    party: req.party ?? Math.min(20, Math.max(1, party ?? 2)),
    budgetMinor: req.budgetMinor ?? (budget !== null && budget > 0 ? Math.round(budget * 100) : null),
    vegetarian: req.vegetarian ?? /vegetarian|veggie|vegan|no meat|meatless|نباتي|بدون لحم|من غير لحم/.test(text),
    mild: req.mild ?? (/not spicy|no spic|non[- ]?spicy|\bmild|nothing spicy|(?:don'?t|do not) (?:want|like) (?:it )?spicy/.test(text)
      || /(?:مش|غير|بدون|من غير|ما|لا|بلاش)\s+(?:\S+\s+){0,2}(?:حار|حراق|شطة)/.test(text)),
    quick: req.quick ?? /quick|fast|hurry|سريع|بسرعة|مستعجل|مستعجلين/.test(text),
    exclude: [...exclude].sort(),
    wants,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Composing a meal
// ---------------------------------------------------------------------------------------------------------------
const byPreference = (a: Candidate, b: Candidate) =>
  b.popularity - a.popularity || a.unitMinor - b.unitMinor || a.product.name.localeCompare(b.product.name, 'en');

export function planMeal(all: Candidate[], u: Understood, currency: string): AssistantResult {
  const passes = (c: Candidate) => {
    const p = c.product;
    if (u.vegetarian && !p.dietary.some((d) => d === 'vegetarian' || d === 'vegan')) return false;
    if (u.mild && p.spiceLevel > 0) return false;
    if (p.allergens.some((a) => u.exclude.includes(a))) return false;
    if (u.quick && (p.prepMinutes ?? 0) > 20) return false;
    return true;
  };
  const pool = all.filter(passes).sort(byPreference);
  const course = (k: Course) => pool.filter((c) => c.course === k);
  const mains = course('main').length ? course('main') : course('starter');
  const understood = { party: u.party, budgetMinor: u.budgetMinor, vegetarian: u.vegetarian, mild: u.mild, quick: u.quick, exclude: u.exclude };
  const empty: AssistantResult = { mode: 'rules', understood, items: [], estimatedTotalMinor: 0, currency, outcome: 'no_match', allergenNotice: true };
  if (!mains.length) return empty;

  const picks: Array<{ c: Candidate; reasons: AssistantReason[] }> = [];
  const total = () => picks.reduce((s, p) => s + p.c.unitMinor, 0);
  const budget = u.budgetMinor;
  const topRank = new Set(pool.filter((c) => c.popularity > 0).slice(0, 3).map((c) => c.product.id));
  const why = (c: Candidate, k: AssistantReason, value = false): AssistantReason[] => [
    k, ...(topRank.has(c.product.id) ? ['popular' as const] : []), ...(u.vegetarian ? ['vegetarian' as const] : []),
    ...(u.mild ? ['mild' as const] : []), ...(u.quick ? ['quick' as const] : []), ...(value ? ['value' as const] : []),
  ];

  // One main per guest: the most ordered dish that still leaves room for everyone else's cheapest main, preferring
  // a different dish for each guest while there are enough to go round.
  const cheapestMain = Math.min(...mains.map((m) => m.unitMinor));
  let overBudget = false;
  for (let seat = 0; seat < u.party; seat++) {
    const left = u.party - seat - 1;
    const room = budget === null ? Infinity : budget - total() - left * cheapestMain;
    const fits = mains.filter((m) => m.unitMinor <= room);
    const fresh = fits.filter((m) => !picks.some((p) => p.c.product.id === m.product.id));
    const choice = fresh[0] ?? fits[0];
    if (choice) picks.push({ c: choice, reasons: why(choice, 'main', choice !== mains[0] && choice.popularity < mains[0]!.popularity) });
    else { overBudget = true; const cheapest = [...mains].sort((a, b) => a.unitMinor - b.unitMinor)[0]!; picks.push({ c: cheapest, reasons: why(cheapest, 'main', true) }); }
  }

  // Then the rest of the meal, while it fits: what the guest asked for first, then a starter to share and a drink each.
  type Extra = 'starter' | 'drink' | 'dessert';
  const extras: Array<[Extra, number]> = [];
  const order = [...u.wants, 'starter', 'drink', 'dessert'].filter((k): k is Extra => k === 'starter' || k === 'drink' || k === 'dessert');
  for (const k of order) {
    if (extras.some(([e]) => e === k)) continue;
    const qty = k === 'drink' ? u.party : Math.ceil(u.party / 2);
    if (k === 'dessert' && !u.wants.includes('dessert') && budget === null) continue; // dessert only when asked or affordable
    extras.push([k, qty]);
  }
  for (const [k, qty] of extras) {
    if (overBudget) break;
    const options = course(k);
    for (const c of options) {
      if (budget !== null && total() + c.unitMinor * qty > budget) continue;
      for (let i = 0; i < qty; i++) picks.push({ c, reasons: why(c, k) });
      break;
    }
  }

  const lines = new Map<string, AssistantResult['items'][number]>();
  for (const { c, reasons } of picks) {
    const existing = lines.get(c.product.id);
    if (existing) { existing.quantity += 1; continue; }
    lines.set(c.product.id, {
      productId: c.product.id, name: c.product.name, nameAr: c.product.nameAr, imageUrl: c.product.imageUrl, priceMinor: c.unitMinor, quantity: 1,
      reasons: [...new Set(reasons)], modifiers: c.modifiers,
    });
  }
  const estimated = total();
  return {
    mode: 'rules', understood, items: [...lines.values()], estimatedTotalMinor: estimated, currency,
    outcome: budget !== null && estimated > budget ? 'over_budget' : 'fits', allergenNotice: true,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Cart suggestions
// ---------------------------------------------------------------------------------------------------------------
/** Dishes ordered together with the cart at this branch (≥ 2 orders), else a drink, else a dessert. Never what is in the cart. */
export function suggest(all: Candidate[], cart: string[], together: Map<string, number>): SuggestionsResult {
  const inCart = new Set(cart);
  const view = (c: Candidate) => ({ productId: c.product.id, name: c.product.name, nameAr: c.product.nameAr, imageUrl: c.product.imageUrl, priceMinor: c.unitMinor });
  const open = all.filter((c) => !inCart.has(c.product.id));
  if (!cart.length) return { mode: 'none', reason: null, items: [] };
  const paired = open.filter((c) => (together.get(c.product.id) ?? 0) >= 2)
    .sort((a, b) => (together.get(b.product.id) ?? 0) - (together.get(a.product.id) ?? 0) || byPreference(a, b)).slice(0, 3);
  if (paired.length) return { mode: 'pairings', reason: 'together', items: paired.map(view) };
  const cartCourses = new Set(all.filter((c) => inCart.has(c.product.id)).map((c) => c.course));
  for (const k of ['drink', 'dessert'] as const) {
    if (cartCourses.has(k)) continue;
    const items = open.filter((c) => c.course === k).sort(byPreference).slice(0, 2);
    if (items.length) return { mode: 'rules', reason: k, items: items.map(view) };
  }
  return { mode: 'none', reason: null, items: [] };
}
