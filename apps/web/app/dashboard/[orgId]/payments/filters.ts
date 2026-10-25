// Payments list filters (21-MONEY). Kept in the URL (?status&method&mode&from&to) so a filtered list can be shared and
// survives a reload; parsed and turned into the API query here (pure, unit tested). Unknown values are dropped, never
// sent to the API.

export const PAYMENT_STATUSES = ['succeeded', 'pending', 'failed', 'partially_refunded', 'refunded', 'cancelled', 'expired'] as const;
export const PAYMENT_METHODS = ['cash', 'card', 'wallet', 'cod', 'instapay', 'bank_transfer', 'deposit_credit'] as const;
export const PAYMENT_MODES = ['test', 'live'] as const;

export interface PaymentFilters { status: string; method: string; mode: '' | 'test' | 'live'; from: string; to: string }
export const NO_FILTERS: PaymentFilters = { status: '', method: '', mode: '', from: '', to: '' };
export type FilterKey = keyof PaymentFilters;
export const FILTER_KEYS: FilterKey[] = ['status', 'method', 'mode', 'from', 'to'];

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const realDate = (d: string) => DATE.test(d) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
const oneOf = <T extends string>(list: readonly T[], v: string | null): T | '' => (v && (list as readonly string[]).includes(v) ? (v as T) : '');

export function filtersFromParams(sp: { get(name: string): string | null }): PaymentFilters {
  const from = sp.get('from') ?? '';
  const to = sp.get('to') ?? '';
  return {
    status: oneOf(PAYMENT_STATUSES, sp.get('status')),
    method: oneOf(PAYMENT_METHODS, sp.get('method')),
    mode: oneOf(PAYMENT_MODES, sp.get('mode')),
    from: realDate(from) ? from : '',
    to: realDate(to) ? to : '',
  };
}

/** The dates are usable: each one valid or empty, and the start not after the end. */
export const datesValid = (f: Pick<PaymentFilters, 'from' | 'to'>) => (!f.from || realDate(f.from)) && (!f.to || realDate(f.to)) && (!f.from || !f.to || f.from <= f.to);

/** The page URL's query for these filters (empty values left out; the order is stable). */
export function filtersToParams(f: PaymentFilters): string {
  const q = new URLSearchParams();
  for (const k of FILTER_KEYS) if (f[k]) q.set(k, f[k]);
  return q.toString();
}

/** GET /o/:id/payments query: the filters, the shell's branch (empty = all branches), the page size and cursor. */
export function paymentsQuery(f: PaymentFilters, opts: { branchId?: string | null; cursor?: string | null; limit?: number } = {}): string {
  const q = new URLSearchParams({ limit: String(opts.limit ?? 50) });
  if (f.status) q.set('status', f.status);
  if (f.method) q.set('method', f.method);
  if (f.mode) q.set('mode', f.mode);
  if (datesValid(f)) { if (f.from) q.set('from', f.from); if (f.to) q.set('to', f.to); }
  if (opts.branchId) q.set('branchId', opts.branchId);
  if (opts.cursor) q.set('cursor', opts.cursor);
  return q.toString();
}

/** The active filters, in display order (the chips of the filter bar). */
export const activeFilters = (f: PaymentFilters): FilterKey[] => FILTER_KEYS.filter((k) => !!f[k]);
