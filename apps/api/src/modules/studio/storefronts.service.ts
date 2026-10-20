import { Injectable } from '@nestjs/common';
import type { PublicStorefront, StorefrontView, UpsertStorefront } from '@resuto/contracts';
import type { TenantContext } from '../../common/auth/context';
import { DbService, type Tx } from '../../common/db/db.service';
import { conflict, DomainError, invalid, notFound } from '../../common/errors/domain-error';
import { AuditService } from '../../common/platform/audit.service';
import { SiteBuilderService } from './site-builder.service';

/** Ink and paper fall back to near-black and a warm white, so a brand only has to choose its two colours. */
const DEFAULT_INK = '#17120f';
const DEFAULT_PAPER = '#fff8ed';
const storefrontNotFound = () => new DomainError('not_found', 'Storefront not found', 404);

interface Row {
  branch_id: string; org_id: string; slug: string; brand_name: string; brand_name_ar: string | null; tagline: any; theme: any;
  logo_media_id: string | null; hero_media_id: string | null; content: any; is_published: boolean; updated_at: Date;
}
const view = (r: Row): StorefrontView => ({
  branchId: r.branch_id, slug: r.slug, brandName: r.brand_name, brandNameAr: r.brand_name_ar, tagline: r.tagline ?? {},
  theme: r.theme, logoMediaId: r.logo_media_id, heroMediaId: r.hero_media_id, content: r.content ?? {}, isPublished: r.is_published,
  updatedAt: new Date(r.updated_at).toISOString(),
});

/**
 * Branch storefront branding (audit VP-05): a branch that trades under its own brand gets its own name, colours, logo,
 * hero and copy, published under the restaurant website. Only branding lives here; the storefront's menu, prices,
 * availability and ordering are the branch's live web menu and order API, so a storefront can never show a dish or a
 * price the branch does not sell.
 */
@Injectable()
export class StorefrontsService {
  constructor(private readonly db: DbService, private readonly audit: AuditService, private readonly builder: SiteBuilderService) {}

  list(ctx: TenantContext): Promise<StorefrontView[]> {
    return this.db.scoped(ctx, async (tx) => (await tx.query<Row>('select * from branch_storefronts where org_id = $1 order by brand_name', [ctx.orgId])).map(view));
  }

  get(ctx: TenantContext, branchId: string): Promise<StorefrontView> {
    return this.db.scoped(ctx, async (tx) => {
      const row = await tx.maybeOne<Row>('select * from branch_storefronts where branch_id = $1 and org_id = $2', [branchId, ctx.orgId]);
      if (!row) throw notFound('Storefront');
      return view(row);
    });
  }

  upsert(ctx: TenantContext, branchId: string, input: UpsertStorefront): Promise<StorefrontView> {
    return this.db.scoped(ctx, async (tx) => {
      const branch = await tx.maybeOne<{ id: string }>('select id from branches where id = $1 and org_id = $2', [branchId, ctx.orgId]);
      if (!branch) throw notFound('Branch');
      await this.assertRefs(tx, ctx.orgId, input);
      const taken = await tx.maybeOne<{ branch_id: string }>('select branch_id from branch_storefronts where org_id = $1 and slug = $2 and branch_id <> $3', [ctx.orgId, input.slug, branchId]);
      if (taken) throw conflict('storefront_slug_taken', 'Another branch already uses this storefront address');
      const row = await tx.one<Row>(
        `insert into branch_storefronts (branch_id, org_id, slug, brand_name, brand_name_ar, tagline, theme, logo_media_id, hero_media_id, content, is_published)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         on conflict (branch_id) do update set slug = excluded.slug, brand_name = excluded.brand_name, brand_name_ar = excluded.brand_name_ar,
           tagline = excluded.tagline, theme = excluded.theme, logo_media_id = excluded.logo_media_id, hero_media_id = excluded.hero_media_id,
           content = excluded.content, is_published = excluded.is_published
         returning *`,
        [branchId, ctx.orgId, input.slug, input.brandName, input.brandNameAr ?? null, input.tagline ?? {}, input.theme,
          input.logoMediaId ?? null, input.heroMediaId ?? null, input.content ?? {}, input.isPublished]);
      await this.audit.record(tx, ctx, { action: 'storefront.saved', entityType: 'branch', entityId: branchId, metadata: { slug: input.slug, published: input.isPublished } });
      return view(row);
    });
  }

