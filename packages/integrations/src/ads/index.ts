// ads provider adapters. Owner: Agent C. Export adapters and their ProviderDescriptor here.
import { metaAdsAdapter } from './meta-ads';
import { adsSandboxAdapter } from './sandbox';
import { snapchatAdsAdapter } from './snapchat-ads';
import { tiktokAdsAdapter } from './tiktok-ads';
import type { AdsAdapter } from './types';

export * from './types';
export * from './meta-ads';
export * from './tiktok-ads';
export * from './snapchat-ads';
export * from './sandbox';
export * from './meta-capi';
export * from './audiences';

export const adsAdapters = [metaAdsAdapter, tiktokAdsAdapter, snapchatAdsAdapter, adsSandboxAdapter] as const;

export function adsAdapterFor(provider: string): AdsAdapter | null {
  return (adsAdapters as readonly AdsAdapter[]).find((a) => a.descriptor.id === provider) ?? null;
}
