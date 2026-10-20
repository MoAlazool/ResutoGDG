import { z } from 'zod';
import { toWesternDigits } from './locale-format';

export const uuid = z.uuid();
export const slug = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/, 'lowercase letters, digits and dashes (3–48)');
export const locale = z.enum(['en', 'ar']);
export const countryCode = z.enum(['EG', 'SA']);
export const currencyCode = z.enum(['EGP', 'SAR', 'USD']);
/**
 * A string field that accepts Arabic-Indic digits (an Arabic phone keyboard types ٠١٢…) and validates and stores
 * Western digits 0-9 (CR-04). Use for phone numbers and numeric codes, never for free text.
 */
export const westernDigits = <S extends z.ZodType<unknown, string>>(schema: S) => z.string().transform(toWesternDigits).pipe(schema);
export const phoneE164 = westernDigits(z.string().regex(/^\+[1-9][0-9]{6,14}$/, 'international format, e.g. +201001234567'));
/** A phone number as typed by staff (free format, ≤ 30 characters), stored with Western digits; optional. */
export const optionalPhone = (max = 30) => westernDigits(z.string().trim().max(max)).optional().nullable();
export const minor = z.number().int().nonnegative().max(1e13);
export const positiveMinor = z.number().int().positive().max(1e13);
export const isoDateTime = z.iso.datetime({ offset: true });
export const isoDate = z.iso.date();
export const idempotencyKey = z.string().min(8).max(200);
export const text = (max: number) => z.string().trim().min(1).max(max);
export const optionalText = (max: number) => z.string().trim().max(max).optional().nullable();

export const pagination = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
});
export type Pagination = z.infer<typeof pagination>;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Error envelope returned by every API error response. */
export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}

export const COUNTRY_DEFAULTS = {
  EG: { currency: 'EGP', timezone: 'Africa/Cairo', vatRateBp: 1400, taxRegime: 'eta' },
  SA: { currency: 'SAR', timezone: 'Asia/Riyadh', vatRateBp: 1500, taxRegime: 'zatca' },
} as const;
