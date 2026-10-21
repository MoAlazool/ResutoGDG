import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { photoEnhanceParams, type CreatePhotoJob, type PhotoJobView, type PublishPhotoJob } from '@resuto/contracts';
import { TenantContext } from '../../../common/auth/context';
import { DbService, type Tx } from '../../../common/db/db.service';
import { conflict, DomainError, invalid, notFound } from '../../../common/errors/domain-error';
import { Scheduled } from '../../../common/events/events';
import { AuditService } from '../../../common/platform/audit.service';
import { enhanceFoodPhoto, sharpAvailable } from '../../../common/storage/image-enhance';
import { StorageService } from '../../../common/storage/storage.service';
import { ENV, type Env } from '../../../config/env';
import { MenuService } from '../../menu/menu.service';
import { StudioService } from '../studio.service';
import { PHOTO_GENERATIVE_PROVIDERS, type PhotoGenerativeProvider } from './generative';

const MAX_ATTEMPTS = 3;
const LEASE_MINUTES = 5;
const PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const iso = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString() : null);

/**
 * Food-photo enhancement (FT-04): upload -> durable job -> review -> approve -> publish to a menu item or a website
 * section. The default (and, out of the box, only) mode is deterministic local enhancement; nothing is published
 * before a person approves, the original is always kept, and every result carries its provenance.
 */
