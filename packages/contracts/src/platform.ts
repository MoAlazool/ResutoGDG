import { z } from 'zod';
import { countryCode, locale, optionalText, phoneE164, slug, text, uuid } from './common';
import { memberRole } from './permissions';

export const branchInput = z.object({
  code: z.string().regex(/^[a-z0-9-]{1,40}$/).optional(),
  name: text(120),
  nameAr: optionalText(120),
  address: optionalText(300),
  city: optionalText(80),
  phone: optionalText(30),
  latitude: z.number().min(-90).max(90).optional().nullable(),
  longitude: z.number().min(-180).max(180).optional().nullable(),
  acceptsDineIn: z.boolean().optional(),
  acceptsPickup: z.boolean().optional(),
  acceptsDelivery: z.boolean().optional(),
  acceptsReservations: z.boolean().optional(),
  deliveryFeeMinor: z.number().int().min(0).optional(),
  deliveryRadiusM: z.number().int().positive().optional().nullable(),
  minOrderMinor: z.number().int().min(0).optional(),
  reservationDurationMin: z.number().int().min(15).max(600).optional(),
  reservationBufferMin: z.number().int().min(0).max(240).optional(),
  reservationDepositMinor: z.number().int().min(0).optional(),
  openingHours: z.array(z.object({
    day: z.number().int().min(0).max(6),
    opens: z.string().regex(/^\d{2}:\d{2}$/),
    closes: z.string().regex(/^\d{2}:\d{2}$/),
  })).max(21).optional(),
});
export type BranchInput = z.infer<typeof branchInput>;
export const branchUpdate = branchInput.partial().extend({ isActive: z.boolean().optional() });

export const createOrganization = z.object({
  name: text(120),
  nameAr: optionalText(120),
  slug,
  country: countryCode,
  defaultLocale: locale.default('en'),
  planId: z.string().regex(/^[a-z0-9_-]{2,40}$/).default('free'),
  billingInterval: z.enum(['month', 'year']).default('month'),
  branch: branchInput,
});
export type CreateOrganization = z.infer<typeof createOrganization>;

export const updateOrganization = z.object({
  name: text(120).optional(),
  nameAr: optionalText(120),
  defaultLocale: locale.optional(),
  legalName: optionalText(200),
  taxRegistrationNumber: optionalText(40),
  commercialRegistration: optionalText(40),
  timezone: z.string().max(60).optional(),
});

export const inviteMember = z.object({
  email: z.email().optional(),
  phone: phoneE164.optional(),
  role: memberRole.exclude(['owner']),
  branchIds: z.array(uuid).max(100).nullable().default(null),
}).refine((v) => v.email || v.phone, { message: 'email or phone is required' });
export type InviteMember = z.infer<typeof inviteMember>;

export const updateMember = z.object({
  role: memberRole.exclude(['owner']).optional(),
  branchIds: z.array(uuid).max(100).nullable().optional(),
  status: z.enum(['active', 'suspended']).optional(),
});

export const acceptInvitation = z.object({ token: z.string().min(20).max(200) });

export interface OrganizationSummary {
  id: string;
  slug: string;
  name: string;
  nameAr: string | null;
  country: 'EG' | 'SA';
  currency: 'EGP' | 'SAR';
  timezone: string;
  defaultLocale: 'en' | 'ar';
  status: string;
  role?: string;
}

export interface MeResponse {
  user: { id: string; email: string | null; fullName: string | null; locale: 'en' | 'ar' };
  memberships: Array<{ orgId: string; orgSlug: string; orgName: string; role: string; branchIds: string[] | null }>;
  platformRole: string | null;
}
