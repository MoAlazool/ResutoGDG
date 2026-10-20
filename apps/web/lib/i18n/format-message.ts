import { formatNumber } from '@resuto/contracts';
import type { Locale } from './locale';

// Message formatting shared by the server (getT) and the client (useT). Dictionary values are plain text with
// {name} placeholders, optionally with ICU-style plurals so counts read correctly in both languages:
//
//   '{n, plural, one {# booking} other {# bookings}} · {covers, plural, one {# cover} other {# covers}}'
//   '{n, plural, =0 {لا حجوزات} one {حجز واحد} two {حجزان} few {# حجوزات} many {# حجزًا} other {# حجز}}'
//
// Selectors: `=N` (exact), then the locale's plural category (Arabic: zero, one, two, few, many, other; English:
// one, other), then `other`. `#` is the count with Western digits 0-9 and grouping. Unknown or missing variables
// are left as written, so a missing value is visible instead of silently empty.

const rules = new Map<string, Intl.PluralRules>();
const pluralRules = (locale: Locale) => {
  let r = rules.get(locale);
  if (!r) rules.set(locale, (r = new Intl.PluralRules(locale === 'ar' ? 'ar' : 'en')));
  return r;
};

/** The numeric value of a count: numbers as is, numeric strings with optional grouping separators parsed. */
function countOf(raw: string | number | undefined): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const clean = raw.replace(/[,\s\u00A0\u202F\u066C]/g, '');
  return clean !== '' && Number.isFinite(Number(clean)) ? Number(clean) : null;
}

/** Index of the `}` matching the `{` at `open`, or -1. */
function matchBrace(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}' && --depth === 0) return i;
  }
  return -1;
}

function selectBranch(body: string, n: number, locale: Locale): string | null {
  const branches = new Map<string, string>();
  let i = 0;
  while (i < body.length) {
    const m = /^\s*(=\d+|zero|one|two|few|many|other)\s*\{/.exec(body.slice(i));
    if (!m) break;
    const open = i + m[0].length - 1;
    const close = matchBrace(body, open);
    if (close < 0) return null;
    branches.set(m[1]!, body.slice(open + 1, close));
    i = close + 1;
  }
  if (!branches.size) return null;
  if (!Number.isFinite(n)) return branches.get('other') ?? null;
  return branches.get(`=${n}`) ?? branches.get(pluralRules(locale).select(n)) ?? branches.get('other') ?? null;
}

export function formatMessage(template: string, locale: Locale, vars?: Record<string, string | number>): string {
  if (!vars || template.indexOf('{') < 0) return template;
  let out = '';
  let i = 0;
  while (i < template.length) {
    const open = template.indexOf('{', i);
    if (open < 0) { out += template.slice(i); break; }
    out += template.slice(i, open);
    const close = matchBrace(template, open);
    if (close < 0) { out += template.slice(open); break; }
    const inner = template.slice(open + 1, close);
    const plural = /^\s*(\w+)\s*,\s*plural\s*,([\s\S]*)$/.exec(inner);
    if (plural) {
      const raw = vars[plural[1]!];
      const n = countOf(raw);
      // A count the caller already formatted ("1,234") keeps its text for '#'; text that is not a number at all
      // ("—") takes the `other` form, so a user never sees the raw plural syntax.
      const branch = raw === undefined ? null : selectBranch(plural[2]!, n ?? Number.NaN, locale);
      if (branch === null) out += template.slice(open, close + 1);
      else out += formatMessage(branch.replace(/#/g, typeof raw === 'string' ? raw : formatNumber(n!, locale)), locale, vars);
    } else {
      const name = inner.trim();
      out += /^\w+$/.test(name) && name in vars ? String(vars[name]) : template.slice(open, close + 1);
    }
    i = close + 1;
  }
  return out;
}

/** True when a message uses the plural syntax for `name` (used by the dictionary tests). */
export const hasPlural = (template: string, name?: string) =>
  new RegExp(`\\{\\s*${name ?? '\\w+'}\\s*,\\s*plural\\s*,`).test(template);
