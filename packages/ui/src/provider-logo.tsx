import type { UiLocale } from './overlays';
import { useUiLocale } from './locale';

// Provider marks for integration cards, connection sheets and settings. Files live in apps/web/public/brand/providers/
// (Paymob's official PNG stays at public/landing/, where the landing page already serves it) and come from the app's
// own origin (no third-party request). They identify configurable services only and
// imply no partnership; trademarks belong to their owners. Sources (docs/ui/DESIGN_SYSTEM.md, "Provider logos"):
// - 'simple-icons': the brand's mark from the Simple Icons collection (CC0 path data, v16.35.0) in the brand colour it
//   lists (Snapchat in black: its yellow is unreadable on light surfaces);
// - 'official': the company's own published logo, already vendored for the landing page (legacy/ASSET_SOURCES.md);
// - null: no official mark is available offline yet, so a neutral monogram is drawn instead of inventing a logo.
//   These need official assets before launch (see `needsOfficialAsset`).

export type ProviderId =
  | 'meta' | 'facebook' | 'instagram' | 'messenger' | 'whatsapp' | 'tiktok' | 'snapchat' | 'foodics' | 'stripe'
  | 'paymob' | 'moyasar' | 'odoo' | 'wafeq' | 'qoyod' | 'zatca' | 'eta' | 'google-maps' | 'gemini' | 'resend'
  | 'twilio' | 'vercel';

export interface ProviderAsset {
  name: { en: string; ar: string };
  /** Path under the web app's public/ directory, or null for the monogram fallback. */
  src: string | null;
  /** Width / height of the artwork (1 for square marks, larger for wordmarks). */
  aspect: number;
  source: 'simple-icons' | 'official' | null;
  /** Letters for the monogram fallback. */
  monogram: string;
}

const mark = (en: string, file: string, monogram: string, ar = en): ProviderAsset =>
  ({ name: { en, ar }, src: `/brand/providers/${file}`, aspect: 1, source: 'simple-icons', monogram });
const fallback = (en: string, ar: string, monogram: string): ProviderAsset => ({ name: { en, ar }, src: null, aspect: 1, source: null, monogram });

export const PROVIDER_LOGOS: Record<ProviderId, ProviderAsset> = {
  meta: mark('Meta', 'meta.svg', 'M'),
  facebook: mark('Facebook', 'facebook.svg', 'F'),
  instagram: mark('Instagram', 'instagram.svg', 'IG'),
  messenger: mark('Messenger', 'messenger.svg', 'M'),
  whatsapp: mark('WhatsApp', 'whatsapp.svg', 'W', 'واتساب'),
  tiktok: mark('TikTok', 'tiktok.svg', 'T'),
  snapchat: mark('Snapchat', 'snapchat.svg', 'S'),
  foodics: { name: { en: 'Foodics', ar: 'فودكس' }, src: '/brand/providers/foodics.svg', aspect: 194.141 / 26.235, source: 'official', monogram: 'F' },
  stripe: mark('Stripe', 'stripe.svg', 'S'),
  paymob: { name: { en: 'Paymob', ar: 'باي موب' }, src: '/landing/logo-paymob.png', aspect: 320 / 74, source: 'official', monogram: 'P' },
  moyasar: fallback('Moyasar', 'ميسر', 'M'),
  odoo: mark('Odoo', 'odoo.svg', 'O', 'أودو'),
  wafeq: fallback('Wafeq', 'وافق', 'W'),
  qoyod: fallback('Qoyod', 'قيود', 'Q'),
  zatca: fallback('ZATCA', 'هيئة الزكاة والضريبة والجمارك', 'Z'),
  eta: fallback('Egyptian Tax Authority', 'مصلحة الضرائب المصرية', 'ETA'),
  'google-maps': mark('Google Maps', 'google-maps.svg', 'G', 'خرائط Google'),
  gemini: mark('Gemini', 'gemini.svg', 'G'),
  resend: mark('Resend', 'resend.svg', 'R'),
  twilio: fallback('Twilio', 'Twilio', 'T'),
  vercel: mark('Vercel', 'vercel.svg', 'V'),
};

/** Providers drawn as a monogram until their official artwork is added. */
export const needsOfficialAsset = (Object.keys(PROVIDER_LOGOS) as ProviderId[]).filter((k) => PROVIDER_LOGOS[k].src === null);

export const providerName = (id: ProviderId, locale: UiLocale = 'en') => PROVIDER_LOGOS[id].name[locale];

/**
 * A provider's logo at `size` px tall (wordmarks keep their proportions). `alt` defaults to the provider's name in the
 * page language; pass `decorative` when the name is printed next to it.
 */
export function ProviderLogo({ provider, size = 24, alt, decorative, locale, className }: {
  provider: ProviderId; size?: number; alt?: string; decorative?: boolean; locale?: UiLocale; className?: string;
}) {
  const ctx = useUiLocale();
  const asset = PROVIDER_LOGOS[provider];
  const label = alt ?? asset.name[locale ?? ctx];
  const cls = ['rui-provider', className].filter(Boolean).join(' ');
  if (!asset.src) {
    return (
      <span className={cls} data-provider={provider} data-fallback="" role={decorative ? undefined : 'img'} aria-label={decorative ? undefined : label}
        aria-hidden={decorative || undefined} style={{ ['--provider-size' as string]: `${size}px` }}>
        <span className="rui-provider-monogram" dir="ltr" aria-hidden="true">{asset.monogram}</span>
      </span>
    );
  }
  return (
    <img className={cls} data-provider={provider} src={asset.src} alt={decorative ? '' : label} height={size} width={Math.round(size * asset.aspect)}
      loading="lazy" decoding="async" />
  );
}
