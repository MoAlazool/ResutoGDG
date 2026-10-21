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
export * from './tracking-sinks';
export * from '../tiktok/events-api';
export * from '../snapchat/capi';

import { metaCapiAdapter } from './meta-capi';
import { tiktokEventsAdapter } from '../tiktok/events-api';
import { snapCapiAdapter } from '../snapchat/capi';
/** Ad-measurement sinks (INT-20 Meta, INT-23 TikTok + Snap): the catalogue lists them through this array. */
export const trackingAdapters = [metaCapiAdapter, tiktokEventsAdapter, snapCapiAdapter] as const;

export const adsAdapters = [metaAdsAdapter, tiktokAdsAdapter, snapchatAdsAdapter, adsSandboxAdapter] as const;

export function adsAdapterFor(provider: string): AdsAdapter | null {
  return (adsAdapters as readonly AdsAdapter[]).find((a) => a.descriptor.id === provider) ?? null;
}
