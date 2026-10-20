import { Injectable } from '@nestjs/common';
import type { PublicSite, PublicSiteSection, SectionKind } from '@resuto/contracts';
import type { Tx } from '../../common/db/db.service';
import { MediaUrls, StorageService } from '../../common/storage/storage.service';
import type { SiteDocument } from './studio.mappers';

const DEFAULT_THEME = { primaryColor: '#173f36', accentColor: '#C85E33', backgroundColor: '#faf9f5' } as const;
const SMASH_THEME = { primaryColor: '#b51218', accentColor: '#ffd52f', backgroundColor: '#fff8ed' } as const;
const MEDIA_TTL_SECONDS = 6 * 3600;
const HIGHLIGHT_LIMIT = 6;

/**
 * Builds the guest-facing website payload from a site document (a published
 * revision snapshot or, for staff previews, the current draft) plus live
 * read-model data: branches, menu highlights and media URLs. Only public
 * fields are selected — never costs, internal notes, QR tokens or stock.
 */
@Injectable()
export class SiteBuilderService {
  constructor(private readonly storage: StorageService) {}

  async build(tx: Tx, orgId: string, doc: SiteDocument, meta: { revision: number; publishedAt: string | null; preview: boolean }): Promise<PublicSite> {
    const org = await tx.one<any>('select slug, name, name_ar, currency, country, default_locale from organizations where id = $1', [orgId]);
    const sections = doc.sections.slice().sort((a, b) => a.sortOrder - b.sortOrder);

    const mediaIds = new Set<string>();
    for (const id of [doc.theme?.logoMediaId, doc.theme?.heroMediaId, doc.seo?.ogMediaId]) if (id) mediaIds.add(id);
    for (const s of sections) {
      if (s.content?.mediaId) mediaIds.add(s.content.mediaId);
      for (const m of s.content?.mediaIds ?? []) mediaIds.add(m);
    }
    // Every URL of the page is signed in one batch (PS-18): media rows and product images are read first.
    const urls = this.storage.urls(MEDIA_TTL_SECONDS);
    const media = await this.mediaMap(tx, orgId, [...mediaIds], urls, false);
    const urlOf = (id: string | null | undefined) => (id ? media.get(id)?.url ?? null : null);

    const branches = await tx.query<any>(
      `select id, code, name, name_ar, address, city, phone, latitude, longitude, opening_hours,
              accepts_dine_in, accepts_pickup, accepts_delivery, accepts_reservations
         from branches where org_id = $1 and is_active order by created_at`, [orgId]);

    const pinned = [...new Set(sections.filter((s) => s.kind === 'menu_highlights').flatMap((s) => s.content?.productIds ?? []))];
    const products = await tx.query<any>(
      `select p.id, p.name, p.name_ar, p.description, p.description_ar, p.price_minor, p.currency, p.dietary,
              p.image_url, ma.path as image_path, ma.variants as image_variants
         from products p
         join menu_categories c on c.id = p.category_id and c.is_active
         join menus m on m.id = c.menu_id and m.is_active
         left join media_assets ma on ma.id = p.image_media_id
        where p.org_id = $1 and p.is_active
          and (cardinality($2::uuid[]) = 0 or p.id = any($2::uuid[]))
        order by case when cardinality($2::uuid[]) > 0 then array_position($2::uuid[], p.id) end,
                 (p.image_url is not null or p.image_media_id is not null) desc, c.sort_order, p.sort_order, p.created_at
        limit $3`, [orgId, pinned, pinned.length || HIGHLIGHT_LIMIT]);
    const menuHighlights = products.map((p) => urls.set({
      id: p.id, name: p.name, nameAr: p.name_ar, description: p.description, descriptionAr: p.description_ar,
      priceMinor: Number(p.price_minor), currency: p.currency, dietary: p.dietary ?? [], imageUrl: null as string | null,
    }, 'imageUrl', p.image_path, { fallback: safeImageUrl(p.image_url), variants: p.image_variants, minWidth: 640 }));
    await urls.resolve();
    for (const [id, m] of media) if (!m.url) media.delete(id);

    const domain = await tx.maybeOne<{ hostname: string }>(
      `select hostname from custom_domains where org_id = $1 and status = 'active' order by activated_at nulls last limit 1`, [orgId]);

    const base = doc.template === 'smash' ? SMASH_THEME : DEFAULT_THEME;
    return {
      slug: org.slug,
      revision: meta.revision,
      publishedAt: meta.publishedAt,
      preview: meta.preview,
      org: { name: org.name, nameAr: org.name_ar, currency: org.currency, country: org.country, defaultLocale: org.default_locale },
      template: doc.template,
      theme: {
        primaryColor: doc.theme?.primaryColor ?? base.primaryColor,
        accentColor: doc.theme?.accentColor ?? base.accentColor,
        backgroundColor: doc.theme?.backgroundColor ?? base.backgroundColor,
        font: doc.theme?.font ?? 'manrope',
        logoUrl: urlOf(doc.theme?.logoMediaId),
        heroUrl: urlOf(doc.theme?.heroMediaId),
      },
      seo: {
        title: doc.seo?.title ?? { en: org.name, ar: org.name_ar ?? org.name },
        description: doc.seo?.description ?? {},
        ogImageUrl: urlOf(doc.seo?.ogMediaId) ?? urlOf(doc.theme?.heroMediaId),
      },
      sections: sections.map((s): PublicSiteSection => ({
        id: s.id,
        kind: s.kind as SectionKind,
        content: {
          ...s.content,
          media: s.content?.mediaId && media.get(s.content.mediaId) ? media.get(s.content.mediaId)! : null,
          gallery: (s.content?.mediaIds ?? []).map((id) => media.get(id)).filter((m): m is { url: string; alt: string | null } => !!m),
        },
      })),
      branches: branches.map((b) => ({
        id: b.id, code: b.code, name: b.name, nameAr: b.name_ar, address: b.address, city: b.city, phone: b.phone,
        latitude: b.latitude === null ? null : Number(b.latitude), longitude: b.longitude === null ? null : Number(b.longitude),
        openingHours: b.opening_hours, acceptsDineIn: b.accepts_dine_in, acceptsPickup: b.accepts_pickup,
        acceptsDelivery: b.accepts_delivery, acceptsReservations: b.accepts_reservations,
      })),
      menuHighlights,
      canonicalHost: domain?.hostname ?? null,
      links: { reserve: `/reserve/${org.slug}`, order: `/order/${org.slug}`, site: `/r/${org.slug}` },
    };
  }

  /**
   * Media by id with signed URLs (site imagery: the 1280 px derivative when there is one). With a collector the URLs
   * are filled when the caller resolves it; otherwise they are signed here in one batch.
   */
  async mediaMap(tx: Tx, orgId: string, ids: string[], urls?: MediaUrls, resolve = true) {
    const out = new Map<string, { url: string; alt: string | null }>();
    if (!ids.length) return out;
    const own = urls ?? this.storage.urls(MEDIA_TTL_SECONDS);
    const rows = await tx.query<any>('select id, path, alt, variants from media_assets where org_id = $1 and id = any($2::uuid[])', [orgId, ids]);
    for (const r of rows) out.set(r.id, own.set({ url: '', alt: r.alt as string | null }, 'url', r.path, { variants: r.variants, minWidth: 1280 }) as { url: string; alt: string | null });
    if (resolve) {
      await own.resolve();
      for (const [id, m] of out) if (!m.url) out.delete(id);
    }
    return out;
  }
}

/** Only absolute https URLs or site-relative paths are passed through to guests. */
function safeImageUrl(url: string | null): string | null {
  if (!url) return null;
  return /^https:\/\//i.test(url) || /^\/(?!\/)/.test(url) ? url : null;
}
