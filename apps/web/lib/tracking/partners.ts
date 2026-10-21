// Which ad platforms a restaurant website measures with (INT-20/INT-23), shared by the Pixel component and tests.
export type PixelCfg = { pixelId: string; testMode: boolean };
export interface TrackingConfig { meta: PixelCfg | null; tiktok?: PixelCfg | null; snap?: PixelCfg | null; consentVersion: string }
export const hasAnyPixel = (c: TrackingConfig | null | undefined): c is TrackingConfig => !!(c && (c.meta || c.tiktok || c.snap));
/** Platform names shown in the consent prompt (Latin brand names, isolated by the caller). */
export const partnersOf = (c: TrackingConfig) => [c.meta && 'Meta', c.tiktok && 'TikTok', c.snap && 'Snapchat'].filter(Boolean).join(', ');
