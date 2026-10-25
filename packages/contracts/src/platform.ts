import { z } from 'zod';
import { countryCode, locale, optionalPhone, optionalText, phoneE164, slug, text, uuid } from './common';
import { memberRole } from './common';
import { checkSocialLink, SOCIAL_LINK_MAX_LENGTH, type SocialLinkProblem, type SocialLinks, type SocialNetwork } from './social-links';
import type { SlugProblem } from './slugs';
import { ONBOARDING_SERVICE_TYPES, ONBOARDING_STEPS } from './onboarding';

export const branchInput = z.object({
  code: z.string().regex(/^[a-z0-9-]{1,40}$/).optional(),
  name: text(120),
  nameAr: optionalText(120),
  address: optionalText(300),
  city: optionalText(80),
  /** Neighbourhood shown to guests (storefront delivery label), in English and Arabic. */
  district: optionalText(80).transform((v) => (v === '' ? null : v)),
  districtAr: optionalText(80).transform((v) => (v === '' ? null : v)),
  phone: optionalPhone(30),
  latitude: z.number().min(-90).max(90).optional().nullable(),
  longitude: z.number().min(-180).max(180).optional().nullable(),
  /** IANA zone; null = the organization's timezone. */
  timezone: z.string().regex(/^[A-Za-z_]+(?:\/[A-Za-z_+-]+){0,2}$/).max(60).optional().nullable(),
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

// --- Social links (21-ONB) ----------------------------------------------------
const SOCIAL_LINK_MESSAGES: Record<SocialLinkProblem, string> = {
  unknown_network: 'unknown network',
  too_long: `at most ${SOCIAL_LINK_MAX_LENGTH} characters`,
  invalid_url: 'not a valid web address',
  not_https: 'must start with https://',
  credentials: 'must not contain a user name or password',
  wrong_host: 'not a link to this network',
};
/** One network's link: an https URL on that network's hosts (normalized), or null / "" to remove it. */
const socialLink = (network: SocialNetwork) => z.string().max(SOCIAL_LINK_MAX_LENGTH + 50).nullable().optional()
  .transform((v, ctx) => {
    if (v === undefined || v === null || v.trim() === '') return undefined;
    const r = checkSocialLink(network, v);
    if (!r.ok) {
      ctx.addIssue({ code: 'custom', message: SOCIAL_LINK_MESSAGES[r.problem] });
      return z.NEVER;
    }
    return r.url;
  });
/** PUT /o/:orgId/social-links: the complete set (a network left out or sent as null/"" is removed). Unknown networks are refused. */
export const socialLinksInput = z.object({
  instagram: socialLink('instagram'),
  facebook: socialLink('facebook'),
  tiktok: socialLink('tiktok'),
  x: socialLink('x'),
  snapchat: socialLink('snapchat'),
  whatsapp: socialLink('whatsapp'),
  google_maps: socialLink('google_maps'),
  website: socialLink('website'),
}).strict();
export type SocialLinksInput = z.input<typeof socialLinksInput>;
export interface SocialLinksResponse { socialLinks: SocialLinks }

// --- Web address availability (21-ONB) -----------------------------------------
export const slugAvailabilityQuery = z.object({ slug: z.string().trim().toLowerCase().min(1).max(60) });
export interface SlugAvailability {
  slug: string;
  available: boolean;
  /** Why it is not available: wrong shape, a reserved word, or another restaurant's address. */
  reason: SlugProblem | 'taken' | null;
}

// --- Menu QR (21-ONB, view-only digital menu) ---------------------------------
export const menuQrQuery = z.object({
  /** A branch code: the QR opens that branch's menu. Omitted: the restaurant's first branch. */
  branch: z.string().regex(/^[a-z0-9-]{1,40}$/).optional(),
});
/**
 * The view-only menu QR: it opens /m/<slug>, the digital menu with no cart, ordering or table session. It is a
 * different kind from the ordering QRs (/t/<table token>, /v/<venue token>) and carries no token.
 */
export interface MenuQr {
  kind: 'menu';
  url: string;
  branchCode: string | null;
  svg: string;
  /** data:image/png;base64,… (1024 px), for download. */
  png: string;
}

// --- Onboarding wizard progress (21-ONB increment 2) ------------------------------
const onboardingStep = z.enum(ONBOARDING_STEPS);
/** Answers kept before the restaurant exists; strict and small (the progress row holds no menu or customer data). */
export const onboardingDraft = z.object({
  name: z.string().trim().max(120).optional(),
  nameAr: z.string().trim().max(120).optional(),
  country: countryCode.optional(),
  serviceMode: z.enum(ONBOARDING_SERVICE_TYPES).optional(),
  slug: z.string().trim().toLowerCase().max(60).optional(),
  menuMethod: z.enum(['manual', 'spreadsheet', 'assisted']).optional(),
}).strict();
/**
 * PUT /v1/onboarding/progress: saves the wizard after a step. `completed` is merged into the steps already finished
 * (never removed); `draft` replaces the draft; `orgId` links the restaurant created at the address step (only one the
 * caller is a member of); `done` marks the wizard finished; `restart` starts a new wizard (another restaurant): the
 * finished steps and the link to the previous restaurant are dropped first.
 */
export const onboardingProgressInput = z.object({
  step: onboardingStep,
  completed: z.array(onboardingStep).max(ONBOARDING_STEPS.length).default([]),
  orgId: uuid.nullable().optional(),
  draft: onboardingDraft.optional(),
  done: z.boolean().optional(),
  restart: z.boolean().optional(),
}).strict();
export type OnboardingProgressInput = z.infer<typeof onboardingProgressInput>;
