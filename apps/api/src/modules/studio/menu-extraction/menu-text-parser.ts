import { normalizeNumericInput, parseMajor, type Currency, type ExtractionModifierGroup, type ExtractionRow } from '@resuto/contracts';

/**
 * Resuto's own menu-text reader (FT-08): turns pasted menu text, a .txt file or the text layer someone copied out of a
 * PDF into review rows WITHOUT any model. It only reads what is written: a row's name, price, category, Arabic name,
 * description, sizes and add-ons come from the text, nothing is guessed beyond the layout rules below, and every row
 * carries a confidence and the source line so the reviewer can check it. Nothing is written to the menu here.
 *
 * Layout rules (the common shapes of restaurant menus in Egypt and the Gulf):
 *   - "Starters" / "المقبلات" / "Starters / المقبلات" / "MAINS:"  -> a category header (no price, followed by items)
 *   - "Hummus - حمص ........ 85" / "Falafel (6 pcs)  EGP 60" / "٨٥ ج.م  فول"  -> an item with its price
 *   - "Fresh juice  Small 25 / Large 35" / "Pizza  S 120  M 150  L 180"   -> an item with sizes (base = smallest)
 *   - "+ Extra cheese 15" / "Add: cheese 15, bacon 25" under an item          -> add-ons of that item
 *   - a line without a price right under an item                             -> that item's description
 */

export interface ParsedMenu {
  rows: Omit<ExtractionRow, 'id'>[];
  uncertainties: string[];
}

