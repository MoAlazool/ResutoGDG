import type { CreativeView, SectionContent, WebsiteSeo, WebsiteTemplate, WebsiteTheme } from '@resuto/contracts';

/** The publishable part of a website: what a revision snapshot stores. */
export interface SiteDocument {
  template: WebsiteTemplate;
  theme: WebsiteTheme;
  seo: WebsiteSeo;
  draftRevision: number;
  sections: Array<{ id: string; kind: string; sortOrder: number; content: SectionContent }>;
}

export const toWebsite = (r: any) => ({
  id: r.id,
  template: r.template as WebsiteTemplate,
  theme: (r.theme ?? {}) as WebsiteTheme,
  seo: (r.seo ?? {}) as WebsiteSeo,
  status: r.status as 'draft' | 'published',
  draftRevision: r.draft_revision as number,
  publishedRevision: r.published_revision as number,
  publishedAt: r.published_at ? new Date(r.published_at).toISOString() : null,
  updatedAt: new Date(r.updated_at).toISOString(),
});

export const toSection = (r: any) => ({
  id: r.id,
  kind: r.kind,
  sortOrder: r.sort_order as number,
  isVisible: r.is_visible as boolean,
  content: (r.content ?? {}) as SectionContent,
  updatedAt: new Date(r.updated_at).toISOString(),
});

export const toMedia = (r: any, url: string, inUse: boolean) => ({
  id: r.id,
  url,
  contentType: r.content_type,
  byteSize: Number(r.byte_size),
  width: r.width,
  height: r.height,
  alt: r.alt,
  altAr: r.alt_ar,
  source: r.source,
  inUse,
  createdAt: new Date(r.created_at).toISOString(),
});

export const toCreative = (r: any): CreativeView => ({
  id: r.id,
  kind: r.kind,
  locale: r.locale,
  prompt: r.prompt,
  output: r.output,
  provider: r.provider,
  model: r.model,
  isFallback: r.is_fallback,
  status: r.status,
  // Honest authorship label (FT-16): templates are never presented as AI; a model result names its key's owner.
  authorship: {
    mode: r.is_fallback ? 'template' : 'model',
    provider: r.provider,
    model: r.model ?? null,
    keySource: r.is_fallback ? null : r.key_source ?? 'resuto',
    fallbackCode: !r.is_fallback ? null
      : r.output?.fallbackCode ?? (/request failed/i.test(String(r.output?.fallbackReason ?? '')) ? 'model_failed' : 'not_configured'),
  },
  applications: Array.isArray(r.applications) ? r.applications : [],
  reviewedBy: r.reviewed_by ?? null,
  reviewedAt: r.reviewed_at ? new Date(r.reviewed_at).toISOString() : null,
  createdAt: new Date(r.created_at).toISOString(),
});

/** Every media id a site document references (theme, SEO and section content). */
export function referencedMedia(doc: Pick<SiteDocument, 'theme' | 'seo' | 'sections'>): string[] {
  const ids = new Set<string>();
  const add = (v: string | null | undefined) => { if (v) ids.add(v); };
  add(doc.theme?.logoMediaId);
  add(doc.theme?.heroMediaId);
  add(doc.seo?.ogMediaId);
  for (const s of doc.sections) {
    add(s.content?.mediaId);
    for (const m of s.content?.mediaIds ?? []) add(m);
  }
  return [...ids];
}
