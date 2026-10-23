// Operator vocabulary in the page language (VS-21 / DF-15). The API stores codes ("kg", "order.status_changed",
// "history_too_short: needs at least 98 days, has 58"); these helpers turn them into dictionary text and fall back to
// the stored value for tenant-defined names (a custom station, a free-text allergen), never to a raw dictionary key.
// Strings live in lib/i18n/dict/vocab.ts.

/** The `t` of useT() / getT(): unknown keys come back unchanged. */
export type Translate = (key: string, vars?: Record<string, string | number>) => string;

const lookup = (t: Translate, key: string, vars?: Record<string, string | number>): string | null => {
  const out = t(key, vars);
  return out === key ? null : out;
};
/** "Cold kitchen" / "cold-kitchen" / "COLD_KITCHEN" -> "cold_kitchen". */
const slug = (s: string) => s.trim().toLowerCase().replace(/[\s-]+/g, '_');

/** Short unit next to a quantity: "3 kg" / "3 كجم". */
export const unitLabel = (t: Translate, unit: string) => lookup(t, `vocab.unit.${unit}`) ?? unit;

/** A known allergen key in the page language; free text is returned as entered. */
export const allergenLabel = (t: Translate, allergen: string) => lookup(t, `core.allergen.${slug(allergen)}`) ?? allergen;

/** Default kitchen station names in the page language; a restaurant's own station names are shown as typed. */
export const stationLabel = (t: Translate, station: string) => lookup(t, `vocab.station.${slug(station)}`) ?? station;

/** Activity-log entity type ("inventory_item" -> "Stock item"); unknown types are humanised, not shown as codes. */
export const entityLabel = (t: Translate, type: string) => lookup(t, `vocab.entity.${type}`) ?? humanise(type);

/** Activity-log action ("order.status_changed" -> "Order status changed"), or null when it has no label yet. */
export const actionLabel = (t: Translate, action: string) => lookup(t, `vocab.action.${action}`);

/** Plan history entry (subscription_events.event_type), e.g. "upgraded" -> "Upgraded" / "ترقية الخطة". */
export const subscriptionEventLabel = (t: Translate, type: string) => lookup(t, `vocab.subscription.${type}`) ?? humanise(type);

/** Resuto invoice status (draft, open, paid, void, uncollectible). */
export const invoiceStatusLabel = (t: Translate, status: string) => lookup(t, `vocab.invoice.${status}`) ?? humanise(status);

/** Where an activity-log entry came from (api, mcp, worker, migration…). */
export const sourceLabel = (t: Translate, source: string) => lookup(t, `vocab.source.${source}`) ?? humanise(source);

/** Integration capability ("transaction_listing" -> "Transaction listing" / "قائمة المعاملات"); REM-W06. */
export const capabilityLabel = (t: Translate, code: string) =>
  lookup(t, `vocab.capability.${code}`) ?? lookup(t, `intg.capability.${code}`) ?? humanise(code);

/** Payment brands keep their Latin names in both languages (wrap them in <bdi> where they sit in Arabic text). */
const PROVIDER_BRANDS: Record<string, string> = { paymob: 'Paymob', moyasar: 'Moyasar', stripe: 'Stripe', fawry: 'Fawry', tap: 'Tap' };

/** Payment provider id as a display name ("simulated" -> "Simulated provider" / "مزوّد محاكاة", "paymob" -> "Paymob"). */
export const paymentProviderLabel = (t: Translate, id: string | null | undefined) =>
  !id ? '—' : PROVIDER_BRANDS[id] ?? lookup(t, `vocab.payProvider.${id}`) ?? humanise(id);

/** Reconciliation item outcome and run source (payments reconciliation). */
export const reconStatusLabel = (t: Translate, status: string) => lookup(t, `vocab.recon.${status}`) ?? humanise(status);
export const reconSourceLabel = (t: Translate, source: string) => lookup(t, `vocab.recon.source.${source}`) ?? humanise(source);

function humanise(code: string): string {
  const s = code.replace(/[._]+/g, ' ').trim();
  return s ? s[0]!.toUpperCase() + s.slice(1) : code;
}

/**
 * Why the forecast used a simpler model. Reason codes come from apps/ai-service/app/core/forecast.py, some with
 * numbers ("history_too_short: needs at least 98 days, has 58"); anything unrecognised gets a generic sentence.
 */
export function forecastReason(t: Translate, reason: string): string {
  const r = reason.trim();
  let m = /^history_too_short:\s*needs at least (\d+) days?, has (\d+)/.exec(r);
  if (m) return t('vocab.forecast.history_too_short', { need: Number(m[1]), have: Number(m[2]) });
  m = /^insufficient_history_for_backtest:\s*(\d+) days?/.exec(r);
  if (m) return t('vocab.forecast.insufficient_history_for_backtest', { days: Number(m[1]) });
  const code = /^[a-z0-9_]+/.exec(r)?.[0];
  const plain = code ? lookup(t, `vocab.forecast.${code}`) : null;
  // A parameterised message whose numbers could not be read must not show its {placeholders}.
  return plain && !plain.includes('{') ? plain : t('vocab.forecast.other');
}
