import { Injectable } from '@nestjs/common';
import type { CreateSection, SectionContent, UpdateSection, UpdateWebsite } from '@resuto/contracts';
import type { TenantContext } from '../../common/auth/context';
import { DbService, type Tx } from '../../common/db/db.service';
import { conflict, invalid, notFound } from '../../common/errors/domain-error';
import { AuditService } from '../../common/platform/audit.service';
import { IdempotencyService } from '../../common/platform/idempotency.service';
import { StorageService } from '../../common/storage/storage.service';
import { SiteBuilderService } from './site-builder.service';
import { referencedMedia, toMedia, toSection, toWebsite, type SiteDocument } from './studio.mappers';

const MAX_SECTIONS = 30;

@Injectable()
export class StudioService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly storage: StorageService,
    private readonly builder: SiteBuilderService,
  ) {}

  // --- Website ---------------------------------------------------------------
  async get(ctx: TenantContext) {
    return this.db.scoped(ctx, async (tx) => this.view(tx, ctx));
  }

  async update(ctx: TenantContext, patch: UpdateWebsite) {
    return this.db.scoped(ctx, async (tx) => {
      const site = await this.site(tx, ctx, true);
      // theme and seo are replaced as whole documents (omitted keys fall back to template defaults).
      const theme = patch.theme ?? site.theme;
      const seo = patch.seo ?? site.seo;
      await this.assertMedia(tx, ctx, [theme.logoMediaId, theme.heroMediaId, seo.ogMediaId]);
      await tx.query(
        `update websites set template = $2, theme = $3, seo = $4, draft_revision = draft_revision + 1 where id = $1`,
        [site.id, patch.template ?? site.template, theme, seo]);
      await this.audit.record(tx, ctx, { action: 'website.updated', entityType: 'website', entityId: site.id, metadata: { fields: Object.keys(patch) } });
      return this.view(tx, ctx);
    });
  }

  // --- Sections --------------------------------------------------------------
  async createSection(ctx: TenantContext, input: CreateSection) {
    return this.db.scoped(ctx, async (tx) => {
      const site = await this.site(tx, ctx, true);
      const { n, max } = await tx.one<{ n: number; max: number | null }>(
        'select count(*)::int as n, max(sort_order) as max from website_sections where website_id = $1', [site.id]);
      if (n >= MAX_SECTIONS) throw invalid('too_many_sections', `A website can have at most ${MAX_SECTIONS} sections`);
      await this.assertContentRefs(tx, ctx, input.content);
      const row = await tx.one(
        `insert into website_sections(org_id, website_id, kind, sort_order, is_visible, content) values ($1, $2, $3, $4, $5, $6) returning *`,
        [ctx.orgId, site.id, input.kind, (max ?? -1) + 1, input.isVisible, input.content]);
      await this.touch(tx, site.id);
      await this.audit.record(tx, ctx, { action: 'website.section_created', entityType: 'website_section', entityId: row.id, metadata: { kind: input.kind } });
      return toSection(row);
    });
  }

  async updateSection(ctx: TenantContext, sectionId: string, patch: UpdateSection) {
    return this.db.scoped(ctx, async (tx) => {
      const existing = await tx.maybeOne<any>('select * from website_sections where id = $1 and org_id = $2 for update', [sectionId, ctx.orgId]);
      if (!existing) throw notFound('Section');
      if (patch.content) await this.assertContentRefs(tx, ctx, patch.content);
      const row = await tx.one(
        `update website_sections set content = coalesce($2, content), is_visible = coalesce($3, is_visible), updated_at = now()
          where id = $1 returning *`, [sectionId, patch.content ?? null, patch.isVisible ?? null]);
      await this.touch(tx, existing.website_id);
      await this.audit.record(tx, ctx, { action: 'website.section_updated', entityType: 'website_section', entityId: sectionId, metadata: { fields: Object.keys(patch) } });
      return toSection(row);
    });
  }

  async deleteSection(ctx: TenantContext, sectionId: string) {
    return this.db.scoped(ctx, async (tx) => {
      const row = await tx.maybeOne<any>('delete from website_sections where id = $1 and org_id = $2 returning website_id, kind', [sectionId, ctx.orgId]);
      if (!row) throw notFound('Section');
      await this.touch(tx, row.website_id);
      await this.audit.record(tx, ctx, { action: 'website.section_deleted', entityType: 'website_section', entityId: sectionId, metadata: { kind: row.kind } });
      return { deleted: true };
    });
  }

  async reorder(ctx: TenantContext, ids: string[]) {
    return this.db.scoped(ctx, async (tx) => {
      const site = await this.site(tx, ctx, true);
      const rows = await tx.query<{ id: string }>('select id from website_sections where website_id = $1', [site.id]);
      const current = new Set(rows.map((r) => r.id));
      if (ids.length !== current.size || new Set(ids).size !== ids.length || ids.some((id) => !current.has(id))) {
        throw invalid('section_order_mismatch', 'Send every section id exactly once');
      }
      await tx.query(
        `update website_sections s set sort_order = o.ord - 1 from unnest($2::uuid[]) with ordinality as o(id, ord)
          where s.id = o.id and s.website_id = $1`, [site.id, ids]);
      await this.touch(tx, site.id);
      await this.audit.record(tx, ctx, { action: 'website.sections_reordered', entityType: 'website', entityId: site.id });
      return this.view(tx, ctx);
    });
  }

  // --- Publish & revisions ------------------------------------------------------
  async publish(ctx: TenantContext, key: string, note?: string) {
    return this.db.scoped(ctx, async (tx) => {
      const site = await this.site(tx, ctx, true);
      return this.idempotency.run(tx, ctx.orgId, 'studio.publish', key, { note: note ?? null }, async () => {
        const doc = await this.document(tx, ctx, site, true);
        const missing = await this.missingMedia(tx, ctx, referencedMedia(doc));
        if (missing.length) throw invalid('media_missing', 'Some images used by the website were deleted. Replace them before publishing.', { mediaIds: missing });
        const revision = site.publishedRevision + 1;
        await tx.query(
          `insert into website_revisions(org_id, website_id, revision, snapshot, note, published_by) values ($1, $2, $3, $4, $5, $6)`,
          [ctx.orgId, site.id, revision, doc, note ?? null, ctx.userId]);
        const row = await tx.one(
          `update websites set status = 'published', published_revision = $2, published_at = now() where id = $1 returning published_at`, [site.id, revision]);
        await this.audit.record(tx, ctx, { action: 'website.published', entityType: 'website', entityId: site.id, metadata: { revision } });
        return { revision, publishedAt: new Date(row.published_at).toISOString() };
      });
    });
  }

  async revisions(ctx: TenantContext) {
    return this.db.scoped(ctx, async (tx) => {
      const site = await this.site(tx, ctx);
      const rows = await tx.query<any>(
        `select r.revision, r.note, r.published_at, r.published_by, p.full_name, p.email,
                jsonb_array_length(r.snapshot->'sections') as section_count
           from website_revisions r left join profiles p on p.id = r.published_by
          where r.website_id = $1 order by r.revision desc limit 50`, [site.id]);
      return {
        items: rows.map((r) => ({ revision: r.revision, note: r.note, publishedAt: new Date(r.published_at).toISOString(),
          publishedBy: r.full_name ?? r.email ?? null, sectionCount: r.section_count })),
        nextCursor: null,
      };
    });
  }

  /** Copies a published revision back into the draft (it is published again only on the next publish). */
  async restore(ctx: TenantContext, revision: number) {
    return this.db.scoped(ctx, async (tx) => {
      const site = await this.site(tx, ctx, true);
      const rev = await tx.maybeOne<{ snapshot: SiteDocument }>('select snapshot from website_revisions where website_id = $1 and revision = $2', [site.id, revision]);
      if (!rev) throw notFound('Revision');
      const snap = rev.snapshot;
      await tx.query('update websites set template = $2, theme = $3, seo = $4, draft_revision = draft_revision + 1 where id = $1',
        [site.id, snap.template, snap.theme ?? {}, snap.seo ?? {}]);
      await tx.query('delete from website_sections where website_id = $1', [site.id]);
      for (const [i, s] of snap.sections.entries()) {
        await tx.query(
          `insert into website_sections(id, org_id, website_id, kind, sort_order, is_visible, content) values ($1, $2, $3, $4, $5, true, $6)`,
          [s.id, ctx.orgId, site.id, s.kind, i, s.content ?? {}]);
      }
      await this.audit.record(tx, ctx, { action: 'website.revision_restored', entityType: 'website', entityId: site.id, metadata: { revision } });
      return this.view(tx, ctx);
    });
  }

  /** Staff preview: the draft rendered exactly like the public site. */
  async preview(ctx: TenantContext) {
    return this.db.scoped(ctx, async (tx) => {
      const site = await this.site(tx, ctx);
      const doc = await this.document(tx, ctx, site, true);
      return this.builder.build(tx, ctx.orgId, doc, { revision: site.publishedRevision, publishedAt: site.publishedAt, preview: true });
    });
  }

  // --- Media library -------------------------------------------------------------
  async listMedia(ctx: TenantContext, limit = 100) {
    return this.db.scoped(ctx, async (tx) => {
      const rows = await tx.query<any>(
        `select * from media_assets where org_id = $1 and content_type like 'image/%' order by created_at desc limit $2`, [ctx.orgId, Math.min(limit, 200)]);
      const used = await this.usedMedia(tx, ctx);
      const items = await Promise.all(rows.map(async (r) => toMedia(r, await this.storage.signedUrl(r.path, 3600), used.has(r.id))));
      return { items, nextCursor: null };
    });
  }

  async upload(ctx: TenantContext, file: { buffer: Buffer; mimetype: string } | undefined, alt?: string) {
    if (!file?.buffer?.length) throw invalid('file_required', 'Choose an image to upload');
    if (!file.mimetype.startsWith('image/')) throw invalid('unsupported_media', 'Upload a PNG, JPEG, WebP or GIF image');
    return this.db.scoped(ctx, async (tx) => {
      const stored = await this.storage.put(tx, ctx, { bytes: file.buffer, contentType: file.mimetype, folder: 'studio', alt: alt?.slice(0, 200) });
      const row = await tx.one('select * from media_assets where id = $1', [stored.id]);
      await this.audit.record(tx, ctx, { action: 'media.uploaded', entityType: 'media_asset', entityId: stored.id, metadata: { contentType: stored.contentType, bytes: stored.byteSize } });
      return toMedia(row, await this.storage.signedUrl(row.path, 3600), false);
    });
  }

  async updateMedia(ctx: TenantContext, mediaId: string, patch: { alt?: string | null; altAr?: string | null }) {
    return this.db.scoped(ctx, async (tx) => {
      const row = await tx.maybeOne<any>(
        `update media_assets set alt = case when $2 then $3 else alt end, alt_ar = case when $4 then $5 else alt_ar end
          where id = $1 and org_id = $6 returning *`,
        [mediaId, patch.alt !== undefined, patch.alt ?? null, patch.altAr !== undefined, patch.altAr ?? null, ctx.orgId]);
      if (!row) throw notFound('Image');
      const used = await this.usedMedia(tx, ctx);
      return toMedia(row, await this.storage.signedUrl(row.path, 3600), used.has(row.id));
    });
  }

  /** Deletes an image only when no website draft, published revision, product or creative uses it. */
  async deleteMedia(ctx: TenantContext, mediaId: string) {
    return this.db.scoped(ctx, async (tx) => {
      const row = await tx.maybeOne<any>('select id from media_assets where id = $1 and org_id = $2 for update', [mediaId, ctx.orgId]);
      if (!row) throw notFound('Image');
      const used = await this.usedMedia(tx, ctx);
      if (used.has(mediaId)) throw conflict('media_in_use', 'This image is used on your website, menu or creative library. Remove it there first.');
      await tx.query('delete from media_assets where id = $1', [mediaId]);
      await this.audit.record(tx, ctx, { action: 'media.deleted', entityType: 'media_asset', entityId: mediaId });
      return { deleted: true };
    });
  }

  /** Active menu items (read model) for choosing website highlights. */
  async products(ctx: TenantContext, search?: string) {
    return this.db.scoped(ctx, async (tx) => {
      const rows = await tx.query<any>(
        `select p.id, p.name, p.name_ar, p.price_minor, p.currency, p.image_url, ma.path as image_path, c.name as category
           from products p join menu_categories c on c.id = p.category_id left join media_assets ma on ma.id = p.image_media_id
          where p.org_id = $1 and p.is_active and ($2::text is null or p.name ilike '%' || $2 || '%' or p.name_ar ilike '%' || $2 || '%')
          order by c.sort_order, p.sort_order, p.name limit 200`, [ctx.orgId, search?.trim() || null]);
      const items = await Promise.all(rows.map(async (r) => ({
        id: r.id, name: r.name, nameAr: r.name_ar, category: r.category, priceMinor: Number(r.price_minor), currency: r.currency,
        imageUrl: r.image_path ? await this.storage.signedUrl(r.image_path, 3600) : r.image_url,
      })));
      return { items, nextCursor: null };
    });
  }

  // --- internals -------------------------------------------------------------------
  private async site(tx: Tx, ctx: TenantContext, lock = false) {
    const row = await tx.maybeOne(`select * from websites where org_id = $1 ${lock ? 'for update' : ''}`, [ctx.orgId]);
    if (!row) throw notFound('Website');
    return toWebsite(row);
  }

  private async view(tx: Tx, ctx: TenantContext) {
    const site = await this.site(tx, ctx);
    const sections = (await tx.query('select * from website_sections where website_id = $1 order by sort_order, id', [site.id])).map(toSection);
    const last = await tx.maybeOne<{ snapshot: SiteDocument }>(
      'select snapshot from website_revisions where website_id = $1 order by revision desc limit 1', [site.id]);
    const org = await tx.one<{ slug: string }>('select slug from organizations where id = $1', [ctx.orgId]);
    const media = await this.builder.mediaMap(tx, ctx.orgId, referencedMedia({ theme: site.theme, seo: site.seo, sections }));
    return {
      website: { ...site, hasUnpublishedChanges: !last || last.snapshot.draftRevision !== site.draftRevision },
      sections,
      media: Object.fromEntries(media),
      publicPath: `/r/${org.slug}`,
    };
  }

  private async document(tx: Tx, ctx: TenantContext, site: ReturnType<typeof toWebsite>, visibleOnly: boolean): Promise<SiteDocument> {
    const rows = await tx.query<any>(
      `select * from website_sections where website_id = $1 ${visibleOnly ? 'and is_visible' : ''} order by sort_order, id`, [site.id]);
    return {
      template: site.template, theme: site.theme, seo: site.seo, draftRevision: site.draftRevision,
      sections: rows.map((r, i) => ({ id: r.id, kind: r.kind, sortOrder: i, content: r.content ?? {} })),
    };
  }

  private touch(tx: Tx, websiteId: string) {
    return tx.query('update websites set draft_revision = draft_revision + 1 where id = $1', [websiteId]);
  }

  private async assertContentRefs(tx: Tx, ctx: TenantContext, content: SectionContent) {
    await this.assertMedia(tx, ctx, [content.mediaId, ...(content.mediaIds ?? [])]);
    const products = [...new Set(content.productIds ?? [])];
    if (products.length) {
      const { n } = await tx.one<{ n: number }>('select count(*)::int as n from products where org_id = $1 and id = any($2::uuid[]) and is_active', [ctx.orgId, products]);
      if (n !== products.length) throw invalid('unknown_product', 'One or more menu items do not exist');
    }
  }

  private async assertMedia(tx: Tx, ctx: TenantContext, ids: Array<string | null | undefined>) {
    const missing = await this.missingMedia(tx, ctx, ids.filter((x): x is string => !!x));
    if (missing.length) throw invalid('unknown_media', 'One or more images do not exist in your media library', { mediaIds: missing });
  }

  private async missingMedia(tx: Tx, ctx: TenantContext, ids: string[]) {
    const unique = [...new Set(ids)];
    if (!unique.length) return [];
    const rows = await tx.query<{ id: string }>('select id from media_assets where org_id = $1 and id = any($2::uuid[])', [ctx.orgId, unique]);
    const found = new Set(rows.map((r) => r.id));
    return unique.filter((id) => !found.has(id));
  }

  private async usedMedia(tx: Tx, ctx: TenantContext): Promise<Set<string>> {
    const used = new Set<string>();
    const site = await tx.maybeOne<any>('select id, theme, seo from websites where org_id = $1', [ctx.orgId]);
    if (site) {
      const sections = await tx.query<any>('select content from website_sections where website_id = $1', [site.id]);
      for (const id of referencedMedia({ theme: site.theme ?? {}, seo: site.seo ?? {}, sections: sections.map((s) => ({ id: '', kind: '', sortOrder: 0, content: s.content ?? {} })) })) used.add(id);
      const revisions = await tx.query<any>('select snapshot from website_revisions where website_id = $1 order by revision desc limit 1', [site.id]);
      for (const r of revisions) for (const id of referencedMedia(r.snapshot)) used.add(id);
    }
    const other = await tx.query<{ id: string }>(
      `select image_media_id as id from products where org_id = $1 and image_media_id is not null
       union select media_id from creative_assets where org_id = $1 and media_id is not null`, [ctx.orgId]);
    for (const r of other) used.add(r.id);
    return used;
  }
}
