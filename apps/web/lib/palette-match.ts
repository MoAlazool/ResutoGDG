// Fuzzy matching for the command palette (21-SHELL): in-house, no dependency. Text is compared case-, diacritic-,
// hamza- and digit-insensitively ("Café" ~ "cafe", "أحمد" ~ "احمد", "١٢" ~ "12"), so Arabic and English labels match
// the way people type them. Each entry is matched on its label (in the page language) and its English keywords.
import { toWesternDigits } from '@resuto/contracts/lite';

/** Normalised text for matching. */
export function foldText(s: string): string {
  return toWesternDigits(s)
    .normalize('NFKD')
    // Combining marks (Latin accents) and Arabic diacritics, tatweel and the hamza/madda marks NFKD splits off.
    .replace(/[̀-ͯؐ-ًؚ-ٰٟۖ-ۭـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}#@+]+/gu, ' ')
    .trim();
}

const words = (s: string) => s.split(' ').filter(Boolean);

/** Characters of `q` appear in `text` in order; returns a score that prefers consecutive runs, or 0. */
function subsequence(q: string, text: string): number {
  let i = 0;
  let run = 0;
  let best = 0;
  for (const ch of text) {
    if (ch === q[i]) { i++; run++; best = Math.max(best, run); if (i === q.length) break; }
    else run = 0;
  }
  return i === q.length ? 1 + best / q.length : 0;
}

/** Score of one query token against a label and keywords (0 = no match). */
function tokenScore(token: string, label: string, keywords: string): number {
  if (label === token) return 100;
  if (label.startsWith(token)) return 80;
  if (words(label).some((w) => w.startsWith(token))) return 60;
  if (label.includes(token)) return 40;
  if (words(keywords).some((w) => w.startsWith(token))) return 35;
  if (keywords.includes(token)) return 25;
  if (token.length >= 2) {
    const s = subsequence(token, label.replace(/ /g, ''));
    if (s) return 8 + s * 4;
    const k = subsequence(token, keywords.replace(/ /g, ''));
    if (k) return 4 + k;
  }
  return 0;
}

/** Match score of a query against an entry; 0 when any word of the query does not match. */
export function scoreEntry(query: string, entry: { label: string; keywords?: string }): number {
  const q = foldText(query);
  if (!q) return 1;
  const label = foldText(entry.label);
  const keywords = foldText(entry.keywords ?? '');
  if (label === q) return 1000;
  let total = label.startsWith(q) ? 200 : 0;
  for (const token of words(q)) {
    const s = tokenScore(token, label, keywords);
    if (!s) return 0;
    total += s;
  }
  return total;
}

/** The entries that match `query`, best first (ties keep their order); all of them for an empty query. */
export function rankEntries<T extends { label: string; keywords?: string }>(entries: readonly T[], query: string, limit = 50): T[] {
  if (!foldText(query)) return entries.slice(0, limit);
  return entries
    .map((e, i) => ({ e, i, s: scoreEntry(query, e) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.e);
}

/** Whether a query is worth sending to the record search (a digit, or two letters). */
export const searchableQuery = (query: string) => {
  const q = foldText(query);
  return /\d/.test(q) || q.replace(/[^\p{L}]/gu, '').length >= 2;
};
