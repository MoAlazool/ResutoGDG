// The menu workspace's pure logic (21-MENU): which items a filter shows, the order of the rail and the table, the
// branch view of a dish, category reordering, and the bulk price change with its preview. Money is integer minor
// units throughout; nothing here touches the DOM, so it is unit tested directly (model.test.ts).
import { normalizeNumericInput } from '@resuto/contracts/lite';
import type { Category, Product } from '@resuto/contracts';

/** Highest price the API accepts (contracts catalog.ts priceMinor). */
export const MAX_PRICE_MINOR = 100_000_000;

/** A dish at the shell's branch: offered there, sold out (86), out of tracked stock, its price there. */
export function branchView(p: Product, branchId: string) {
  const s = p.branchSettings.find((b) => b.branchId === branchId);
  const offered = s ? s.isAvailable : true;
  const soldOut = !!s?.soldOut;
  const outOfStock = p.trackStock && s?.stockQty !== null && s?.stockQty !== undefined && s.stockQty <= 0;
  const overrideMinor = s?.priceOverrideMinor ?? null;
  return { offered, soldOut, outOfStock, overrideMinor, priceMinor: overrideMinor ?? p.priceMinor, until: s?.soldOutUntil ?? null };
}

export type AvailabilityFilter = '' | 'offered' | 'not_offered';
export interface MenuFilters {
  /** Category id, or '' for every category. */
  category: string;
  q: string;
  availability: AvailabilityFilter;
  /** Sold out (86) or out of tracked stock at the branch. */
  soldOut: boolean;
  /** Dishes whose portions are counted (trackStock). */
  tracked: boolean;
}
export const NO_FILTERS: MenuFilters = { category: '', q: '', availability: '', soldOut: false, tracked: false };

/** Case-, diacritic-, hamza- and digit-insensitive text for search ("Café" ~ "cafe", "أحمد" ~ "احمد"). */
export const searchText = (s: string) => normalizeNumericInput(s).normalize('NFKD').replace(/[̀-ًͯ-ٰٟ]/g, '')
  .replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').toLocaleLowerCase().trim();

/** Active categories in rail order. */
export const activeCategories = (categories: Category[]) => categories.filter((c) => c.isActive).sort((a, b) => a.sortOrder - b.sortOrder);

