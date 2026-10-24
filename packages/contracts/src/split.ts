// Bill-split arithmetic (legacy rules, platform-domain.js). Kept free of zod so guest pages can import it without the
// schema library (see lite.ts); payments.ts re-exports it.
import { assertMinor, splitEvenly } from './money';

/**
 * Largest-remainder apportionment: integer amounts proportional to weights that
 * always sum to the total. Ties go to the earlier share (legacy behaviour).
 */
export function apportion(totalMinor: number, weights: readonly number[]): number[] {
  assertMinor(totalMinor);
  const sumW = weights.reduce((a, w) => a + assertMinor(w, 'weight'), 0);
  if (!weights.length || sumW <= 0) throw new RangeError('Each share needs an amount');
  if (weights.every((w) => w === weights[0])) return splitEvenly(totalMinor, weights.length);
  // Integer arithmetic: floor(total*w/sum) with exact remainders (no float drift).
  const parts = weights.map((w, i) => {
    const num = BigInt(totalMinor) * BigInt(w);
    const q = num / BigInt(sumW);
    return { i, q: Number(q), r: num - q * BigInt(sumW) };
  });
  let remainder = totalMinor - parts.reduce((a, p) => a + p.q, 0);
  const amounts = parts.map((p) => p.q);
  [...parts].sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1)).forEach((p) => {
    if (remainder > 0) { amounts[p.i]! += 1; remainder--; }
  });
  return amounts;
}

export interface BillUnit { lineId: string; unit: number; amountMinor: number; name?: string }
export type SplitPlan = { amounts: number[]; allocations: Array<Array<{ lineId: string; unit: number }>> };

export class SplitRuleError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/** Validates a split request against the remaining balance and returns share amounts (legacy rules). */
export function planSplit(
  dueMinor: number,
  req: { mode: 'whole' | 'equal' | 'custom' | 'items'; people?: number; amounts?: number[]; allocations?: Array<{ items: Array<{ lineId: string; unit: number }> }> },
  units: BillUnit[] = [],
): SplitPlan {
  if (!Number.isSafeInteger(dueMinor) || dueMinor < 1) throw new SplitRuleError('bill_settled', 'This bill is already settled');
  if (req.mode === 'whole') return { amounts: [dueMinor], allocations: [[]] };
  if (req.mode === 'equal') {
    const n = req.people ?? 0;
    if (!Number.isInteger(n) || n < 2 || n > 20 || dueMinor < n) throw new SplitRuleError('invalid_split', 'Choose between 2 and 20 people');
    return { amounts: splitEvenly(dueMinor, n), allocations: Array.from({ length: n }, () => []) };
  }
  if (req.mode === 'custom') {
    const a = req.amounts ?? [];
    if (a.length < 2 || a.length > 20 || a.some((x) => !Number.isSafeInteger(x) || x < 1 || x > dueMinor) || a.reduce((s, x) => s + x, 0) !== dueMinor) {
      throw new SplitRuleError('invalid_split', 'Custom shares must add up to the remaining balance');
    }
    return { amounts: [...a], allocations: a.map(() => []) };
  }
  const allocations = req.allocations ?? [];
  if (allocations.length < 2 || allocations.length > 20) throw new SplitRuleError('invalid_split', 'Assign the bill to between 2 and 20 shares');
  const byKey = new Map(units.map((u) => [`${u.lineId}:${u.unit}`, u]));
  const seen = new Set<string>();
  const raw = allocations.map((alloc) => {
    if (!alloc.items?.length) throw new SplitRuleError('invalid_split', 'Every share needs at least one item');
    return alloc.items.reduce((s, item) => {
      const k = `${item.lineId}:${item.unit}`;
      const unit = byKey.get(k);
      if (!unit || seen.has(k)) throw new SplitRuleError('invalid_split', 'Every item must be assigned exactly once');
      seen.add(k);
      return s + unit.amountMinor;
    }, 0);
  });
  if (seen.size !== byKey.size) throw new SplitRuleError('invalid_split', 'Every item must be assigned exactly once');
  if (raw.some((r) => r <= 0)) throw new SplitRuleError('invalid_split', 'Each share needs an amount');
  const amounts = apportion(dueMinor, raw);
  if (amounts.some((x) => x < 1)) throw new SplitRuleError('invalid_split', 'A share would be zero');
  return { amounts, allocations: allocations.map((a) => a.items.map((i) => ({ lineId: i.lineId, unit: i.unit }))) };
}
