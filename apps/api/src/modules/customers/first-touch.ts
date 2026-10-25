import { ACQUISITION_BASES, type AcquisitionBasis } from '@resuto/contracts';

/**
 * The stored first touch (customers.first_touch, migration 20261027210001): set once by the database from the evidence
 * known at the customer's first identified interaction, never overwritten. Customer 360 and the overview's acquisition
 * read it as their source of truth and derive the touch live only when there is none yet, or when the caller may not
 * see it (it rests on an order or conversation of a branch outside a branch-scoped caller's branches, or on a
 * conversation for a caller without conversation access).
 */
export interface StoredFirstTouch {
  basis: AcquisitionBasis;
  inferred: boolean;
  occurredAt: string | null;
  channel: string | null;
  campaignId: string | null;
  linkId: string | null;
  orderId: string | null;
  branchId: string | null;
  utm: { source: string | null; medium: string | null; campaign: string | null; content: string | null; term: string | null };
  setBy: 'live' | 'backfill' | string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown, max = 100) => (typeof v === 'string' && v.length ? v.slice(0, max) : null);
const id = (v: unknown) => (typeof v === 'string' && UUID.test(v) ? v : null);

/** The stored value when it has the expected shape (anything else is ignored, never trusted). */
export function parseStoredFirstTouch(v: unknown): StoredFirstTouch | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.basis !== 'string' || !(ACQUISITION_BASES as readonly string[]).includes(o.basis)) return null;
  const at = str(o.occurredAt, 40);
  const utm = (o.utm && typeof o.utm === 'object' ? o.utm : {}) as Record<string, unknown>;
  return {
    basis: o.basis as AcquisitionBasis, inferred: o.inferred === true,
    occurredAt: at && !Number.isNaN(Date.parse(at)) ? new Date(at).toISOString() : null,
    channel: str(o.channel, 40), campaignId: id(o.campaignId), linkId: id(o.linkId), orderId: id(o.orderId), branchId: id(o.branchId),
    utm: { source: str(utm.source), medium: str(utm.medium), campaign: str(utm.campaign), content: str(utm.content), term: str(utm.term) },
    setBy: str(o.setBy, 20) ?? 'live',
  };
}

/** Whether a caller with this branch scope (null = all branches) may be shown the stored touch. */
export function storedTouchVisible(t: StoredFirstTouch, scope: string[] | null, opts: { conversations: boolean }): boolean {
  if (t.basis === 'first_conversation_channel' && !opts.conversations) return false;
  return scope === null || t.branchId === null || scope.includes(t.branchId);
}