@Injectable()
export class StudioPhotosService {
  private readonly logger = new Logger('StudioPhotos');

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly menu: MenuService,
    private readonly studio: StudioService,
    @Inject(ENV) private readonly env: Env,
    @Optional() @Inject(PHOTO_GENERATIVE_PROVIDERS) private readonly generative: PhotoGenerativeProvider[] | null = null,
  ) {}

  private async provider(orgId: string): Promise<PhotoGenerativeProvider | null> {
    for (const p of this.generative ?? []) if (await p.configured(orgId)) return p;
    return null;
  }

  async create(ctx: TenantContext, file: { buffer: Buffer; mimetype: string } | undefined, input: CreatePhotoJob): Promise<PhotoJobView> {
    if (!file?.buffer?.length) throw invalid('file_required', 'Choose a photo of the dish');
    if (!PHOTO_TYPES.has(file.mimetype)) throw invalid('unsupported_media', 'Upload a JPEG, PNG or WebP photo');
    let provider: PhotoGenerativeProvider | null = null;
    if (input.mode === 'generative') {
      provider = await this.provider(ctx.orgId);
      if (!provider) {
        throw new DomainError('generative_not_configured',
          'Generative photo edits are not configured. Resuto only offers the deterministic enhancement, which never changes the dish.', 409);
      }
    } else if (!sharpAvailable()) {
      throw new DomainError('enhancement_unavailable', 'Photo enhancement is not available on this server', 503);
    }
    if (input.productId && !(await this.db.scoped(ctx, (tx) => tx.maybeOne('select 1 from products where id = $1 and org_id = $2', [input.productId, ctx.orgId])))) {
      throw invalid('unknown_product', 'This menu item does not exist');
    }
    // The original is stored privately (not a guest-facing folder) and never modified.
    const original = await this.storage.store(ctx, { bytes: file.buffer, contentType: file.mimetype, folder: 'photo-originals' });
    const view = await this.db.scoped(ctx, async (tx) => {
      const media = await this.storage.record(tx, ctx, original, { source: 'upload' });
      const row = await tx.one<any>(
        `insert into studio_photo_jobs(org_id, mode, provider, params, product_id, source_media_id, created_by)
         values ($1, $2, $3, $4, $5, $6, $7) returning *`,
        [ctx.orgId, input.mode, provider?.id ?? 'resuto_sharp', JSON.stringify(input.params), input.productId ?? null, media.id, ctx.userId]);
      await this.audit.record(tx, ctx, { action: 'studio_photo.uploaded', entityType: 'studio_photo_job', entityId: row.id,
        metadata: { mode: input.mode, provider: row.provider, productId: input.productId ?? null, bytes: file.buffer.length } });
      return row;
    });
    if (this.env.NODE_ENV !== 'test') setImmediate(() => { void this.runDue(1).catch((e) => this.logger.warn(`photo kick failed: ${(e as Error).message}`)); });
    return this.get(ctx, view.id);
  }

  async list(ctx: TenantContext, status?: string, limit = 30) {
    const urls = this.storage.urls(3600);
    const items = await this.db.scoped(ctx, async (tx) => {
      const rows = await tx.query<any>(`${SELECT} where j.org_id = $1 and ($2::text is null or j.status = $2) order by j.created_at desc limit $3`,
        [ctx.orgId, status ?? null, Math.min(Math.max(limit, 1), 100)]);
      return rows.map((r) => this.toView(r, urls));
    });
    await urls.resolve();
    return { items };
  }

  async get(ctx: TenantContext, id: string): Promise<PhotoJobView> {
    const urls = this.storage.urls(3600);
    const view = await this.db.scoped(ctx, async (tx) => this.toView(await this.load(tx, ctx.orgId, id, false), urls));
    await urls.resolve();
    return view;
  }

  async review(ctx: TenantContext, id: string, decision: 'approve' | 'reject', note?: string) {
    await this.db.scoped(ctx, async (tx) => {
      const r = await this.load(tx, ctx.orgId, id, true);
      if (r.status !== 'review') throw conflict('photo_not_in_review', `This photo is ${r.status}; only results waiting for review can be decided`, { status: r.status });
      await tx.query(`update studio_photo_jobs set status = $2, reviewed_by = $3, reviewed_at = now(), review_note = $4, updated_at = now() where id = $1`,
        [id, decision === 'approve' ? 'approved' : 'rejected', ctx.userId, note ?? null]);
      await this.audit.record(tx, ctx, { action: decision === 'approve' ? 'studio_photo.approved' : 'studio_photo.rejected', entityType: 'studio_photo_job', entityId: id,
        metadata: { mode: r.mode, provider: r.provider } });
    });
    return this.get(ctx, id);
  }

  /** Publishes an approved result. Idempotent per key; a published result may also be published to another target. */
  async publish(ctx: TenantContext, id: string, input: PublishPhotoJob) {
    const job = await this.db.scoped(ctx, (tx) => this.load(tx, ctx.orgId, id, false));
    const targetId = input.target === 'product' ? input.productId! : input.sectionId!;
    if (job.status === 'published' && job.published_key === input.key && job.published_target === input.target && job.published_id === targetId) return this.get(ctx, id);
    if (job.status !== 'approved' && job.status !== 'published') {
      throw conflict('photo_not_approved', 'Approve the enhanced photo before publishing it', { status: job.status });
    }
    if (!job.output_path) throw conflict('photo_not_ready', 'The enhanced photo is missing');
    if (input.target === 'product') {
      ctx.require('menu:write');
      const bytes = await this.storage.read(job.output_path);
      if (!bytes) throw new DomainError('photo_missing', 'The enhanced photo could not be read', 500);
      // Through the menu module's own image path (derivatives, menu version, audit).
      await this.menu.uploadImage(ctx, targetId, { buffer: bytes, mimetype: 'image/jpeg' }, job.output_alt ?? undefined);
    } else {
      ctx.require('studio:write');
      const section = await this.db.scoped(ctx, (tx) => tx.maybeOne<any>('select kind, content from website_sections where id = $1 and org_id = $2', [targetId, ctx.orgId]));
      if (!section) throw notFound('Section');
      const content = { ...(section.content ?? {}) };
      if (section.kind === 'gallery') content.mediaIds = [...new Set([...(content.mediaIds ?? []), job.output_media_id])].slice(-24);
      else content.mediaId = job.output_media_id;
      // The website draft changes; the site goes live when the owner publishes the website (studio:publish).
      await this.studio.updateSection(ctx, targetId, { content });
    }
    await this.db.scoped(ctx, async (tx) => {
      await tx.query(`update studio_photo_jobs set status = 'published', published_target = $2, published_id = $3, published_key = $4, published_by = $5,
                        published_at = now(), updated_at = now() where id = $1`, [id, input.target, targetId, input.key, ctx.userId]);
      await this.audit.record(tx, ctx, { action: 'studio_photo.published', entityType: 'studio_photo_job', entityId: id,
        metadata: { target: input.target, targetId, outputMediaId: job.output_media_id, mode: job.mode } });
    });
    return this.get(ctx, id);
  }

  async retry(ctx: TenantContext, id: string) {
    await this.db.scoped(ctx, async (tx) => {
      const r = await this.load(tx, ctx.orgId, id, true);
      if (r.status !== 'failed') throw conflict('photo_not_failed', 'Only failed photos can be retried', { status: r.status });
      await tx.query(`update studio_photo_jobs set status = 'queued', attempts = 0, error = null, updated_at = now() where id = $1`, [id]);
    });
    return this.get(ctx, id);
  }

  // ---------------------------------------------------------------------------
  // Worker
  // ---------------------------------------------------------------------------

  @Scheduled('studio.photo-jobs', 10, { timeoutMs: 6 * 60_000 })
  async runDue(limit = 2): Promise<{ processed: number; failed: number }> {
    const lease = randomUUID();
    const claimed = await this.db.withPlatform(async (tx) => {
      await tx.query(
        `update studio_photo_jobs set status = 'failed', lease = null, error = coalesce(error, 'Processing did not finish; retry the photo.'), updated_at = now()
          where status = 'processing' and leased_until < now() and attempts >= $1`, [MAX_ATTEMPTS]);
      return tx.query<any>(
        `update studio_photo_jobs set status = 'processing', attempts = attempts + 1, lease = $1, leased_until = now() + make_interval(mins => $3), updated_at = now()
          where id in (select id from studio_photo_jobs where attempts < $4 and (status = 'queued' or (status = 'processing' and leased_until < now()))
                        order by created_at for update skip locked limit $2)
          returning id, org_id, mode, provider, params, source_media_id, attempts`, [lease, limit, LEASE_MINUTES, MAX_ATTEMPTS]);
    }, 'studio.photo-jobs');
    let processed = 0;
    let failed = 0;
    for (const job of claimed) { if (await this.process(job, lease)) processed++; else failed++; }
    return { processed, failed };
  }

  /** Reads, enhances and stores OUTSIDE any transaction; only short statements write the job. */
  private async process(job: any, lease: string): Promise<boolean> {
    const sys = TenantContext.system(job.org_id, 'studio.photo-jobs');
    const fail = async (message: string, retry: boolean) => {
      await this.db.withTenant(job.org_id, async (tx) => {
        const row = await tx.maybeOne(`update studio_photo_jobs set status = $3, error = $4, lease = null, leased_until = null, updated_at = now()
                                        where id = $1 and lease = $2 returning id`, [job.id, lease, retry ? 'queued' : 'failed', message.slice(0, 500)]);
        if (row && !retry) await this.audit.record(tx, sys, { action: 'studio_photo.failed', entityType: 'studio_photo_job', entityId: job.id, metadata: { error: message.slice(0, 200) } });
      }, 'studio.photo-jobs').catch(() => undefined);
      return false;
    };
    try {
      const src = await this.db.withTenant(job.org_id, (tx) => tx.maybeOne<{ path: string; content_type: string; alt: string | null }>(
        'select path, content_type, alt from media_assets where id = $1 and org_id = $2', [job.source_media_id, job.org_id]), 'studio.photo-jobs');
      const bytes = src ? await this.storage.read(src.path) : null;
      if (!src || !bytes) return fail('The original photo is no longer available.', false);
      let master: { bytes: Buffer; contentType: string };
      let avif: Array<{ width: number; bytes: Buffer }> = [];
      let provenance: Record<string, unknown>;
      let model: string | null = null;
      if (job.mode === 'generative') {
        const provider = (this.generative ?? []).find((p) => p.id === job.provider);
        if (!provider || !(await provider.configured(job.org_id))) return fail('The generative provider is no longer configured.', false);
        const out = await provider.edit(job.org_id, { bytes, mime: src.content_type });
        master = { bytes: out.bytes, contentType: out.mime };
        model = out.model;
        provenance = { mode: 'generative', generative: true, provider: provider.id, label: provider.label, model: out.model, prompt: out.prompt,
          warning: 'A model edited this photo. Check that the dish, its ingredients and its portion are unchanged before approving.' };
      } else {
        const out = await enhanceFoodPhoto(bytes, photoEnhanceParams.parse(job.params ?? {}));
        master = out.master;
        avif = out.formats.filter((f) => f.format === 'avif').map((f) => ({ width: f.width, bytes: f.bytes }));
        provenance = out.provenance;
      }
      // The enhanced master goes to the guest-facing folder (WebP derivatives are produced by store, CR-12).
      const stored = await this.storage.store(sys, { bytes: master.bytes, contentType: master.contentType, folder: 'studio' });
      const formats: Array<{ format: 'webp' | 'avif'; width: number; bytes: number; path: string }> =
        stored.variants.map((v) => ({ format: 'webp' as const, width: v.w, bytes: v.bytes, path: v.path }));
      for (const a of avif) {
        const d = await this.storage.writeDerivative(stored.path, a.width, 'avif', a.bytes);
        formats.push({ format: 'avif', width: a.width, bytes: d.bytes, path: d.path });
      }
      return await this.db.withTenant(job.org_id, async (tx) => {
        const media = await this.storage.record(tx, sys, stored, { source: 'studio_enhanced', alt: src.alt ?? undefined });
        const row = await tx.maybeOne(
          `update studio_photo_jobs set status = 'review', output_media_id = $3, formats = $4::jsonb, provenance = $5::jsonb, model = $6, error = null,
                  lease = null, leased_until = null, updated_at = now()
            where id = $1 and lease = $2 and status = 'processing' returning id`,
          [job.id, lease, media.id, JSON.stringify(formats), JSON.stringify({ ...provenance, sourceMediaId: job.source_media_id }), model]);
        if (row) await this.audit.record(tx, sys, { action: 'studio_photo.enhanced', entityType: 'studio_photo_job', entityId: job.id, metadata: { mode: job.mode, outputMediaId: media.id } });
        return !!row;
      }, 'studio.photo-jobs');
    } catch (e) {
      this.logger.warn(`photo job ${job.id}: ${(e as Error).message}`);
      const unreadable = /unsupported image|corrupt|Input buffer|VipsJpeg|pngload|webpload/i.test((e as Error).message);
      return fail(unreadable ? 'The photo could not be read. Upload a JPEG, PNG or WebP file.' : 'Enhancing the photo failed.', !unreadable && job.attempts < MAX_ATTEMPTS);
    }
  }

  // ---------------------------------------------------------------------------

  private async load(tx: Tx, orgId: string, id: string, lock: boolean) {
    const r = await tx.maybeOne<any>(`${SELECT} where j.id = $1 and j.org_id = $2 ${lock ? 'for update of j' : ''}`, [id, orgId]);
    if (!r) throw notFound('Photo');
    return r;
  }

  private toView(r: any, urls: ReturnType<StorageService['urls']>): PhotoJobView {
    const view: PhotoJobView = {
      id: r.id, status: r.status, mode: r.mode, provider: r.provider, model: r.model ?? null, params: photoEnhanceParams.parse(r.params ?? {}),
      productId: r.product_id ?? null,
      // Originals are stored as-is (no derivatives), so their dimensions come from the measured provenance input.
      original: { mediaId: r.source_media_id, url: '', width: r.src_width ?? r.provenance?.input?.width ?? null, height: r.src_height ?? r.provenance?.input?.height ?? null, bytes: Number(r.src_bytes ?? 0) },
      output: r.output_media_id ? {
        mediaId: r.output_media_id, url: '', width: r.out_width ?? null, height: r.out_height ?? null, bytes: Number(r.out_bytes ?? 0),
        formats: (r.formats ?? []).map((f: any) => ({ format: f.format, width: f.width, bytes: f.bytes })),
      } : null,
      provenance: r.provenance ?? null, error: r.error ?? null, attempts: r.attempts, reviewedBy: r.reviewed_by ?? null, reviewedAt: iso(r.reviewed_at),
      reviewNote: r.review_note ?? null,
      published: r.published_target ? { target: r.published_target, id: r.published_id, at: iso(r.published_at)! } : null,
      createdAt: iso(r.created_at)!,
    };
    // Review screen: the 1280 px copies of both, so before/after are compared at the same size.
    urls.set(view.original, 'url', r.src_path, { fallback: '', variants: r.src_variants, minWidth: 1280 });
    if (view.output) urls.set(view.output, 'url', r.output_path, { fallback: '', variants: r.out_variants, minWidth: 1280 });
    return view;
  }
}

const SELECT = `select j.*, s.path as src_path, s.width as src_width, s.height as src_height, s.byte_size as src_bytes, s.variants as src_variants,
    o.path as output_path, o.width as out_width, o.height as out_height, o.byte_size as out_bytes, o.variants as out_variants, o.alt as output_alt
  from studio_photo_jobs j join media_assets s on s.id = j.source_media_id left join media_assets o on o.id = j.output_media_id`;
