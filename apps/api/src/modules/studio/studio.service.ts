import { Injectable } from '@nestjs/common';
import {
  missingSectionKinds, sectionContentIssues, templateFamily, TEMPLATE_VARIANTS,
  type ApplyWebsiteTemplate, type CreateSection, type PublicSite, type PublicSitePromotion, type SectionContent, type TemplateVariantKey, type UpdateSection, type UpdateWebsite,
} from '@resuto/contracts';
import type { TenantContext } from '../../common/auth/context';
import { DbService, type Tx } from '../../common/db/db.service';
import { conflict, forbidden, invalid, notFound } from '../../common/errors/domain-error';
import { AuditService } from '../../common/platform/audit.service';
import { cursorAt, keyset, pageOf } from '../../common/http/pagination';
import { OutboxService } from '../../common/platform/outbox.service';
import { IdempotencyService } from '../../common/platform/idempotency.service';
import { MediaUrls, StorageService } from '../../common/storage/storage.service';
import { discountedPrice } from '../menu/menu.service';
import { dropUnsigned, SiteBuilderService, type SiteOverlay } from './site-builder.service';
import { referencedMedia, toMedia, toSection, toWebsite, type SiteDocument } from './studio.mappers';
import { escapeLike } from '../mcp/mcp.util';

const MAX_SECTIONS = 30;

/** Media kept out of the library and of website sections: menu-import files and food-photo originals (EXIF/GPS intact). */
const PRIVATE_MEDIA_SOURCES = ['import', 'photo_original'];

/** Matches the website-highlight product picker returns at most (PS-22: a search picker, not a page). */
export const STUDIO_PRODUCTS_MAX = 200;

