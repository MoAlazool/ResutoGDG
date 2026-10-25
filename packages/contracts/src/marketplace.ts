// Integrations marketplace (21-INT, plan §6.3): how each provider is connected, its marketplace category, the honest
// status chip and permission gaps. Zod-free (exported from '@resuto/contracts/lite' too): the API computes the chip for
// the catalog and the web renders it; both use these functions, so the chip can never claim more than the readiness
// facts and the connection state support.
//
// "Verified" is never derived here: capability verification comes only from recorded acceptance runs
// (integration_verifications, apps/api readiness.ts). Without one a capability reads "Implemented, verification pending".

/** How a restaurant connects a provider (descriptor field `connectMethod`). */
export const CONNECT_METHODS = ['oauth', 'embedded_signup', 'guided_onboarding', 'api_key', 'platform_managed'] as const;
export type ConnectMethod = (typeof CONNECT_METHODS)[number];

/** Marketplace filters (plan §6.3), plus 'website' for the custom-domain card. */
export const MARKETPLACE_CATEGORIES = ['messaging', 'ads_tracking', 'payments', 'pos', 'accounting', 'tax', 'delivery_maps', 'ai', 'website'] as const;
export type MarketplaceCategory = (typeof MARKETPLACE_CATEGORIES)[number];

/** Provider adapter category (packages/integrations ProviderCategory) -> marketplace filter. */
export function marketplaceCategory(providerCategory: string): MarketplaceCategory {
  switch (providerCategory) {
    case 'ads': return 'ads_tracking';
    case 'delivery': return 'delivery_maps';
    case 'messaging': case 'payments': case 'pos': case 'accounting': case 'tax': case 'ai': return providerCategory;
    case 'billing': return 'payments';
    default: return 'website';
  }
}

/** The six chips of plan §6.3. */
export const MARKETPLACE_STATUSES = ['not_connected', 'connected', 'needs_attention', 'sandbox', 'pending_review', 'not_available'] as const;
export type MarketplaceStatus = (typeof MARKETPLACE_STATUSES)[number];

/** What the provider (not Resuto) must grant before some capabilities work. */
export const REVIEW_REQUIREMENTS = ['app_review', 'business_verification', 'ad_account_access', 'tech_provider', 'partner_app'] as const;
export type ReviewRequirement = (typeof REVIEW_REQUIREMENTS)[number];

/**
 * The platform app's review state as the Resuto operator recorded it in the operator console (platform_provider_apps).
 * 'unknown' when nothing was recorded: never treated as approved.
 */
export type ProviderReviewState = 'approved' | 'pending' | 'unknown';

/** Why a chip is what it is (the connection sheet lists these). */
export type MarketplaceReason =
  | 'blocked_by_provider' | 'implementation_incomplete' | 'simulated' | 'revoked' | 'connection_error' | 'token_expired' | 'token_expiring'
  | 'missing_permissions' | 'choose_account' | 'awaiting_check' | 'disabled' | 'test_environment' | 'review_pending';

export interface MarketplaceConnectionFacts {
  status: 'not_configured' | 'sandbox' | 'pending' | 'connected' | 'error' | 'revoked';
  enabled: boolean;
  environment: 'sandbox' | 'live';
  /** 'platform_app' when the token came from Resuto's own provider app (OAuth, Embedded Signup). */
  tokenSource?: string | null;
  /** ISO time the access token expires (Meta long-lived user tokens), when known. */
  tokenExpiresAt?: string | null;
  /** OAuth connection waiting for the owner to pick the ad account / Page / business. */
  needsAccountSelection?: boolean;
  /** Capabilities whose required scopes were read back from the provider and are missing. */
  missingPermissions?: number;
}

export interface MarketplaceStatusInput {
  /** The adapter only simulates (no provider involved). */
  simulated: boolean;
  /** readiness.ts summary for the tenant (null for simulated providers). */
  readinessSummary: string | null;
  connectMethod: ConnectMethod;
  reviewRequirements?: readonly ReviewRequirement[];
  providerReview?: ProviderReviewState;
  connection: MarketplaceConnectionFacts | null;
  now?: Date;
}

/** Days before expiry when a token counts as "expiring" (matches the API's reconnect reminder). */
export const TOKEN_EXPIRY_WARNING_DAYS = 7;

const REVIEW_GATED: readonly ReviewRequirement[] = ['app_review', 'tech_provider', 'partner_app'];

/**
 * The honest chip for one provider card. Order of precedence: a provider that cannot serve the tenant (documented
 * restriction, or Resuto's implementation is incomplete) is "Not yet available"; no live connection is "Not connected"
 * (or "Sandbox" for simulated providers); a connection that needs the owner is "Needs attention"; a test-environment
 * connection is "Sandbox"; a connection through Resuto's platform app whose provider review is not recorded as approved
 * is "Pending provider review"; otherwise "Connected".
 */
