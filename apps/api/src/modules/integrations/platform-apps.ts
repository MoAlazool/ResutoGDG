import type { PlatformAppProvider, ProviderAppReviewStatus, ProviderReviewState } from '@resuto/contracts';

/**
 * Resuto's provider apps entered in the operator console (21-INT, table platform_provider_apps), decrypted and held
 * in memory by PlatformProviderAppsService (loaded at boot, after every console save in this process, and every
 * minute so other API and worker processes follow). The synchronous lookups below are what oauthApp(), metaPlatform()
 * and the webhook verifiers consult first; the environment variables stay the fallback.
 *
 * A console record replaces the environment only when it is usable — it has the app id and the app secret — and
 * then as a whole (its config ids and verify tokens too), so a half-entered record never mixes with the environment.
 */
export interface PlatformAppRecord {
  provider: PlatformAppProvider;
  environment: 'sandbox' | 'live';
  appId: string | null;
  configIds: Record<string, string>;
  secrets: Record<string, string>;
  reviewStatus: ProviderAppReviewStatus;
}

let records = new Map<PlatformAppProvider, PlatformAppRecord>();

export function setPlatformAppRecords(list: PlatformAppRecord[]) {
  records = new Map(list.map((r) => [r.provider, r]));
}

/** The stored record, usable or not (the console shows it). */
export const platformAppRecord = (provider: PlatformAppProvider): PlatformAppRecord | null => records.get(provider) ?? null;

/** The console record when it replaces the environment (app id and secret present), else null. */
export function activePlatformApp(provider: PlatformAppProvider): PlatformAppRecord | null {
  const r = records.get(provider);
  return r?.appId && r.secrets.appSecret ? r : null;
}

/** The platform app a restaurant integration runs through (Meta's one Business app serves four of them). */
export function platformAppFor(tenantProvider: string): PlatformAppProvider | null {
  switch (tenantProvider) {
    case 'meta_ads': case 'meta_pages': case 'whatsapp_cloud': return 'meta';
    case 'tiktok_ads': case 'snapchat_ads': case 'foodics': return tenantProvider;
    default: return null;
  }
}

/** The provider's review of Resuto's app as the operator recorded it: only 'approved' counts as approved. */
export function providerReviewFor(tenantProvider: string): ProviderReviewState | null {
  const app = platformAppFor(tenantProvider);
  if (!app) return null;
  const status = records.get(app)?.reviewStatus ?? 'unknown';
  return status === 'approved' ? 'approved' : status === 'unknown' ? 'unknown' : 'pending';
}