/** The items the workspace lists (active dishes of active categories), in menu order: category, then dish order. */
export function menuItems(products: Product[], categories: Category[]): Product[] {
  const order = new Map(activeCategories(categories).map((c, i) => [c.id, i]));
  return products.filter((p) => p.isActive && order.has(p.categoryId))
    .sort((a, b) => order.get(a.categoryId)! - order.get(b.categoryId)! || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

/** Applies the filter bar and the rail to the items (already in menu order). */
export function filterItems(items: Product[], f: MenuFilters, branchId: string): Product[] {
  const q = searchText(f.q);
  return items.filter((p) => {
    if (f.category && p.categoryId !== f.category) return false;
    const v = branchView(p, branchId);
    if (f.availability === 'offered' && !v.offered) return false;
    if (f.availability === 'not_offered' && v.offered) return false;
    if (f.soldOut && !(v.offered && (v.soldOut || v.outOfStock))) return false;
    if (f.tracked && !p.trackStock) return false;
    if (q) {
      const hay = searchText([p.name, p.nameAr ?? '', p.description ?? '', p.descriptionAr ?? '', p.station, p.externalRef ?? ''].join(' '));
      if (!q.split(/\s+/).every((w) => hay.includes(w))) return false;
    }
    return true;
  });
}

/** Item counts per category id (active dishes only) and in total, for the rail. */
export function categoryCounts(items: Product[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of items) out.set(p.categoryId, (out.get(p.categoryId) ?? 0) + 1);
  return out;
}

/** The ids with the one at `from` moved to `to` (both clamped); the same array when nothing moves. */
export function moveId(ids: string[], from: number, to: number): string[] {
  const t = Math.max(0, Math.min(ids.length - 1, to));
  if (from < 0 || from >= ids.length || from === t) return ids;
  const out = [...ids];
  const [moved] = out.splice(from, 1);
  out.splice(t, 0, moved!);
  return out;
}

// --- Bulk price change --------------------------------------------------------------------------------------------
export type PriceMode = 'percent' | 'amount';
export type PriceDirection = 'up' | 'down';
/** Round the new price to the nearest step, in minor units (0 = exact). */
export const ROUNDING_STEPS = [0, 5, 25, 50, 100, 500] as const;
export type RoundingStep = (typeof ROUNDING_STEPS)[number];

export interface PriceChange {
  mode: PriceMode;
  direction: PriceDirection;
  /** Percent in basis points (1250 = 12.5 %) or an amount in minor units; always positive. */
  value: number;
  round: RoundingStep;
}

/**
 * Typed percent → basis points (12.5 → 1250), at most two decimals; Arabic-Indic digits and the Arabic decimal
 * separator are accepted. Null when empty, 'invalid' when it is not a positive percentage up to 1000 %.
 */
export function parsePercent(text: string): number | null | 'invalid' {
  const s = normalizeNumericInput(text).replace(/[\s%٪]/g, '').replace(',', '.');
  if (!s) return null;
  const m = /^(\d{1,4})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return 'invalid';
  const bps = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return bps > 0 && bps <= 100_000 ? bps : 'invalid';
}

/** Nearest multiple of `step` (half rounds up); `step` 0 leaves the amount as it is. */
export function roundToStep(minor: number, step: number): number {
  if (!step) return minor;
  return Math.floor((minor + step / 2) / step) * step;
}

/** Integer division rounding half away from zero (as contracts' money helpers do). */
const roundDiv = (n: number, d: number) => Math.sign(n) * Math.floor((Math.abs(n) + d / 2) / d);

/**
 * One dish's new base price under a change, in integer minor units: a percentage scales the price and rounds the
 * result half away from zero (9.99 + 12.5 % = 11.23875 → 11.24; 0.05 − 10 % = 0.045 → 0.05), an amount is added or
 * taken off exactly, then the result is rounded to the chosen step. Never a fraction of a minor unit.
 */
export function changedPrice(priceMinor: number, c: PriceChange): number {
  const sign = c.direction === 'down' ? -1 : 1;
  const raw = c.mode === 'percent' ? roundDiv(priceMinor * (10_000 + sign * c.value), 10_000) : priceMinor + sign * c.value;
  return roundToStep(raw, c.round);
}

export interface PricePreviewRow {
  id: string; name: string; nameAr: string | null; version: number;
  fromMinor: number; toMinor: number;
  /** 'change' is applied; 'same' is left alone; the rest are refused and listed. */
  outcome: 'change' | 'same' | 'below_zero' | 'too_high';
  /** The branch's own price, which the base-price change does not touch. */
  branchOverrideMinor: number | null;
  /** A regular price edit ends a dish discount (21-STUDIO compare-at price). */
  endsDiscount: boolean;
}
export interface PricePreview { rows: PricePreviewRow[]; changed: number; unchanged: number; refused: number; endsDiscount: number; overridden: number }

/** The preview the bulk price sheet shows and applies: every selected dish with its current and new base price. */
export function pricePreview(products: Product[], c: PriceChange, branchId: string): PricePreview {
  const rows = products.map((p): PricePreviewRow => {
    const to = changedPrice(p.priceMinor, c);
    const outcome = to < 0 ? 'below_zero' : to > MAX_PRICE_MINOR ? 'too_high' : to === p.priceMinor ? 'same' : 'change';
    return {
      id: p.id, name: p.name, nameAr: p.nameAr, version: p.version, fromMinor: p.priceMinor, toMinor: to, outcome,
      branchOverrideMinor: branchView(p, branchId).overrideMinor,
      endsDiscount: outcome === 'change' && compareAtOf(p) !== null,
    };
  });
  const changing = rows.filter((r) => r.outcome === 'change');
  return {
    rows, changed: changing.length, unchanged: rows.filter((r) => r.outcome === 'same').length,
    refused: rows.filter((r) => r.outcome === 'below_zero' || r.outcome === 'too_high').length,
    endsDiscount: changing.filter((r) => r.endsDiscount).length,
    overridden: changing.filter((r) => r.branchOverrideMinor !== null).length,
  };
}

/** The "was" price of a discounted dish (21-STUDIO), when it is above the current price. */
export function compareAtOf(p: Product): number | null {
  const v = p.compareAtMinor;
  return typeof v === 'number' && v > p.priceMinor ? v : null;
}

// --- Bulk runner ----------------------------------------------------------------------------------------------------
export interface BulkResult { ok: number; failed: number; firstError: string | null }

/** Runs `fn` over `items` a few at a time; one failure does not stop the others. */
export async function runBulk<T>(items: T[], fn: (item: T) => Promise<unknown>, concurrency = 4): Promise<BulkResult> {
  let ok = 0, failed = 0, firstError: string | null = null, next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]!;
      try { await fn(item); ok++; } catch (e) { failed++; firstError ??= (e as Error).message; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return { ok, failed, firstError };
}