export function marketplaceStatus(input: MarketplaceStatusInput): { status: MarketplaceStatus; reasons: MarketplaceReason[] } {
  const reasons: MarketplaceReason[] = [];
  const c = input.connection;
  if (input.readinessSummary === 'blocked_by_provider') return { status: 'not_available', reasons: ['blocked_by_provider'] };
  if (input.readinessSummary === 'implementation_incomplete') return { status: 'not_available', reasons: ['implementation_incomplete'] };
  if (input.simulated) return { status: 'sandbox', reasons: ['simulated'] };
  if (!c || c.status === 'not_configured') return { status: 'not_connected', reasons };
  if (c.status === 'revoked') return { status: 'not_connected', reasons: ['revoked'] };
  const now = (input.now ?? new Date()).getTime();
  const expires = c.tokenExpiresAt ? Date.parse(c.tokenExpiresAt) : NaN;
  if (c.status === 'error') reasons.push('connection_error');
  if (Number.isFinite(expires) && expires <= now) reasons.push('token_expired');
  else if (Number.isFinite(expires) && expires - now < TOKEN_EXPIRY_WARNING_DAYS * 86_400_000) reasons.push('token_expiring');
  if ((c.missingPermissions ?? 0) > 0) reasons.push('missing_permissions');
  if (c.needsAccountSelection) reasons.push('choose_account');
  if (c.status === 'pending') reasons.push('awaiting_check');
  if (!c.enabled) reasons.push('disabled');
  if (reasons.length) return { status: 'needs_attention', reasons };
  if (c.environment === 'sandbox' || c.status === 'sandbox') return { status: 'sandbox', reasons: ['test_environment'] };
  const usesPlatformApp = c.tokenSource === 'platform_app' || input.connectMethod === 'embedded_signup';
  const gated = (input.reviewRequirements ?? []).some((r) => REVIEW_GATED.includes(r));
  if (usesPlatformApp && gated && input.providerReview !== 'approved') return { status: 'pending_review', reasons: ['review_pending'] };
  return { status: 'connected', reasons };
}

/** Scopes a capability needs, per provider (descriptor `requiredScopes`). */
export type RequiredScopes = Readonly<Record<string, readonly string[]>>;

export interface PermissionGaps {
  /** True when the granted scopes were read back from the provider (token response or permissions API). */
  checked: boolean;
  granted: string[];
  /** Capabilities with at least one required scope missing, and which ones ("needs permission X"). */
  missing: Array<{ capability: string; scopes: string[] }>;
}

/** Compares the scopes the provider granted with the ones each capability needs. Nothing read back = not checked. */
export function permissionGaps(required: RequiredScopes | null | undefined, granted: readonly string[] | null | undefined): PermissionGaps {
  const have = [...new Set((granted ?? []).map((s) => s.trim()).filter(Boolean))].sort();
  if (!have.length || !required) return { checked: have.length > 0, granted: have, missing: [] };
  const set = new Set(have);
  const missing = Object.entries(required)
    .map(([capability, scopes]) => ({ capability, scopes: scopes.filter((s) => !set.has(s)) }))
    .filter((m) => m.scopes.length > 0);
  return { checked: true, granted: have, missing };
}

/**
 * Marketplace cards for guided flows that live elsewhere in the dashboard (no provider adapter in the integrations
 * catalogue): ZATCA onboarding (Compliance, OTP stepper) and custom domains (Website, Vercel domains API). Their
 * readiness is taken from docs/INTEGRATION_READINESS.md: ZATCA is "implementation incomplete — not certified" (B-6);
 * custom domains are implemented and unverified (B-9).
 */
export const MARKETPLACE_LINKS = [
  { id: 'zatca', logo: 'zatca', category: 'tax', connectMethod: 'guided_onboarding', countries: ['SA'], path: 'compliance', readiness: 'implementation_incomplete' },
  { id: 'vercel_domains', logo: 'vercel', category: 'website', connectMethod: 'platform_managed', countries: ['EG', 'SA'], path: 'website', readiness: 'pending_external_verification' },
] as const satisfies ReadonlyArray<{
  id: string; logo: string; category: MarketplaceCategory; connectMethod: ConnectMethod; countries: readonly string[]; path: string; readiness: string;
}>;

/** Provider id -> its ProviderLogo mark (packages/ui provider-logo.tsx); null = no mark, the card shows a monogram. */
export const PROVIDER_LOGO_IDS: Readonly<Record<string, string>> = {
  whatsapp_cloud: 'whatsapp', meta_pages: 'messenger', messaging_sandbox: 'whatsapp', meta_capi: 'meta', meta_ads: 'meta',
  tiktok_events: 'tiktok', tiktok_ads: 'tiktok', snap_capi: 'snapchat', snapchat_ads: 'snapchat', foodics: 'foodics', odoo: 'odoo',
  odoo_accounting: 'odoo', paymob: 'paymob', stripe: 'stripe', moyasar: 'moyasar', wafeq: 'wafeq', qoyod: 'qoyod', eta_ereceipt: 'eta',
  google_routes: 'google-maps', gemini_byok: 'gemini', resend: 'resend', twilio_sms: 'twilio', zatca: 'zatca', vercel_domains: 'vercel',
};
