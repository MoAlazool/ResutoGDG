// Operator console for Resuto's own provider apps (21-INT, plan §6.3, /admin/providers). Platform staff enter the app
// id, secret, configuration ids and webhook verify tokens here; the API seals the secrets with its key ring and never
// returns them (only whether each is set and its last four characters). Environment variables stay the fallback.
import { z } from 'zod';
import type { ReviewRequirement } from './marketplace';

export const PLATFORM_APP_PROVIDERS = ['meta', 'tiktok_ads', 'snapchat_ads', 'foodics'] as const;
export type PlatformAppProvider = (typeof PLATFORM_APP_PROVIDERS)[number];

/** Secret values per platform app (sealed, write-only). */
export const PLATFORM_APP_SECRET_KEYS: Record<PlatformAppProvider, readonly string[]> = {
  // appSecret also signs /v1/webhooks/whatsapp (Embedded Signup numbers use Resuto's app).
  meta: ['appSecret', 'webhookVerifyToken', 'whatsappVerifyToken'],
  tiktok_ads: ['appSecret'],
  snapchat_ads: ['appSecret'],
  // webhookToken: the secret path segment of /v1/webhooks/foodics/<token> (Foodics signs nothing).
  foodics: ['appSecret', 'webhookToken'],
};

/** Non-secret configuration ids per platform app. */
export const PLATFORM_APP_CONFIG_KEYS: Record<PlatformAppProvider, readonly string[]> = {
  meta: ['adsLoginConfigId', 'pagesLoginConfigId', 'whatsappSignupConfigId'],
  tiktok_ads: [],
  snapchat_ads: [],
  foodics: [],
};

export const PROVIDER_APP_REVIEW_STATUSES = ['unknown', 'not_submitted', 'in_review', 'approved', 'rejected'] as const;
export type ProviderAppReviewStatus = (typeof PROVIDER_APP_REVIEW_STATUSES)[number];

const key = z.string().regex(/^[A-Za-z]{2,40}$/);

/**
 * PUT /v1/admin/providers/:provider. Omitted fields keep their stored value; `null` clears one. Secrets are
 * write-only: send a new value to replace it, null to remove it.
 */
export const providerAppInput = z.object({
  environment: z.enum(['sandbox', 'live']).optional(),
  appId: z.string().trim().regex(/^[A-Za-z0-9._:-]{1,200}$/, 'letters, digits, ".", "_", ":" or "-"').nullable().optional(),
  secrets: z.record(key, z.string().trim().min(1).max(500).nullable()).optional(),
  configIds: z.record(key, z.string().trim().regex(/^[A-Za-z0-9_-]{1,100}$/).nullable()).optional(),
  reviewStatus: z.enum(PROVIDER_APP_REVIEW_STATUSES).optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
}).strict();
export type ProviderAppInput = z.infer<typeof providerAppInput>;

export interface ProviderAppSecretState { set: boolean; hint: string | null }

/** One line of the readiness checklist (keys are translated by the console). */
export interface ProviderAppChecklistItem { key: string; done: boolean }

export interface AdminProviderAppView {
  provider: PlatformAppProvider;
  name: string;
  /** Where the running API takes this app from: the console record, the environment variables, or nowhere. */
  source: 'database' | 'environment' | 'none';
  environment: 'sandbox' | 'live';
  appId: string | null;
  configIds: Record<string, string | null>;
  /** Never the value: whether it is set and its last four characters (long values only). */
  secrets: Record<string, ProviderAppSecretState>;
  reviewStatus: ProviderAppReviewStatus;
  notes: string | null;
  updatedAt: string | null;
  /** The environment variables that are the fallback, and whether each is set (never their values). */
  environmentFallback: Array<{ name: string; set: boolean }>;
  /** Register these redirect URIs with the provider. */
  redirectUris: string[];
  /** Register these webhook callback URLs with the provider. */
  webhooks: Array<{ url: string; purpose: string }>;
  /** Restaurant integrations this app serves. */
  serves: string[];
  /** What the provider must grant (App Review, business verification …) and the permissions to request. */
  requirements: ReviewRequirement[];
  reviewPermissions: string[];
  checklist: ProviderAppChecklistItem[];
  /** Recorded acceptance runs (scripts/providers/record-acceptance.mjs). Zero means every capability is unverified. */
  acceptance: { passed: number; lastPassedAt: string | null };
  /** docs/OPEN_BLOCKERS.md entries that still block verification. */
  blockers: string[];
}
