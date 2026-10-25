// Studio templates (21-STUDIO, plan §6.4): style families × layout variants built from section kinds. A family sets the
// renderer (olive, smash or minimal), its colours and heading font; a variant is the list of section kinds a site
// starts from. Applying one (POST /o/:orgId/studio/website/template) restyles the draft and adds the variant's missing
// sections; it never deletes a section. Zod-free (also exported from '@resuto/contracts/lite').
//
// Theme presets for the Free QR menu (theme_presets, 21-ONB) are a separate, smaller set owned by onboarding.
import type { SectionKind, WebsiteTemplate } from './studio';

export const TEMPLATE_VARIANTS = ['full', 'menu_first', 'offers_led'] as const;
export type TemplateVariantKey = (typeof TEMPLATE_VARIANTS)[number];

export interface TemplateFamily {
  key: string;
  renderer: WebsiteTemplate;
  theme: { primaryColor: string; accentColor: string; backgroundColor: string; font: 'manrope' | 'editorial' };
  /** Section kinds per variant, in page order. */
  variants: Record<TemplateVariantKey, readonly SectionKind[]>;
}

const FULL: readonly SectionKind[] = ['hero', 'about', 'menu_highlights', 'gallery', 'reservations', 'testimonials', 'faq', 'location', 'social'];
const MENU_FIRST: readonly SectionKind[] = ['hero', 'menu_full', 'hours', 'location', 'social'];
const OFFERS_LED: readonly SectionKind[] = ['promo_banner', 'hero', 'offers', 'menu_highlights', 'ordering', 'faq', 'social'];

export const TEMPLATE_FAMILIES: readonly TemplateFamily[] = [
  { key: 'bistro', renderer: 'olive', theme: { primaryColor: '#173f36', accentColor: '#c85e33', backgroundColor: '#faf9f5', font: 'editorial' },
    variants: { full: FULL, menu_first: MENU_FIRST, offers_led: OFFERS_LED } },
  { key: 'street_food', renderer: 'smash', theme: { primaryColor: '#b51218', accentColor: '#ffd52f', backgroundColor: '#fff8ed', font: 'manrope' },
    variants: { full: ['hero', 'menu_highlights', 'ordering', 'gallery', 'location', 'social'], menu_first: MENU_FIRST, offers_led: OFFERS_LED } },
  { key: 'cafe', renderer: 'minimal', theme: { primaryColor: '#5b3a29', accentColor: '#c08552', backgroundColor: '#fbf7f2', font: 'manrope' },
    variants: { full: ['hero', 'about', 'menu_highlights', 'gallery', 'hours', 'location', 'social'], menu_first: MENU_FIRST, offers_led: OFFERS_LED } },
  { key: 'fine_dining', renderer: 'olive', theme: { primaryColor: '#1f2a24', accentColor: '#b08d57', backgroundColor: '#f7f4ee', font: 'editorial' },
    variants: { full: ['hero', 'about', 'menu_highlights', 'reservations', 'gallery', 'testimonials', 'faq', 'location'], menu_first: ['hero', 'menu_full', 'reservations', 'location'],
      offers_led: ['hero', 'promo_banner', 'offers', 'reservations', 'faq', 'location'] } },
  { key: 'bakery', renderer: 'minimal', theme: { primaryColor: '#7a3e48', accentColor: '#e0a96d', backgroundColor: '#fff9f5', font: 'editorial' },
    variants: { full: ['hero', 'about', 'menu_highlights', 'ordering', 'hours', 'location', 'social'], menu_first: MENU_FIRST, offers_led: OFFERS_LED } },
  { key: 'cloud_kitchen', renderer: 'smash', theme: { primaryColor: '#14532d', accentColor: '#f59e0b', backgroundColor: '#f8faf5', font: 'manrope' },
    variants: { full: ['hero', 'ordering', 'menu_highlights', 'offers', 'faq', 'social'], menu_first: ['hero', 'menu_full', 'ordering', 'faq'], offers_led: OFFERS_LED } },
  { key: 'family', renderer: 'olive', theme: { primaryColor: '#1e3a5f', accentColor: '#e07a5f', backgroundColor: '#fdfaf6', font: 'manrope' },
    variants: { full: ['hero', 'about', 'menu_highlights', 'reservations', 'ordering', 'hours', 'location', 'faq', 'social'], menu_first: MENU_FIRST, offers_led: OFFERS_LED } },
];

export const templateFamily = (key: string) => TEMPLATE_FAMILIES.find((f) => f.key === key) ?? null;

/** The section kinds a variant adds to a draft that already has `existing` (in the variant's order, no duplicates). */
export function missingSectionKinds(variant: readonly SectionKind[], existing: readonly string[]): SectionKind[] {
  const have = new Set(existing);
  return variant.filter((k, i) => !have.has(k) && variant.indexOf(k) === i);
}
