import { Injectable } from '@nestjs/common';
import type { BrandPublishResult, BrandView, ThemePreset, UpdateBrand, WebsiteTemplate, WebsiteTheme } from '@resuto/contracts';
import type { TenantContext } from '../../common/auth/context';
import { DbService, type Tx } from '../../common/db/db.service';
import { EntitlementsService } from '../../common/entitlements/entitlements.service';
import { invalid, notFound } from '../../common/errors/domain-error';
import { AuditService } from '../../common/platform/audit.service';
import { StorageService } from '../../common/storage/storage.service';
import { PRIVATE_MEDIA_SOURCES, StudioService } from './studio.service';

/** Colours the site uses when neither the restaurant nor a preset chose any (SiteBuilderService DEFAULT_THEME). */
const DEFAULT = { primaryColor: '#173f36', accentColor: '#C85E33', backgroundColor: '#faf9f5', font: 'manrope' as const };
const LOGO_URL_TTL_SECONDS = 3600;

const toPreset = (r: any): ThemePreset => ({
  id: r.id,
  name: { en: r.name_en, ar: r.name_ar },
  description: { en: r.description_en, ar: r.description_ar },
  template: r.template as WebsiteTemplate,
  websiteTheme: r.website_theme,
  storefrontTheme: r.storefront_theme,
});

/**
 * studio_basic (21-ONB increment 2, plan §6.2/§7): the part of the restaurant site every plan may change, inside the
 * core module: the logo, the three site colours, a theme preset, and publishing the site (social links are
 * OnboardingService). It edits the same website draft and publishes the same revisions as the Studio, but only these
 * fields: hero images, taglines, SEO, sections, storefronts, domains, photos and creative stay behind the studio
 * module (StudioController, @RequiresModule('studio')).
 */
