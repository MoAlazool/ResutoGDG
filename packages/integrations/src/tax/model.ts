// Neutral fiscal document model shared by the ZATCA and ETA builders.
// Amounts are integer minor units (halalas / piastres); builders format them.
import { createHash } from 'node:crypto';

export type FiscalDocumentKind = 'simplified_invoice' | 'standard_invoice' | 'receipt' | 'credit_note' | 'debit_note';

export interface FiscalAddress {
  street?: string | null;
  buildingNumber?: string | null;
  additionalNumber?: string | null;
  district?: string | null;
  city?: string | null;
  postalCode?: string | null;
  governate?: string | null;
  regionCity?: string | null;
  floor?: string | null;
  room?: string | null;
  landmark?: string | null;
}

export interface FiscalLineModel {
  /** Stable internal item code (e.g. product id prefix). */
  code: string;
  name: string;
  quantity: number;
  /** Net amount of the line after discount, excluding VAT. */
  netMinor: number;
  discountMinor: number;
  vatMinor: number;
  /** net + vat */
  grossMinor: number;
  vatRateBp: number;
}

export interface FiscalDocumentModel {
  kind: FiscalDocumentKind;
  number: string;
  uuid: string;
  counterValue: number;
  /** ISO-8601 UTC timestamp without milliseconds, e.g. 2026-10-17T12:30:00Z */
  issuedAt: string;
  currency: string;
  previousHash: string | null;
  seller: {
    name: string;
    vatNumber: string;
    country: 'SA' | 'EG';
    address: FiscalAddress;
    commercialRegistration?: string | null;
    branchCode?: string | null;
    activityCode?: string | null;
    posSerial?: string | null;
  };
  buyer: { name?: string | null; phone?: string | null; vatNumber?: string | null };
  lines: FiscalLineModel[];
  totals: { netMinor: number; vatMinor: number; grossMinor: number; discountMinor: number };
  paymentMethod?: 'cash' | 'card' | 'cod' | 'wallet' | 'instapay' | 'bank_transfer' | 'other';
  /** Credit/debit notes: the document being corrected. */
  reference?: { number: string; uuid: string; issuedAt: string } | null;
  reason?: string | null;
}

/** Formats integer minor units as a fixed-point decimal string ("1150.00"). */
export function formatFiscalMinor(minor: number, digits = 2): string {
  if (!Number.isSafeInteger(minor)) throw new RangeError('amount must be integer minor units');
  const neg = minor < 0;
  const abs = Math.abs(minor);
  const base = 10 ** digits;
  const s = `${Math.trunc(abs / base)}.${String(abs % base).padStart(digits, '0')}`;
  return neg ? `-${s}` : s;
}

/** Minor units → JS number in major units (exact for 2-digit currencies within safe range). */
export const fiscalMinorToNumber = (minor: number, digits = 2) => Number(formatFiscalMinor(minor, digits));

/** Deterministic JSON: object keys sorted recursively, no whitespace. */
export function fiscalCanonicalJson(value: unknown): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      return Object.fromEntries(Object.keys(v as object).sort().filter((k) => (v as any)[k] !== undefined).map((k) => [k, canon((v as any)[k])]));
    }
    return v;
  };
  return JSON.stringify(canon(value));
}

export const fiscalSha256Hex = (input: string | Buffer) => createHash('sha256').update(input).digest('hex');
export const fiscalSha256Base64 = (input: string | Buffer) => createHash('sha256').update(input).digest('base64');

/** Checks that lines add up to the totals and net + VAT = gross. Returns human-readable problems. */
export function checkFiscalTotals(doc: Pick<FiscalDocumentModel, 'lines' | 'totals'>): string[] {
  const problems: string[] = [];
  const sum = (f: (l: FiscalLineModel) => number) => doc.lines.reduce((a, l) => a + f(l), 0);
  if (sum((l) => l.netMinor) !== doc.totals.netMinor) problems.push('line net amounts do not add up to the net total');
  if (sum((l) => l.vatMinor) !== doc.totals.vatMinor) problems.push('line VAT amounts do not add up to the VAT total');
  if (doc.totals.netMinor + doc.totals.vatMinor !== doc.totals.grossMinor) problems.push('net + VAT does not equal the gross total');
  for (const [i, l] of doc.lines.entries()) if (l.netMinor + l.vatMinor !== l.grossMinor) problems.push(`line ${i + 1}: net + VAT does not equal gross`);
  return problems;
}