  /** Public storefront branding by restaurant slug + storefront slug; only published storefronts of active branches. */
  async bySlug(orgSlug: string, storefrontSlug: string): Promise<PublicStorefront> {
    if (!/^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/.test(orgSlug) || !/^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/.test(storefrontSlug)) throw storefrontNotFound();
    const org = await this.db.withPlatform((tx) => tx.maybeOne<{ id: string }>(
      `select id from organizations where slug = $1 and status in ('onboarding', 'active')`, [orgSlug]));
    if (!org) throw storefrontNotFound();
    return this.db.withTenant(org.id, async (tx) => {
      const r = await tx.maybeOne<Row & { org_slug: string; org_name: string; org_name_ar: string | null; currency: string; demo: boolean;
        code: string; name: string; name_ar: string | null; city: string | null; accepts_pickup: boolean; accepts_delivery: boolean; opening_hours: unknown; timezone: string }>(
        `select s.*, o.slug as org_slug, o.name as org_name, o.name_ar as org_name_ar, o.currency,
                coalesce((o.onboarding->>'demo')::boolean, false) as demo,
                b.code, b.name, b.name_ar, b.city, b.accepts_pickup, b.accepts_delivery, b.opening_hours, coalesce(b.timezone, o.timezone) as timezone
           from branch_storefronts s join branches b on b.id = s.branch_id join organizations o on o.id = s.org_id
          where s.org_id = $1 and s.slug = $2 and s.is_published and b.is_active`, [org.id, storefrontSlug]);
      if (!r) throw storefrontNotFound();
      const media = await this.builder.mediaMap(tx, org.id, [r.logo_media_id, r.hero_media_id].filter((x): x is string => !!x));
      const order = `/order/${r.org_slug}?branch=${encodeURIComponent(r.code)}`;
      return {
        slug: r.slug,
        org: { slug: r.org_slug, name: r.org_name, nameAr: r.org_name_ar, currency: r.currency, demo: r.demo },
        branch: { id: r.branch_id, code: r.code, name: r.name, nameAr: r.name_ar, city: r.city, acceptsPickup: r.accepts_pickup, acceptsDelivery: r.accepts_delivery, openingHours: r.opening_hours, timezone: r.timezone },
        brand: {
          name: r.brand_name, nameAr: r.brand_name_ar, tagline: r.tagline ?? {},
          primaryColor: r.theme.primaryColor, accentColor: r.theme.accentColor, inkColor: r.theme.inkColor ?? DEFAULT_INK, paperColor: r.theme.paperColor ?? DEFAULT_PAPER,
          logoUrl: r.logo_media_id ? media.get(r.logo_media_id)?.url ?? null : null,
          heroUrl: r.hero_media_id ? media.get(r.hero_media_id)?.url ?? null : null,
        },
        content: r.content ?? {},
        links: { site: `/r/${r.org_slug}`, order, menu: `/v1/public/order/${r.org_slug}?branch=${encodeURIComponent(r.code)}` },
      };
    }, 'guest:storefront');
  }

  private async assertRefs(tx: Tx, orgId: string, input: UpsertStorefront) {
    const media = [input.logoMediaId, input.heroMediaId].filter((x): x is string => !!x);
    if (media.length) {
      const { n } = await tx.one<{ n: number }>('select count(distinct id)::int as n from media_assets where org_id = $1 and id = any($2::uuid[])', [orgId, media]);
      if (n !== new Set(media).size) throw invalid('unknown_media', 'One or more images do not exist in your media library');
    }
    const categories = [...new Set([...(input.content.sections ?? []).map((s) => s.categoryId), ...(input.content.promo?.ctaCategoryId ? [input.content.promo.ctaCategoryId] : [])])];
    if (categories.length) {
      const { n } = await tx.one<{ n: number }>('select count(*)::int as n from menu_categories where org_id = $1 and id = any($2::uuid[])', [orgId, categories]);
      if (n !== categories.length) throw invalid('unknown_category', 'One or more menu categories do not exist');
    }
    const products = [...new Set(input.content.promo?.productIds ?? [])];
    if (products.length) {
      const { n } = await tx.one<{ n: number }>('select count(*)::int as n from products where org_id = $1 and id = any($2::uuid[]) and is_active', [orgId, products]);
      if (n !== products.length) throw invalid('unknown_product', 'One or more menu items do not exist');
    }
  }
}