@Injectable()
export class StudioService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly storage: StorageService,
    private readonly builder: SiteBuilderService,
    private readonly outbox: OutboxService,
  ) {}

  // --- Website ---------------------------------------------------------------
  async get(ctx: TenantContext) {
    return this.done(await this.db.scoped(ctx, async (tx) => this.view(tx, ctx)));
  }

  async update(ctx: TenantContext, patch: UpdateWebsite) {
    return this.done(await this.db.scoped(ctx, async (tx) => {
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
    }));
  }

  // --- Sections --------------------------------------------------------------
  async createSection(ctx: TenantContext, input: CreateSection) {
    return this.db.scoped(ctx, (tx) => this.createSectionTx(tx, ctx, input));
  }

  /** Adds a draft section inside the caller's transaction (the route above, and change sets). */
  async createSectionTx(tx: Tx, ctx: TenantContext, input: CreateSection) {
    const site = await this.site(tx, ctx, true);
    await this.assertCanAddSection(tx, ctx, site.id, input);
    const { max } = await tx.one<{ max: number | null }>('select max(sort_order) as max from website_sections where website_id = $1', [site.id]);
    const row = await tx.one(
      `insert into website_sections(org_id, website_id, kind, sort_order, is_visible, content) values ($1, $2, $3, $4, $5, $6) returning *`,
      [ctx.orgId, site.id, input.kind, (max ?? -1) + 1, input.isVisible, input.content]);
    await this.touch(tx, site.id);
    await this.audit.record(tx, ctx, { action: 'website.section_created', entityType: 'website_section', entityId: row.id, metadata: { kind: input.kind } });
    return toSection(row);
  }

  /** The section limit and the content's references (media, menu items of this restaurant). */
  async assertCanAddSection(tx: Tx, ctx: TenantContext, websiteId: string, input: Pick<CreateSection, 'content'> & { kind?: string }) {
    const { n } = await tx.one<{ n: number }>('select count(*)::int as n from website_sections where website_id = $1', [websiteId]);
    if (n >= MAX_SECTIONS) throw invalid('too_many_sections', `A website can have at most ${MAX_SECTIONS} sections`);
    if (input.kind) assertKindContent(input.kind, input.content);
    await this.assertContentRefs(tx, ctx, input.content);
  }

  /** The media and menu items a section's content refers to exist in this restaurant (and may be shown). */
  assertSectionContent(tx: Tx, ctx: TenantContext, content: SectionContent) {
    return this.assertContentRefs(tx, ctx, content);
  }

  async updateSection(ctx: TenantContext, sectionId: string, patch: UpdateSection) {
    return this.db.scoped(ctx, (tx) => this.updateSectionTx(tx, ctx, sectionId, patch));
  }

  /** Edits a draft section inside the caller's transaction (the route above, and change sets). */
  async updateSectionTx(tx: Tx, ctx: TenantContext, sectionId: string, patch: UpdateSection) {
    const existing = await tx.maybeOne<any>('select * from website_sections where id = $1 and org_id = $2 for update', [sectionId, ctx.orgId]);
    if (!existing) throw notFound('Section');
    if (patch.content) {
      assertKindContent(existing.kind, patch.content);
      await this.assertContentRefs(tx, ctx, patch.content);
    }
    const row = await tx.one(
      `update website_sections set content = coalesce($2, content), is_visible = coalesce($3, is_visible), updated_at = now()
        where id = $1 returning *`, [sectionId, patch.content ?? null, patch.isVisible ?? null]);
    await this.touch(tx, existing.website_id);
    await this.audit.record(tx, ctx, { action: 'website.section_updated', entityType: 'website_section', entityId: sectionId, metadata: { fields: Object.keys(patch) } });
    return toSection(row);
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
    return this.done(await this.db.scoped(ctx, async (tx) => {
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
    }));
  }

  // --- Publish & revisions ------------------------------------------------------
  async publish(ctx: TenantContext, key: string, note?: string) {
    return this.db.scoped(ctx, async (tx) => {
      await this.site(tx, ctx, true);
      return this.idempotency.run(tx, ctx.orgId, 'studio.publish', key, { note: note ?? null }, () => this.publishTx(tx, ctx, note));
    });
  }

  /** Publishes the current draft as a new revision inside the caller's transaction (the route above, and change sets). */
  async publishTx(tx: Tx, ctx: TenantContext, note?: string | null) {
    const site = await this.site(tx, ctx, true);
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
    await this.outbox.publish(tx, ctx.orgId, { type: 'website.published', aggregateType: 'website', aggregateId: site.id, payload: { revision } });
    return { revision, publishedAt: new Date(row.published_at).toISOString() };
  }

  async revisions(ctx: TenantContext, q: { limit: number; cursor?: string } = { limit: 50 }) {
    // Revision numbers are unique per website: the number is both the sort key and the tie-break.
    const k = keyset(q.cursor, { atType: 'int', idType: 'text' });
    return this.db.scoped(ctx, async (tx) => {
      const site = await this.site(tx, ctx);
      const rows = await tx.query<any>(
        `select r.revision, r.note, r.published_at, r.published_by, p.full_name, p.email,
                jsonb_array_length(r.snapshot->'sections') as section_count
           from website_revisions r left join profiles p on p.id = r.published_by
          where r.website_id = $1 ${k.after('r.revision', 'r.revision::text', 2)} order by r.revision desc limit ${k.fetch(q.limit)}`, [site.id, ...k.params]);
      return pageOf(rows, q.limit, (r) => ({ at: Number(r.revision), id: String(r.revision) }), (r) => ({ revision: r.revision, note: r.note,
        publishedAt: new Date(r.published_at).toISOString(), publishedBy: r.full_name ?? r.email ?? null, sectionCount: r.section_count }));
    });
  }

  /** Copies a published revision back into the draft (it is published again only on the next publish). */
  async restore(ctx: TenantContext, revision: number) {
    return this.done(await this.db.scoped(ctx, async (tx) => {
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
    }));
  }

  /** Staff preview: the draft rendered exactly like the public site. */
  async preview(ctx: TenantContext) {
    const pending = await this.db.scoped(ctx, async (tx) => {
      const site = await this.site(tx, ctx);
      const doc = await this.document(tx, ctx, site, true);
      return this.builder.prepare(tx, ctx.orgId, doc, { revision: site.publishedRevision, publishedAt: site.publishedAt, preview: true });
    });
    return this.builder.finish(pending);
  }

  // --- Templates (21-STUDIO) -----------------------------------------------------------
  /**
   * Applies a style family × layout variant to the draft: the family's renderer, colours and heading font (logo, hero
   * image and tagline are kept), and the variant's section kinds the draft does not have yet, appended in the variant's
   * order with empty copy. Nothing is deleted; the live site changes only on publish.
   */
  async applyTemplate(ctx: TenantContext, input: ApplyWebsiteTemplate) {
    const family = templateFamily(input.family);
    if (!family) throw invalid('unknown_template', 'This template does not exist');
    if (!(TEMPLATE_VARIANTS as readonly string[]).includes(input.variant)) throw invalid('unknown_template', 'This template layout does not exist');
    const kinds = family.variants[input.variant as TemplateVariantKey];
    return this.done(await this.db.scoped(ctx, async (tx) => {
      const site = await this.site(tx, ctx, true);
      const added: string[] = [];
      if (input.applyStyle) {
        const theme = { ...site.theme, ...family.theme };
        await tx.query('update websites set template = $2, theme = $3, draft_revision = draft_revision + 1 where id = $1', [site.id, family.renderer, theme]);
      }
      if (input.addSections) {
        const existing = await tx.query<{ kind: string }>('select kind from website_sections where website_id = $1', [site.id]);
        const missing = missingSectionKinds(kinds, existing.map((r) => r.kind));
        if (existing.length + missing.length > MAX_SECTIONS) throw invalid('too_many_sections', `A website can have at most ${MAX_SECTIONS} sections`);
        const { max } = await tx.one<{ max: number | null }>('select max(sort_order) as max from website_sections where website_id = $1', [site.id]);
        for (const [i, kind] of missing.entries()) {
          const row = await tx.one<{ id: string }>(
            `insert into website_sections(org_id, website_id, kind, sort_order, is_visible, content) values ($1, $2, $3, $4, true, '{}') returning id`,
            [ctx.orgId, site.id, kind, (max ?? -1) + 1 + i]);
          added.push(row.id);
        }
        if (missing.length) await this.touch(tx, site.id);
      }
      await this.audit.record(tx, ctx, { action: 'website.template_applied', entityType: 'website', entityId: site.id,
        metadata: { family: family.key, variant: input.variant, applyStyle: input.applyStyle, addedSections: added.length } });
      const view = await this.view(tx, ctx);
      return { urls: view.urls, value: { ...view.value, addedSectionIds: added } };
    }));
  }

  /**
   * The draft as it will look once a change set is approved and applied (21-STUDIO canvas diff): its website section
   * ops laid over the draft, its dish discounts over the prices and its new offers over the promotions. Nothing is
   * written. Readable by whoever may read change sets, or by the person who proposed it.
   */
  async changeSetPreview(ctx: TenantContext, changeSetId: string): Promise<PublicSite> {
    const pending = await this.db.scoped(ctx, async (tx) => {
      const cs = await tx.maybeOne<{ id: string; status: string; proposed_by: string | null }>(
        'select id, status, proposed_by from change_sets where id = $1 and org_id = $2', [changeSetId, ctx.orgId]);
      if (!cs) throw notFound('Change set');
      if (!ctx.can('changes:read') && cs.proposed_by !== ctx.userId) throw forbidden('Reading this change needs changes:read');
      const ops = await tx.query<{ id: string; op_type: string; input: any; result: any }>(
        'select id, op_type, input, result from change_ops where change_set_id = $1 and org_id = $2 order by seq', [cs.id, ctx.orgId]);
      const site = await this.site(tx, ctx);
      const all = await tx.query<any>('select * from website_sections where website_id = $1 order by sort_order, id', [site.id]);
      // An applied set is already in the draft: show the draft as it is, with the sections it created marked. Any other
      // set (pending, or rejected, expired, invalidated) is shown as proposed.
      const applied = cs.status === 'applied' || cs.status === 'partially_applied';
      const rows = all.map((r) => ({ id: r.id as string, kind: r.kind as string, content: (r.content ?? {}) as SectionContent, visible: r.is_visible as boolean }));
      const diff = { changeSetId: cs.id, added: [] as string[], changed: [] as string[], repriced: [] as string[] };
      const prices = new Map<string, { priceMinor: number; compareAtMinor: number | null }>();
      const promotions: PublicSitePromotion[] = [];
      for (const op of ops) {
        const input = op.input ?? {};
        if (op.op_type === 'website.section.add') {
          diff.added.push(applied && op.result?.sectionId ? String(op.result.sectionId) : op.id);
          if (!applied) rows.push({ id: op.id, kind: input.kind, content: input.content ?? {}, visible: input.isVisible !== false });
        } else if (op.op_type === 'website.section.update') {
          diff.changed.push(input.sectionId);
          const row = rows.find((r) => r.id === input.sectionId);
          if (row && !applied) {
            if (input.content) row.content = input.content;
            if (typeof input.isVisible === 'boolean') row.visible = input.isVisible;
          }
        } else if (op.op_type === 'product.discount.set') {
          diff.repriced.push(input.productId);
          if (!applied) {
            const p = await tx.maybeOne<{ price_minor: number; compare_at_price_minor: number | null }>(
              'select price_minor, compare_at_price_minor from products where id = $1 and org_id = $2', [input.productId, ctx.orgId]);
            if (p) {
              const original = Number(p.compare_at_price_minor ?? p.price_minor);
              prices.set(input.productId, input.discountBps > 0
                ? { priceMinor: discountedPrice(original, input.discountBps), compareAtMinor: original }
                : { priceMinor: original, compareAtMinor: null });
            }
          }
        } else if (op.op_type === 'promotion.create' && input.code && !applied) {
          promotions.push({ code: input.code, name: input.name, nameAr: input.nameAr ?? null, kind: input.kind, value: Number(input.value),
            minOrderMinor: Number(input.minOrderMinor ?? 0), endsAt: input.endsAt ?? null });
        }
      }
      const doc = {
        template: site.template, theme: site.theme, seo: site.seo, draftRevision: site.draftRevision,
        sections: rows.filter((r) => r.visible).map((r, i) => ({ id: r.id, kind: r.kind, sortOrder: i, content: r.content })),
      };
      const overlay: SiteOverlay = { prices, promotions };
      return { pending: await this.builder.prepare(tx, ctx.orgId, doc, { revision: site.publishedRevision, publishedAt: site.publishedAt, preview: true }, overlay), diff };
    });
    const out = await this.builder.finish(pending.pending);
    return { ...out, diff: pending.diff };
  }

  // --- Media library -------------------------------------------------------------
  async listMedia(ctx: TenantContext, q: { limit: number; cursor?: string } = { limit: 100 }) {
    const k = keyset(q.cursor);
    // Library thumbnails: the 640 px derivative when there is one, signed in one batch after the transaction (PS-18).
    const urls = this.storage.urls(3600);
    const out = await this.db.scoped(ctx, async (tx) => {
      const rows = await tx.query<any>(
        `select *, ${cursorAt('created_at')} as cursor_at from media_assets
          where org_id = $1 and content_type like 'image/%' and source <> all($2::text[]) ${k.after('created_at', 'id', 3)}
          order by created_at desc, id desc limit ${k.fetch(q.limit)}`,
        [ctx.orgId, PRIVATE_MEDIA_SOURCES, ...k.params]);
      const used = await this.usedMedia(tx, ctx);
      return pageOf(rows, q.limit, (r) => ({ at: r.cursor_at, id: r.id }),
        (r) => urls.set(toMedia(r, '', used.has(r.id)), 'url', r.path, { fallback: '', variants: r.variants, minWidth: 640 }));
    });
    await urls.resolve();
    for (const m of out.items) m.url ??= '';
    return out;
  }

  async upload(ctx: TenantContext, file: { buffer: Buffer; mimetype: string } | undefined, alt?: string) {
    if (!file?.buffer?.length) throw invalid('file_required', 'Choose an image to upload');
    if (!file.mimetype.startsWith('image/')) throw invalid('unsupported_media', 'Upload a PNG, JPEG, WebP or GIF image');
    // Upload and derivatives before the transaction (PCL-11, CR-12); the transaction only records the object.
    const object = await this.storage.store(ctx, { bytes: file.buffer, contentType: file.mimetype, folder: 'studio' });
    const row = await this.db.scoped(ctx, async (tx) => {
      const stored = await this.storage.record(tx, ctx, object, { alt: alt?.slice(0, 200) });
      await this.audit.record(tx, ctx, { action: 'media.uploaded', entityType: 'media_asset', entityId: stored.id, metadata: { contentType: stored.contentType, bytes: stored.byteSize } });
      return tx.one<any>('select * from media_assets where id = $1', [stored.id]);
    });
    return toMedia(row, await this.storage.signedUrl(row.path, 3600), false);
  }

  async updateMedia(ctx: TenantContext, mediaId: string, patch: { alt?: string | null; altAr?: string | null }) {
    return this.db.scoped(ctx, async (tx) => {
      const row = await tx.maybeOne<any>(
        `update media_assets set alt = case when $2 then $3 else alt end, alt_ar = case when $4 then $5 else alt_ar end
          where id = $1 and org_id = $6 returning *`,
        [mediaId, patch.alt !== undefined, patch.alt ?? null, patch.altAr !== undefined, patch.altAr ?? null, ctx.orgId]);
      if (!row) throw notFound('Image');
      const used = await this.usedMedia(tx, ctx);
      return { row, inUse: used.has(row.id) };
    }).then(async ({ row, inUse }) => toMedia(row, await this.storage.signedUrl(row.path, 3600), inUse));
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

  /**
   * Active menu items (read model) for choosing website highlights: a search picker, not a page. At most
   * STUDIO_PRODUCTS_MAX matches; `truncated` tells the picker to ask for a narrower search (nextCursor stays null).
   */
  async products(ctx: TenantContext, search?: string) {
    const urls = this.storage.urls(3600);
    const out = await this.db.scoped(ctx, async (tx) => {
      const rows = await tx.query<any>(
        `select p.id, p.name, p.name_ar, p.price_minor, p.currency, p.image_url, ma.path as image_path, ma.variants as image_variants, c.name as category
           from products p join menu_categories c on c.id = p.category_id left join media_assets ma on ma.id = p.image_media_id
          where p.org_id = $1 and p.is_active and ($2::text is null or p.name ilike '%' || $2 || '%' or p.name_ar ilike '%' || $2 || '%')
          order by c.sort_order, p.sort_order, p.name, p.id limit ${STUDIO_PRODUCTS_MAX + 1}`, [ctx.orgId, search?.trim() ? escapeLike(search.trim()) : null]);
      const items = rows.slice(0, STUDIO_PRODUCTS_MAX).map((r) => urls.set({
        id: r.id, name: r.name, nameAr: r.name_ar, category: r.category, priceMinor: Number(r.price_minor), currency: r.currency,
        imageUrl: null as string | null,
      }, 'imageUrl', r.image_path, { fallback: r.image_url, variants: r.image_variants, minWidth: 320 }));
      return { items, nextCursor: null, truncated: rows.length > STUDIO_PRODUCTS_MAX };
    });
    await urls.resolve();
    return out;
  }

  // --- internals -------------------------------------------------------------------
  private async site(tx: Tx, ctx: TenantContext, lock = false) {
    const row = await tx.maybeOne(`select * from websites where org_id = $1 ${lock ? 'for update' : ''}`, [ctx.orgId]);
    if (!row) throw notFound('Website');
    return toWebsite(row);
  }

  /** Signs a view's media URLs after its transaction (PCL-11) and drops the ones that could not be signed. */
  private async done<T extends { media: Record<string, { url: string | null }> }>(pending: { value: T; urls: MediaUrls }): Promise<T> {
    await pending.urls.resolve();
    dropUnsigned(pending.value.media);
    return pending.value;
  }

  /** The editor view; its media URLs are collected, not signed (pass the result to done() after the transaction). */
  private async view(tx: Tx, ctx: TenantContext) {
    const site = await this.site(tx, ctx);
    const sections = (await tx.query('select * from website_sections where website_id = $1 order by sort_order, id', [site.id])).map(toSection);
    const last = await tx.maybeOne<{ snapshot: SiteDocument }>(
      'select snapshot from website_revisions where website_id = $1 order by revision desc limit 1', [site.id]);
    const org = await tx.one<{ slug: string }>('select slug from organizations where id = $1', [ctx.orgId]);
    const urls = this.builder.urls();
    const media = await this.builder.mediaMap(tx, ctx.orgId, referencedMedia({ theme: site.theme, seo: site.seo, sections }), urls);
    return { urls, value: {
      website: { ...site, hasUnpublishedChanges: !last || last.snapshot.draftRevision !== site.draftRevision },
      sections,
      media: Object.fromEntries(media),
      publicPath: `/r/${org.slug}`,
    } };
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
    const categories = [...new Set(content.categoryIds ?? [])];
    if (categories.length) {
      const { n } = await tx.one<{ n: number }>('select count(*)::int as n from menu_categories where org_id = $1 and id = any($2::uuid[])', [ctx.orgId, categories]);
      if (n !== categories.length) throw invalid('unknown_category', 'One or more menu categories do not exist');
    }
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
    // Private inputs (menu-import files, untouched food-photo originals) cannot be placed on the website.
    const rows = await tx.query<{ id: string }>('select id from media_assets where org_id = $1 and id = any($2::uuid[]) and source <> all($3::text[])',
      [ctx.orgId, unique, PRIVATE_MEDIA_SOURCES]);
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
       union select media_id from creative_assets where org_id = $1 and media_id is not null
       union select source_media_id from studio_photo_jobs where org_id = $1
       union select output_media_id from studio_photo_jobs where org_id = $1 and output_media_id is not null`, [ctx.orgId]);
    for (const r of other) used.add(r.id);
    return used;
  }
}

/** The 21-STUDIO kinds take only their own fields (a FAQ has questions, not dishes): 422 section_content_invalid. */
function assertKindContent(kind: string, content: SectionContent) {
  const issues = sectionContentIssues(kind, content as Record<string, unknown>);
  if (issues.length) throw invalid('section_content_invalid', `This ${kind} section has content it cannot show`, issues);
}