const ARABIC = /[؀-ۿ]/;
const LATIN = /[A-Za-z]/;
// Currency marks around a price ("EGP 85", "85 LE", "85 ج.م", "SAR 30", "30 ر.س", "E£ 85").
const CURRENCY = String.raw`(?:EGP|L\.?E\.?|E£|£|SAR|SR|S\.R\.?|ر\.س\.?|ريال|ر\.?س|ج\.م\.?|جنيه|جم|ج)`;
const AMOUNT = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d{1,7}(?:[.,]\d{1,2})?`;
const LEADERS = String.raw`[\s.·…_\-–—:|=]*`;
/** A price at the end of the line: "<name> .... 85", "<name> EGP 85", "<name> 85 LE". */
const TRAILING_PRICE = new RegExp(String.raw`^(.*?\S)${LEADERS}\s*(?:${CURRENCY}\s*)?(${AMOUNT})\s*(?:${CURRENCY})?\s*$`, 'u');
/** A price at the start (Arabic menus often print "٨٥ ج.م  فول مدمس"). */
const LEADING_PRICE = new RegExp(String.raw`^(?:${CURRENCY}\s*)?(${AMOUNT})\s*(?:${CURRENCY})?${LEADERS}\s+(.*\S)$`, 'u');
/** "Small 25", "S 25", "صغير 25", "Large: 35" — one size label and its price. */
const SIZE_PAIR = new RegExp(String.raw`([A-Za-z؀-ۿ][A-Za-z؀-ۿ.]{0,14})\s*[:\-]?\s*(?:${CURRENCY}\s*)?(${AMOUNT})\s*(?:${CURRENCY})?`, 'gu');
const SIZE_WORDS = new Set(['s', 'm', 'l', 'xl', 'small', 'medium', 'large', 'regular', 'reg', 'double', 'single', 'half', 'full', 'mini', 'family',
  'صغير', 'وسط', 'كبير', 'عادي', 'دبل', 'سنجل', 'نص', 'نصف', 'كامل', 'عائلي']);
const SIZE_AR: Record<string, string> = { small: 'صغير', s: 'صغير', medium: 'وسط', m: 'وسط', large: 'كبير', l: 'كبير', regular: 'عادي', reg: 'عادي', double: 'دبل', single: 'سنجل', half: 'نصف', full: 'كامل', family: 'عائلي' };
const MAX_ROWS = 300;
const MAX_LINES = 3000;

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
const stripEdges = (s: string) => clean(s).replace(/^[\s.·…_\-–—:|=•*]+|[\s.·…_\-–—:|=•*]+$/g, '').trim();

function amountToMinor(raw: string, currency: Currency): number | null {
  // "1,250" (thousands) vs "12,50" (decimal comma).
  const v = /^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/.test(raw) ? raw.replace(/,/g, '') : raw.replace(',', '.');
  try {
    const minor = parseMajor(v, currency);
    return minor >= 1 && minor <= 10_000_000 ? minor : null;
  } catch {
    return null;
  }
}

/** Splits "Hummus - حمص", "حمص Hummus", "Hummus / حمص" into the Latin and Arabic names. */
export function splitNames(text: string): { name: string; nameAr: string | null; arabicOnly: boolean } {
  const s = stripEdges(text);
  const hasAr = ARABIC.test(s);
  const hasLat = LATIN.test(s);
  if (!hasAr) return { name: s, nameAr: null, arabicOnly: false };
  if (!hasLat) return { name: s, nameAr: s, arabicOnly: true };
  const parts = s.split(/\s+[/|–—-]\s+|\s*[/|]\s*/).map(stripEdges).filter(Boolean);
  if (parts.length === 2 && ARABIC.test(parts[0]!) !== ARABIC.test(parts[1]!)) {
    const [a, b] = ARABIC.test(parts[0]!) ? [parts[1]!, parts[0]!] : [parts[0]!, parts[1]!];
    if (!ARABIC.test(a) && !LATIN.test(b)) return { name: a, nameAr: b, arabicOnly: false };
  }
  // Mixed tokens: group words by script; digits and brackets stay with the word before them.
  const latin: string[] = [];
  const arabic: string[] = [];
  let last: 'lat' | 'ar' | null = null;
  for (const word of s.split(' ')) {
    const kind: 'lat' | 'ar' | null = ARABIC.test(word) ? 'ar' : LATIN.test(word) ? 'lat' : last;
    (kind === 'ar' ? arabic : latin).push(word);
    last = kind;
  }
  const name = stripEdges(latin.join(' '));
  const nameAr = stripEdges(arabic.join(' '));
  return name ? { name, nameAr: nameAr || null, arabicOnly: false } : { name: nameAr, nameAr, arabicOnly: true };
}

interface PriceRead { label: string; priceMinor: number | null; sizes: Array<{ label: string; priceMinor: number }> | null }

/** Reads the price part of a line, or null when the line has no price. */
function readPrice(line: string, currency: Currency): PriceRead | null {
  // Sizes: two or more "<size word> <price>" pairs after the name.
  const pairs = [...line.matchAll(SIZE_PAIR)].filter((m) => SIZE_WORDS.has(m[1]!.toLowerCase().replace(/\.$/, '')));
  if (pairs.length >= 2) {
    const first = pairs[0]!.index!;
    const sizes = pairs.map((m) => ({ label: m[1]!.replace(/\.$/, ''), priceMinor: amountToMinor(m[2]!, currency) }));
    if (sizes.every((x) => x.priceMinor !== null)) {
      const label = stripEdges(line.slice(0, first));
      if (label) return { label, priceMinor: Math.min(...sizes.map((x) => x.priceMinor!)), sizes: sizes as Array<{ label: string; priceMinor: number }> };
    }
  }
  // "120 / 180" after a name: two prices without labels are unclear; read the first and flag it.
  const trailing = TRAILING_PRICE.exec(line);
  if (trailing && !/[(\[]\s*$/.test(trailing[1]!)) {
    const label = trailing[1]!;
    const before = /(\d{1,7}(?:[.,]\d{1,2})?)\s*[/|]\s*$/.exec(stripEdges(label) + ' ');
    const minor = amountToMinor(trailing[2]!, currency);
    if (stripEdges(label) && !/^\d+$/.test(stripEdges(label))) {
      return before
        ? { label: stripEdges(label.slice(0, label.lastIndexOf(before[1]!))), priceMinor: amountToMinor(before[1]!, currency), sizes: null }
        : { label, priceMinor: minor, sizes: null };
    }
  }
  const leading = LEADING_PRICE.exec(line);
  if (leading && /[A-Za-z؀-ۿ]/.test(leading[2]!)) return { label: leading[2]!, priceMinor: amountToMinor(leading[1]!, currency), sizes: null };
  return null;
}

/** "+ Extra cheese 15", "Add: cheese 15, bacon 25", "إضافة جبنة 15" -> options. */
function readAddons(line: string, currency: Currency): Array<{ name: string; nameAr: string | null; priceDeltaMinor: number }> | null {
  const m = /^(?:[+＋]\s*|(?:add(?:-?ons?)?|extras?|with|إضافة|إضافات|اضافة|اضافات)\s*[:\-]?\s+)(.+)$/iu.exec(line);
  if (!m) return null;
  const options: Array<{ name: string; nameAr: string | null; priceDeltaMinor: number }> = [];
  for (const part of m[1]!.split(/\s*[,،;]\s*|\s+\+\s+/)) {
    if (!part.trim()) continue;
    const p = TRAILING_PRICE.exec(part);
    const names = splitNames(p ? p[1]! : part);
    if (!names.name) continue;
    const delta = p ? amountToMinor(p[2]!, currency) : 0;
    options.push({ name: names.name.slice(0, 100), nameAr: names.nameAr?.slice(0, 100) ?? null, priceDeltaMinor: delta ?? 0 });
  }
  return options.length ? options.slice(0, 30) : null;
}

const looksLikeHeader = (line: string) => {
  const s = stripEdges(line);
  if (!s || s.length > 60 || /[.!?؟]$/.test(line.trim())) return false;
  return s.split(' ').length <= 6;
};

/** Sentences read as descriptions: commas, joining words, more than four words, or a lowercase start. */
const descriptionLike = (line: string) =>
  /[,،]/.test(line) || /\b(and|with|served|topped|in|of)\b|\sو|\sمع\s/i.test(line) || line.split(' ').length > 4 || /^[a-z]/.test(line);

export function parseMenuText(input: string, currency: Currency): ParsedMenu {
  const lines = normalizeNumericInput(input).replace(/\r\n?/g, '\n').split('\n').slice(0, MAX_LINES);
  const rows: Array<Omit<ExtractionRow, 'id'>> = [];
  const uncertainties: string[] = [];
  let category: string | null = null;
  let current: Omit<ExtractionRow, 'id'> | null = null;
  let descriptionOpen = false;

  const classify = (raw: string) => {
    const line = clean(raw.replace(/^[\s•·*]+(?=\S)/, (m) => (m.includes('+') ? '+' : '')));
    if (!line) return { kind: 'blank' as const, line };
    const addons = readAddons(line, currency);
    if (addons) return { kind: 'addons' as const, line, addons };
    const price = readPrice(line, currency);
    if (price) return { kind: 'item' as const, line, price };
    return { kind: 'text' as const, line };
  };
  const classified = lines.map(classify);

  for (let i = 0; i < classified.length; i++) {
    const c = classified[i]!;
    if (c.kind === 'blank') { descriptionOpen = false; continue; }
    if (c.kind === 'addons' && !current) {
      if (uncertainties.length < 50) uncertainties.push(`Line ${i + 1} lists add-ons but no item above it: "${c.line.slice(0, 80)}"`);
      continue;
    }
    if (c.kind === 'addons' && current) {
      const group = current.modifiers.find((g) => g.name === 'Extras');
      if (group) group.options.push(...c.addons.slice(0, 30 - group.options.length));
      else current.modifiers.push({ name: 'Extras', nameAr: 'إضافات', minSelect: 0, maxSelect: Math.min(c.addons.length, 20), options: c.addons });
      const g = current.modifiers.find((x) => x.name === 'Extras')!;
      g.maxSelect = Math.min(g.options.length, 20);
      current.source = clean(`${current.source ?? ''} | ${c.line}`).slice(0, 400);
      continue;
    }
    if (c.kind === 'item') {
      if (rows.length >= MAX_ROWS) {
        uncertainties.push(`Only the first ${MAX_ROWS} items were read; split the menu into several imports.`);
        break;
      }
      const names = splitNames(c.price.label);
      const uncertain: string[] = [];
      let confidence = 0.9;
      if (!category) { uncertain.push('category'); confidence -= 0.2; }
      if (c.price.priceMinor === null) { uncertain.push('price'); confidence -= 0.35; }
      if (names.arabicOnly) { uncertain.push('name'); confidence -= 0.1; }
      if (/\d/.test(names.name)) { uncertain.push('name'); confidence -= 0.1; }
      const modifiers: ExtractionModifierGroup[] = [];
      if (c.price.sizes) {
        const base = c.price.priceMinor!;
        modifiers.push({
          name: 'Size', nameAr: 'الحجم', minSelect: 1, maxSelect: 1,
          options: c.price.sizes.map((s) => {
            const lower = s.label.toLowerCase();
            const ar = ARABIC.test(s.label);
            return { name: ar ? s.label : s.label.length <= 2 ? s.label.toUpperCase() : s.label[0]!.toUpperCase() + s.label.slice(1),
              nameAr: ar ? s.label : SIZE_AR[lower] ?? null, priceDeltaMinor: s.priceMinor - base };
          }),
        });
        confidence -= 0.05;
      }
      current = {
        status: 'review', name: names.name.slice(0, 200), nameAr: names.nameAr?.slice(0, 200) ?? null, category: (category ?? 'Mains').slice(0, 200),
        description: null, priceMinor: c.price.priceMinor, allergens: [], modifiers, available: false,
        confidence: Math.max(0.1, Math.round(confidence * 100) / 100), uncertainFields: [...new Set(uncertain)], source: c.line.slice(0, 400),
      };
      rows.push(current);
      descriptionOpen = true;
      continue;
    }
    // A line without a price: a header when items follow it, else the description of the item above.
    const next = classified.slice(i + 1).find((x) => x.kind !== 'blank');
    const headerish = looksLikeHeader(c.line) && (next?.kind === 'item' || /:$/.test(c.line) || (c.line === c.line.toUpperCase() && LATIN.test(c.line)));
    const explicitHeader = /:$/.test(c.line) || (c.line === c.line.toUpperCase() && LATIN.test(c.line)) || /\s[/|]\s/.test(c.line);
    if (headerish && !(descriptionOpen && current && !explicitHeader && descriptionLike(c.line))) {
      const names = splitNames(c.line.replace(/:$/, ''));
      category = (names.name || names.nameAr || '').slice(0, 80) || null;
      current = null;
      descriptionOpen = false;
      continue;
    }
    if (descriptionOpen && current) {
      current.description = clean(`${current.description ?? ''} ${c.line}`).slice(0, 1000);
      current.source = clean(`${current.source ?? ''} | ${c.line}`).slice(0, 400);
      continue;
    }
    if (uncertainties.length < 50) uncertainties.push(`Line ${i + 1} was not read as an item: "${c.line.slice(0, 80)}"`);
  }
  if (!rows.length) uncertainties.unshift('No priced items were found. Each item needs a price on its line (for example "Hummus .... 85").');
  return { rows, uncertainties };
}
