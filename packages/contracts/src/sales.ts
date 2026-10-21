// Sales inquiries from the public /pricing page ("Let’s shape your setup."). Stored for the platform team; nothing is
// emailed. Owner: platform/admin (audit VP-09).
import { z } from 'zod';
import { idempotencyKey, locale, text } from './common';

export const salesInquiryInput = z.object({
  restaurant: text(120),
  email: z.email().max(200),
  branches: z.number().int().min(1).max(500),
  requirements: text(1000),
  /** Plan the visitor was looking at (from ?plan=), if any. */
  planId: z.string().regex(/^[a-z0-9_-]{2,40}$/).optional().nullable(),
  locale: locale.optional(),
  /** Client idempotency key: a resubmitted form returns the same inquiry instead of storing a duplicate. */
  key: idempotencyKey,
  /** Honeypot: hidden from people, filled in by form bots. Must stay empty. */
  website: z.string().max(0).optional(),
});
export type SalesInquiryInput = z.infer<typeof salesInquiryInput>;

export interface SalesInquiryReceipt {
  id: string;
  /** Short reference shown to the visitor ("SI-4F2A9C"). */
  reference: string;
}

export const salesInquiryListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** The previous page's nextCursor (opaque). */
  cursor: z.string().min(1).max(500).optional(),
  status: z.enum(['new', 'contacted', 'closed']).optional(),
});
export type SalesInquiryListQuery = z.infer<typeof salesInquiryListQuery>;

export interface SalesInquiryView {
  id: string;
  reference: string;
  restaurant: string;
  email: string;
  branches: number;
  requirements: string;
  planId: string | null;
  locale: 'en' | 'ar' | null;
  status: 'new' | 'contacted' | 'closed';
  createdAt: string;
}

/** "SI-" + the first six hex digits of the id, upper case. Display only; the id is the identifier. */
export const salesInquiryReference = (id: string) => `SI-${id.replace(/-/g, '').slice(0, 6).toUpperCase()}`;
