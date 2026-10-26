import { Injectable } from '@nestjs/common';
import {
  socialLinksOf, type PublicSite, type PublicSiteProduct, type PublicSitePromotion, type PublicSiteSection, type PublicStorefrontLink, type SectionKind,
} from '@resuto/contracts';
import type { Tx } from '../../common/db/db.service';
import { MediaUrls, StorageService } from '../../common/storage/storage.service';
import type { SiteDocument } from './studio.mappers';

const DEFAULT_THEME = { primaryColor: '#173f36', accentColor: '#C85E33', backgroundColor: '#faf9f5' } as const;
const SMASH_THEME = { primaryColor: '#b51218', accentColor: '#ffd52f', backgroundColor: '#fff8ed' } as const;
const MEDIA_TTL_SECONDS = 6 * 3600;
const HIGHLIGHT_LIMIT = 6;
/** menu_full: at most this many dishes on the page (a long menu links to the ordering page for the rest). */
export const FULL_MENU_LIMIT = 200;

/**
 * What a change-set preview lays over the live data (21-STUDIO): dish prices a proposal changes and offers it creates,
 * so the canvas shows the page as it will be once approved. Never used for the published site.
 */
export interface SiteOverlay {
  prices?: Map<string, { priceMinor: number; compareAtMinor: number | null }>;
  promotions?: PublicSitePromotion[];
}

/**
 * A site built inside a transaction whose media URLs are not signed yet (PCL-11): the caller passes it to
 * SiteBuilderService.finish after the transaction, so no storage call runs while a pooled connection is held.
 */
export interface PendingSite {
  urls: MediaUrls;
  assemble: () => PublicSite;
}

/** Media entries whose URL could not be signed are left out (the image is omitted, as before). */
export function dropUnsigned<M extends { url: string | null }>(media: Map<string, M> | Record<string, M>) {
  if (media instanceof Map) { for (const [id, m] of media) if (!m.url) media.delete(id); }
  else for (const id of Object.keys(media)) if (!media[id]!.url) delete media[id];
}

/**
 * Builds the guest-facing website payload from a site document (a published
 * revision snapshot or, for staff previews, the current draft) plus live
 * read-model data: branches, menu highlights and media URLs. Only public
 * fields are selected — never costs, internal notes, QR tokens or stock.
 */
@Injectable()
export class SiteBuilderService {
  constructor(private readonly storage: StorageService) {}

