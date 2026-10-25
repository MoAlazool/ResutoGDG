// Request schemas and responses of the onboarding wizard (21-ONB increment 2): wizard progress and studio_basic
// (logo, colours, theme presets, publish). In their own module so web bundles, which use only the types, do not carry
// the schemas (the web resolves '@resuto/contracts' to one module; unused modules are dropped, used ones are not).
import { z } from 'zod';
import { countryCode, idempotencyKey, uuid } from './common';
import { ONBOARDING_SERVICE_TYPES, ONBOARDING_STEPS } from './onboarding';
import type { LocalizedText, WebsiteTemplate } from './studio';

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'a colour like #173f36');

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

// --- studio_basic: logo, colours, theme presets (21-ONB increment 2) --------------
/**
 * PUT /v1/o/:orgId/brand: the part of the site's look every plan may change (STUDIO_BASIC_FEATURES). Strict: hero
 * images, taglines, SEO, sections, fonts and templates outside a preset are Studio-only and refused here.
 * `presetId` applies a theme preset (its colours, font and template); colours sent with it override the preset's.
 * `presetId: null` keeps the colours and forgets the preset.
 */
export const updateBrand = z.object({
  presetId: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/).nullable().optional(),
  primaryColor: hex.optional(),
  accentColor: hex.optional(),
  backgroundColor: hex.optional(),
  logoMediaId: uuid.nullable().optional(),
}).strict();
export type UpdateBrand = z.infer<typeof updateBrand>;

/** POST /v1/o/:orgId/brand/publish: publishes the restaurant site as a new revision (the Studio publish, idempotent). */
export const publishBrand = z.object({ key: idempotencyKey }).strict();

/** A theme preset: a complete website theme and storefront theme for one kind of restaurant. */
export interface ThemePreset {
  id: string;
  name: LocalizedText;
  description: LocalizedText;
  template: WebsiteTemplate;
  websiteTheme: { primaryColor: string; accentColor: string; backgroundColor: string; font: 'manrope' | 'editorial' };
  storefrontTheme: { primaryColor: string; accentColor: string; inkColor: string; paperColor: string };
}

/** GET/PUT /v1/o/:orgId/brand. `scope` says whether the restaurant has the full Studio or only studio_basic. */
export interface BrandView {
  presetId: string | null;
  template: WebsiteTemplate;
  theme: { primaryColor: string; accentColor: string; backgroundColor: string; font: 'manrope' | 'editorial'; logoMediaId: string | null };
  logoUrl: string | null;
  website: { status: 'draft' | 'published'; publishedRevision: number; publishedAt: string | null; hasUnpublishedChanges: boolean };
  links: { site: string; menu: string };
  scope: 'studio_basic' | 'studio';
}

export interface BrandPublishResult { revision: number; publishedAt: string; links: { site: string; menu: string } }