@Injectable()
export class BrandService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly studio: StudioService,
    private readonly entitlements: EntitlementsService,
  ) {}

  presets(ctx: TenantContext): Promise<{ items: ThemePreset[] }> {
    return this.db.scoped(ctx, async (tx) => ({
      items: (await tx.query('select * from theme_presets where is_active order by sort_order, id')).map(toPreset),
    }));
  }

  async view(ctx: TenantContext): Promise<BrandView> {
    const { view, logoPath } = await this.db.scoped(ctx, (tx) => this.read(tx, ctx));
    return this.finish(ctx, view, logoPath);
  }

  /**
   * Applies a preset and/or colours and/or the logo to the website draft (published on the next publish). A preset sets
   * its colours, font and template; colours sent with it win over the preset's. Every other theme field (hero image,
   * tagline) is kept as it is.
   */
  async update(ctx: TenantContext, input: UpdateBrand): Promise<BrandView> {
    const { view, logoPath } = await this.db.scoped(ctx, async (tx) => {
      const site = await tx.maybeOne<any>('select id, template, theme, theme_preset_id from websites where org_id = $1 for update', [ctx.orgId]);
      if (!site) throw notFound('Website');
      let preset: ThemePreset | null = null;
      if (input.presetId) {
        const row = await tx.maybeOne('select * from theme_presets where id = $1 and is_active', [input.presetId]);
        if (!row) throw invalid('unknown_theme_preset', 'Choose one of the theme presets');
        preset = toPreset(row);
      }
      if (input.logoMediaId) await this.assertLogo(tx, ctx, input.logoMediaId);
      const theme: WebsiteTheme = { ...(site.theme ?? {}) };
      if (preset) Object.assign(theme, preset.websiteTheme);
      for (const k of ['primaryColor', 'accentColor', 'backgroundColor'] as const) if (input[k]) theme[k] = input[k];
      if (input.logoMediaId !== undefined) theme.logoMediaId = input.logoMediaId;
      const presetId = input.presetId === undefined ? site.theme_preset_id : input.presetId;
      await tx.query(
        `update websites set template = $2, theme = $3, theme_preset_id = $4, draft_revision = draft_revision + 1 where id = $1`,
        [site.id, preset?.template ?? site.template, theme, presetId]);
      await this.audit.record(tx, ctx, {
        action: 'website.brand_updated', entityType: 'website', entityId: site.id,
        metadata: { fields: Object.keys(input), presetId: presetId ?? null, scope: 'studio_basic' },
      });
      return this.read(tx, ctx);
    });
    return this.finish(ctx, view, logoPath);
  }

  /** Uploads an image (the existing storage service, as the Studio media library does) and makes it the site logo. */
  async uploadLogo(ctx: TenantContext, file: { buffer: Buffer; mimetype: string } | undefined): Promise<BrandView> {
    const media = await this.studio.upload(ctx, file, 'Logo');
    return this.update(ctx, { logoMediaId: media.id });
  }

  /** Publishes the website draft as a new revision (StudioService.publish: idempotent by key, audited, outbox event). */
  async publish(ctx: TenantContext, key: string): Promise<BrandPublishResult> {
    const result = await this.studio.publish(ctx, key, 'Published from onboarding (studio_basic)') as { revision: number; publishedAt: string };
    const { slug } = await this.db.scoped(ctx, (tx) => tx.one<{ slug: string }>('select slug from organizations where id = $1', [ctx.orgId]));
    return { revision: result.revision, publishedAt: result.publishedAt, links: links(slug) };
  }

  private async read(tx: Tx, ctx: TenantContext) {
    const row = await tx.maybeOne<any>(
      `select w.template, w.theme, w.theme_preset_id, w.status, w.published_revision, w.published_at, w.draft_revision, o.slug,
              (select r.snapshot->>'draftRevision' from website_revisions r where r.website_id = w.id order by r.revision desc limit 1) as last_draft,
              m.path as logo_path
         from websites w join organizations o on o.id = w.org_id
         left join media_assets m on m.id = (w.theme->>'logoMediaId')::uuid and m.org_id = w.org_id
        where w.org_id = $1`, [ctx.orgId]);
    if (!row) throw notFound('Website');
    const theme = row.theme ?? {};
    const view: BrandView = {
      presetId: row.theme_preset_id ?? null,
      template: row.template,
      theme: {
        primaryColor: theme.primaryColor ?? DEFAULT.primaryColor, accentColor: theme.accentColor ?? DEFAULT.accentColor,
        backgroundColor: theme.backgroundColor ?? DEFAULT.backgroundColor, font: theme.font ?? DEFAULT.font, logoMediaId: theme.logoMediaId ?? null,
      },
      logoUrl: null,
      website: {
        status: row.status, publishedRevision: row.published_revision, publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
        hasUnpublishedChanges: row.last_draft === null || Number(row.last_draft) !== row.draft_revision,
      },
      links: links(row.slug),
      scope: 'studio_basic',
    };
    return { view, logoPath: row.logo_path as string | null };
  }

  /** After the transaction: the signed logo URL (PCL-11) and whether the full Studio is on the plan. */
  private async finish(ctx: TenantContext, view: BrandView, logoPath: string | null): Promise<BrandView> {
    const [logoUrl, studio] = await Promise.all([
      logoPath ? this.storage.signedUrl(logoPath, LOGO_URL_TTL_SECONDS).catch(() => null) : Promise.resolve(null),
      this.entitlements.isEnabled(ctx.orgId, 'studio'),
    ]);
    return { ...view, logoUrl, scope: studio ? 'studio' : 'studio_basic' };
  }

  private async assertLogo(tx: Tx, ctx: TenantContext, mediaId: string) {
    const ok = await tx.maybeOne(
      `select 1 from media_assets where org_id = $1 and id = $2 and content_type like 'image/%' and source <> all($3::text[])`,
      [ctx.orgId, mediaId, PRIVATE_MEDIA_SOURCES]);
    if (!ok) throw invalid('unknown_media', 'One or more images do not exist in your media library', { mediaIds: [mediaId] });
  }
}

const links = (slug: string) => ({ site: `/r/${slug}`, menu: `/m/${slug}` });