  /**
   * Reads everything the site needs inside the caller's transaction and collects its media URLs without signing
   * them. Call finish() on the result after the transaction has returned.
   */
  async prepare(tx: Tx, orgId: string, doc: SiteDocument, meta: { revision: number; publishedAt: string | null; preview: boolean },
    overlay: SiteOverlay = {}): Promise<PendingSite> {
    const org = await tx.one<any>(
      `select slug, name, name_ar, currency, country, default_locale, social_links, coalesce((onboarding->>'demo')::boolean, false) as demo
         from organizations where id = $1`, [orgId]);
    const sections = doc.sections.slice().sort((a, b) => a.sortOrder - b.sortOrder);

    const mediaIds = new Set<string>();
    for (const id of [doc.theme?.logoMediaId, doc.theme?.heroMediaId, doc.seo?.ogMediaId]) if (id) mediaIds.add(id);
    for (const s of sections) {
      if (s.content?.mediaId) mediaIds.add(s.content.mediaId);
      for (const m of s.content?.mediaIds ?? []) mediaIds.add(m);
    }
    // Every URL of the page is signed in one batch (PS-18): media rows and product images are read first.
    const urls = this.storage.urls(MEDIA_TTL_SECONDS);
    const media = await this.mediaMap(tx, orgId, [...mediaIds], urls);
    const urlOf = (id: string | null | undefined) => (id ? media.get(id)?.url ?? null : null);

    const branches = await tx.query<any>(
      `select id, code, name, name_ar, address, city, phone, latitude, longitude, opening_hours,
              accepts_dine_in, accepts_pickup, accepts_delivery, accepts_reservations
         from branches where org_id = $1 and is_active order by created_at`, [orgId]);

    const pinned = [...new Set(sections.filter((s) => s.kind === 'menu_highlights').flatMap((s) => s.content?.productIds ?? []))];
    const storefronts = await this.storefrontLinks(tx, orgId, org.slug, urls);
    // Highlights are dishes guests can actually order (audit DF-09): active, in an active menu that serves an active
    // branch, and not switched off at every branch. Without pinned dishes, a branch that trades under its own brand
    // (a published storefront, e.g. Smash & Co) is presented by its storefront, so dishes sold only there stay off the
    // restaurant's own highlights. Pinned dishes keep the owner's order. Photos first.
    const storefrontBranches = storefronts.map((x) => x.branchId);
    const toProduct = (p: any): PublicSiteProduct => {
      const priced = overlay.prices?.get(p.id);
      const priceMinor = priced?.priceMinor ?? Number(p.price_minor);
      const was = priced ? priced.compareAtMinor : p.compare_at_price_minor === null ? null : Number(p.compare_at_price_minor);
      return urls.set({
        id: p.id, name: p.name, nameAr: p.name_ar, description: p.description, descriptionAr: p.description_ar,
        priceMinor, currency: p.currency, dietary: p.dietary ?? [], imageUrl: null as string | null,
        // Responsive copies as on the public menu (CR-12 / REM-W01): a phone's two-column card loads the 320 px copy.
        imageSrcSet: null as string | null,
        imageWidth: p.image_path ? p.image_width ?? null : null, imageHeight: p.image_path ? p.image_height ?? null : null,
        // Only a real reduction is shown as "was" (a later price edit above it ends the discount).
        compareAtMinor: was !== null && was > priceMinor ? was : null,
      }, 'imageUrl', p.image_path, { fallback: safeImageUrl(p.image_url), variants: p.image_variants, minWidth: 640, srcSetKey: 'imageSrcSet' });
    };
    const menuHighlights = (await this.orderable(tx, orgId, { ids: pinned, limit: pinned.length || HIGHLIGHT_LIMIT, skipBranches: storefrontBranches }))
      .map(toProduct);

    // 21-STUDIO sections: offers show their chosen dishes (orderable ones, in the owner's order) and the badge of a live
    // promotion named by code; the full menu lists every orderable dish by category.
    const offerSections = sections.filter((s) => s.kind === 'offers' && s.content?.productIds?.length);
    const offerIds = [...new Set(offerSections.flatMap((s) => s.content.productIds ?? []))];
    const offerRows = offerIds.length ? await this.orderable(tx, orgId, { ids: offerIds, limit: offerIds.length, skipBranches: [] }) : [];
    const offerById = new Map(offerRows.map((r) => [r.id as string, toProduct(r)]));
    const codes = [...new Set(sections.filter((s) => (s.kind === 'offers' || s.kind === 'promo_banner') && s.content?.promotionCode)
      .map((s) => String(s.content.promotionCode).toLowerCase()))];
    const promotions = codes.length ? await this.livePromotions(tx, orgId, codes) : new Map<string, PublicSitePromotion>();
    for (const p of overlay.promotions ?? []) if (p.code && !promotions.has(p.code.toLowerCase())) promotions.set(p.code.toLowerCase(), p);
    type FullMenu = NonNullable<PublicSiteSection['content']['menu']>;
    const fullMenus = new Map<string, FullMenu>();
    for (const s of sections.filter((x) => x.kind === 'menu_full')) {
      const rows = await this.orderable(tx, orgId, { ids: [], categoryIds: s.content?.categoryIds ?? [], limit: FULL_MENU_LIMIT, skipBranches: [], byCategory: true });
      const groups: FullMenu = [];
      for (const r of rows) {
        let g = groups.find((x) => x.id === r.category_id);
        if (!g) groups.push(g = { id: r.category_id, name: r.category_name, nameAr: r.category_name_ar, items: [] });
        g.items.push(toProduct(r));
      }
      fullMenus.set(s.id, groups);
    }

    const domain = await tx.maybeOne<{ hostname: string }>(
      `select hostname from custom_domains where org_id = $1 and status = 'active' order by activated_at nulls last limit 1`, [orgId]);

    const base = doc.template === 'smash' ? SMASH_THEME : DEFAULT_THEME;
    // Runs after urls.resolve(): every URL below is final by then.
    const assemble = (): PublicSite => {
      dropUnsigned(media);
      return {
        slug: org.slug,
        revision: meta.revision,
        publishedAt: meta.publishedAt,
        preview: meta.preview,
        org: { name: org.name, nameAr: org.name_ar, currency: org.currency, country: org.country, defaultLocale: org.default_locale, demo: org.demo === true,
          socialLinks: socialLinksOf(org.social_links) },
        template: doc.template,
        theme: {
          primaryColor: doc.theme?.primaryColor ?? base.primaryColor,
          accentColor: doc.theme?.accentColor ?? base.accentColor,
          backgroundColor: doc.theme?.backgroundColor ?? base.backgroundColor,
          font: doc.theme?.font ?? 'manrope',
          logoUrl: urlOf(doc.theme?.logoMediaId),
          heroUrl: urlOf(doc.theme?.heroMediaId),
          tagline: doc.theme?.tagline ?? {},
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
            gallery: (s.content?.mediaIds ?? []).map((id) => media.get(id)).filter((m): m is { url: string; alt: string | null; altAr: string | null } => !!m),
            ...(s.kind === 'offers' ? { products: (s.content?.productIds ?? []).map((id) => offerById.get(id)).filter((p): p is PublicSiteProduct => !!p) } : {}),
            ...((s.kind === 'offers' || s.kind === 'promo_banner')
              ? { promotion: s.content?.promotionCode ? promotions.get(String(s.content.promotionCode).toLowerCase()) ?? null : null } : {}),
            ...(s.kind === 'menu_full' ? { menu: fullMenus.get(s.id) ?? [] } : {}),
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
        storefronts: storefronts.map((x) => ({ ...x, logoUrl: x.logoUrl || null, heroUrl: x.heroUrl || null })),
      };
    };
    return { urls, assemble };
  }

  /**
   * Dishes guests can actually order (audit DF-09): active, in an active category of an active menu that serves an
   * active branch, and not switched off at every branch. With `ids`, those dishes in that order; without, dishes with
   * photos first, skipping dishes sold only at `skipBranches` (branches presented by their own storefront). `byCategory`
   * orders by category for the full menu. Public columns only (never cost or stock).
   */
  private orderable(tx: Tx, orgId: string, o: { ids: string[]; limit: number; skipBranches: string[]; categoryIds?: string[]; byCategory?: boolean }) {
    return tx.query<any>(
      `select p.id, p.name, p.name_ar, p.description, p.description_ar, p.price_minor, p.compare_at_price_minor, p.currency, p.dietary,
              p.image_url, ma.path as image_path, ma.variants as image_variants, ma.width as image_width, ma.height as image_height,
              c.id as category_id, c.name as category_name, c.name_ar as category_name_ar
         from products p
         join menu_categories c on c.id = p.category_id and c.is_active
         join menus m on m.id = c.menu_id and m.is_active
         left join media_assets ma on ma.id = p.image_media_id
        where p.org_id = $1 and p.is_active
          and (cardinality($2::uuid[]) = 0 or p.id = any($2::uuid[]))
          and (cardinality($5::uuid[]) = 0 or c.id = any($5::uuid[]))
          and exists (
            select 1 from branches b
             where b.org_id = p.org_id and b.is_active
               and (m.branch_id is null or m.branch_id = b.id)
               and not exists (select 1 from product_branch_settings s where s.product_id = p.id and s.branch_id = b.id and not s.is_available)
               and (cardinality($2::uuid[]) > 0 or not (b.id = any($4::uuid[]))))
        order by ${o.byCategory ? 'm.sort_order, c.sort_order, c.id, p.sort_order, p.created_at' : `case when cardinality($2::uuid[]) > 0 then array_position($2::uuid[], p.id) end,
                 (p.image_url is not null or p.image_media_id is not null) desc, c.sort_order, p.sort_order, p.created_at`}
        limit $3`, [orgId, o.ids, o.limit, o.skipBranches, o.categoryIds ?? []]);
  }

  /** Active promotions by code (lower case) that are running now and not used up: what an offers badge may show. */
  private async livePromotions(tx: Tx, orgId: string, codes: string[]): Promise<Map<string, PublicSitePromotion>> {
    const rows = await tx.query<any>(
      `select code::text as code, name, name_ar, kind, value, min_order_minor, ends_at from promotions
        where org_id = $1 and lower(code::text) = any($2::text[]) and is_active
          and (starts_at is null or starts_at <= now()) and (ends_at is null or ends_at > now())
          and (max_redemptions is null or redemption_count < max_redemptions)`, [orgId, codes]);
    return new Map(rows.map((r) => [String(r.code).toLowerCase(), {
      code: r.code, name: r.name, nameAr: r.name_ar, kind: r.kind, value: Number(r.value), minOrderMinor: Number(r.min_order_minor),
      endsAt: r.ends_at ? new Date(r.ends_at).toISOString() : null,
    } as PublicSitePromotion]));
  }

  /**
   * Published branch storefronts (audit VP-05) for the site's branch list and navigation. Logo/hero URLs are filled
   * when the caller resolves `urls` (after its transaction).
   */
  async storefrontLinks(tx: Tx, orgId: string, orgSlug: string, urls: MediaUrls): Promise<PublicStorefrontLink[]> {
    const rows = await tx.query<any>(
      `select s.slug, s.branch_id, s.brand_name, s.brand_name_ar, s.tagline, s.theme, s.logo_media_id, s.hero_media_id, b.code
         from branch_storefronts s join branches b on b.id = s.branch_id
        where s.org_id = $1 and s.is_published and b.is_active order by s.brand_name`, [orgId]);
    const media = await this.mediaMap(tx, orgId, rows.flatMap((r) => [r.logo_media_id, r.hero_media_id]).filter((x): x is string => !!x), urls);
    // Objects are read lazily (getters) so URLs signed later by urls.resolve() are picked up.
    return rows.map((r) => ({
      slug: r.slug, branchId: r.branch_id, branchCode: r.code, name: r.brand_name, nameAr: r.brand_name_ar, tagline: r.tagline ?? {},
      primaryColor: r.theme?.primaryColor, accentColor: r.theme?.accentColor,
      get logoUrl() { return r.logo_media_id ? media.get(r.logo_media_id)?.url || null : null; },
      get heroUrl() { return r.hero_media_id ? media.get(r.hero_media_id)?.url || null : null; },
      path: `/r/${orgSlug}/${r.slug}`,
    }));
  }

  /** Signs a prepared site's media URLs in one batch (after the transaction) and returns the finished payload. */
  async finish(pending: PendingSite): Promise<PublicSite> {
    await pending.urls.resolve();
    return pending.assemble();
  }

  /** A collector with the site media TTL (callers resolve it after their transaction). */
  urls() {
    return this.storage.urls(MEDIA_TTL_SECONDS);
  }

  /**
   * Media by id (site imagery: the 1280 px derivative when there is one). The URLs are filled when the caller
   * resolves `urls`, after its transaction; then dropUnsigned() removes entries that could not be signed.
   */
  async mediaMap(tx: Tx, orgId: string, ids: string[], urls: MediaUrls) {
    // altAr (22-STUDIO): the Arabic alt text, so an Arabic page describes its images in Arabic.
    const out = new Map<string, { url: string; alt: string | null; altAr: string | null }>();
    if (!ids.length) return out;
    const rows = await tx.query<any>('select id, path, alt, alt_ar, variants from media_assets where org_id = $1 and id = any($2::uuid[])', [orgId, ids]);
    for (const r of rows) {
      out.set(r.id, urls.set({ url: '', alt: r.alt as string | null, altAr: (r.alt_ar as string | null) ?? null }, 'url', r.path, { variants: r.variants, minWidth: 1280 }) as
        { url: string; alt: string | null; altAr: string | null });
    }
    return out;
  }
}

/** Only absolute https URLs or site-relative paths are passed through to guests. */
function safeImageUrl(url: string | null): string | null {
  if (!url) return null;
  return /^https:\/\//i.test(url) || /^\/(?!\/)/.test(url) ? url : null;
}
