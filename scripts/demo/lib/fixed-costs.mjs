// Fixed monthly operating costs of the demo restaurant (audit DF-11). Pure: no database or network access.
//
// Every calendar month that overlaps the demo period [from, to] books each fixed cost exactly once:
//   * a month fully inside the period books the full amount on its usual day;
//   * a partial month (the first month of the history, and the current month) books the amount prorated to the
//     covered days, dated inside the covered days (so nothing is dated outside the period or in the future).
//     Payroll for the current month is therefore month to date.
// Each entry carries a stable externalRef ("demo-fixed:<YYYY-MM>:<kind>") so loaders can upsert it.

export const FIXED_COSTS = [
  { kind: 'rent', amountMinor: 1_800_000, taxMinor: 0, vendor: 'Zamalek landlord (demo)', day: 1 },
  { kind: 'fees', amountMinor: 120_000, taxMinor: 0, vendor: 'POS terminal rental (demo)', day: 5 },
  { kind: 'utilities', amountMinor: 342_000, taxMinor: 42_000, vendor: 'Electricity & water (demo)', day: 10 },
  { kind: 'labor', amountMinor: 2_400_000, taxMinor: 0, vendor: 'Payroll (demo)', day: 25 },
];

const iso = (d) => d.toISOString().slice(0, 10);
const parse = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`expected a YYYY-MM-DD date, got "${s}"`);
  return new Date(`${s}T00:00:00Z`);
};
const daysBetween = (a, b) => Math.round((b - a) / 86_400_000) + 1;   // inclusive
/** Rounds a prorated amount to whole currency units (100 minor units), never below zero. */
const round100 = (n) => Math.max(0, Math.round(n / 100) * 100);

/**
 * @param {{ from: string, to: string, costs?: typeof FIXED_COSTS }} p  dates are business dates (YYYY-MM-DD), inclusive
 * @returns {Array<{ month: string, kind: string, incurredOn: string, amountMinor: number, taxMinor: number, vendor: string,
 *   coveredDays: number, daysInMonth: number, prorated: boolean, description: string, externalRef: string }>}
 */
export function fixedCostSchedule({ from, to, costs = FIXED_COSTS }) {
  const start = parse(from), end = parse(to);
  if (start > end) throw new Error(`fixed costs: from ${from} is after to ${to}`);
  const out = [];
  for (let m = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1)); m <= end; m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1))) {
    const monthEnd = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 0));
    const daysInMonth = monthEnd.getUTCDate();
    const coveredStart = start > m ? start : m;
    const coveredEnd = end < monthEnd ? end : monthEnd;
    const coveredDays = daysBetween(coveredStart, coveredEnd);
    const prorated = coveredDays < daysInMonth;
    const month = iso(m).slice(0, 7);
    const isCurrent = end < monthEnd;
    for (const c of costs) {
      const nominal = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), Math.min(c.day, daysInMonth)));
      const on = nominal < coveredStart ? coveredStart : nominal > coveredEnd ? coveredEnd : nominal;
      const share = coveredDays / daysInMonth;
      out.push({
        month, kind: c.kind, incurredOn: iso(on), vendor: c.vendor,
        amountMinor: prorated ? round100(c.amountMinor * share) : c.amountMinor,
        taxMinor: prorated ? round100(c.taxMinor * share) : c.taxMinor,
        coveredDays, daysInMonth, prorated,
        description: !prorated ? `${month} (demo)`
          : c.kind === 'labor' && isCurrent ? `${month} payroll, month to date: ${coveredDays} of ${daysInMonth} days (demo)`
            : `${month}, prorated: ${coveredDays} of ${daysInMonth} days in the demo period (demo)`,
        externalRef: `demo-fixed:${month}:${c.kind}`,
      });
    }
  }
  return out;
}
