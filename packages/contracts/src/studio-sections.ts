// Website section kinds and their content rules (21-STUDIO). Zod-free: the editor imports these from
// '@resuto/contracts/lite' so its bundle (and every page sharing the full contracts module) does not grow with them;
// studio.ts builds the request schemas from the same lists.

export const SECTION_KINDS = [
  'hero', 'about', 'menu_highlights', 'gallery', 'reservations', 'ordering', 'location', 'hours', 'testimonials', 'contact', 'custom',
  // 21-STUDIO: a promotional banner, offers (dishes with their discount badges), social links, questions and answers, the
  // whole menu as text.
  'promo_banner', 'offers', 'social', 'faq', 'menu_full',
] as const;
export type SectionKind = (typeof SECTION_KINDS)[number];

/** Section-level layout from the inspector: alignment, vertical spacing, surface tone and grid columns. */
export const SECTION_ALIGNS = ['start', 'center'] as const;
export const SECTION_SPACINGS = ['compact', 'normal', 'roomy'] as const;
export const SECTION_TONES = ['default', 'muted', 'accent', 'contrast'] as const;

/**
 * Content fields each 21-STUDIO section kind accepts (the older kinds keep accepting every field, as before). Copy
 * fields (eyebrow, headline, body, ctaLabel) and `layout` are open to all of them.
 */
export const SECTION_KIND_FIELDS: Partial<Record<SectionKind, readonly string[]>> = {
  promo_banner: ['mediaId', 'promotionCode', 'badge'],
  offers: ['productIds', 'promotionCode', 'badge'],
  social: [],
  faq: ['items'],
  menu_full: ['categoryIds'],
};
const COPY_FIELDS = ['eyebrow', 'headline', 'body', 'ctaLabel', 'layout'];

/** Why a section's content does not fit its kind (empty when it does). Shared by the API and the editor. */
export function sectionContentIssues(kind: string, content: Record<string, unknown>): Array<{ path: string; message: string }> {
  const allowed = SECTION_KIND_FIELDS[kind as SectionKind];
  if (!allowed) return [];
  const issues: Array<{ path: string; message: string }> = [];
  for (const [key, value] of Object.entries(content)) {
    if (value === undefined || COPY_FIELDS.includes(key) || allowed.includes(key)) continue;
    issues.push({ path: `content.${key}`, message: `A ${kind} section has no ${key}` });
  }
  if (kind === 'faq') {
    const items = (content.items ?? []) as Array<{ title?: { en?: string; ar?: string }; body?: { en?: string; ar?: string } }>;
    items.forEach((item, i) => {
      if (!item.title?.en && !item.title?.ar) issues.push({ path: `content.items.${i}.title`, message: 'Write the question in English or Arabic' });
      if (!item.body?.en && !item.body?.ar) issues.push({ path: `content.items.${i}.body`, message: 'Write the answer in English or Arabic' });
    });
  }
  return issues;
}
