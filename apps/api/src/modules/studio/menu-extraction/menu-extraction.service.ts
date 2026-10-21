import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  EXTRACTION_MAX_FILE_BYTES, type CommitExtraction, type CreateTextExtraction, type Currency, type ExtractionRow, type ExtractionRowCheck,
  type MenuExtractionJob, type MenuImportRow, type UpdateExtractionDraft,
} from '@resuto/contracts';
import { ProviderError } from '@resuto/integrations';
import { TenantContext } from '../../../common/auth/context';
import { DbService, type Tx } from '../../../common/db/db.service';
import { conflict, DomainError, invalid, notFound } from '../../../common/errors/domain-error';
import { Scheduled } from '../../../common/events/events';
import { AuditService } from '../../../common/platform/audit.service';
import { StorageService } from '../../../common/storage/storage.service';
import { ENV, type Env } from '../../../config/env';
import { csvToRows, previewRows } from '../../menu/menu-import';
import { MenuService } from '../../menu/menu.service';
import { aiNotConfigured, StudioAiService } from '../ai/studio-ai.service';
import { parseMenuText } from './menu-text-parser';
import { extractMenuWithGemini } from './menu-vision';

const MAX_ATTEMPTS = 3;
const LEASE_MINUTES = 4;
/** A commit holds the job for this long without progress; a commit that crashed is taken over after it. */
const COMMIT_LEASE_MINUTES = 2;
const FILE_TYPES = { 'image/png': 'image', 'image/jpeg': 'image', 'image/webp': 'image', 'application/pdf': 'pdf' } as const;
type FileMime = keyof typeof FILE_TYPES;

const iso = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString() : null);
const withIds = (rows: Omit<ExtractionRow, 'id'>[]): ExtractionRow[] => rows.map((r, i) => ({ ...r, id: `r${i + 1}` }));

const toImportRow = (r: ExtractionRow): MenuImportRow => ({
  name: r.name, ...(r.nameAr ? { nameAr: r.nameAr } : {}), category: r.category, ...(r.description ? { description: r.description } : {}),
  priceMinor: r.priceMinor ?? Number.NaN, allergens: r.allergens, available: r.available,
});

/**
 * Menu extraction jobs (FT-08 / VS-26): a source (pasted text, CSV, or a photo/PDF read with the restaurant's own
 * model key) becomes an editable, versioned review draft; approved rows are committed through the menu module's own
 * import (MenuService.importCommit, the same validation and idempotency as the CSV import), then their sizes/add-ons
 * through the menu module's modifier-group service. Nothing reaches the menu before a reviewer commits.
 */
@Injectable()
export class MenuExtractionService {
  private readonly logger = new Logger('MenuExtraction');

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly ai: StudioAiService,
    private readonly menu: MenuService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  // ---------------------------------------------------------------------------
  // Create
  // ---------------------------------------------------------------------------

  /** Text and CSV are read by Resuto's own parser immediately (no model); the job is ready for review on return. */
  async createFromText(ctx: TenantContext, input: CreateTextExtraction): Promise<MenuExtractionJob> {
    const currency = await this.currency(ctx);
    let rows: ExtractionRow[];
    let uncertainties: string[] = [];
    if (input.kind === 'csv') {
      rows = csvToRows(input.text, currency as 'EGP' | 'SAR').map((r, i) => {
        const uncertain = Number.isSafeInteger(r.priceMinor) ? [] : ['price'];
        return {
          id: `r${i + 1}`, status: 'review' as const, name: r.name.trim().slice(0, 200), nameAr: r.nameAr?.trim() || null, category: r.category.trim() || 'Mains',
          description: r.description?.trim() || null, priceMinor: Number.isSafeInteger(r.priceMinor) ? r.priceMinor : null,
          allergens: (r.allergens ?? []).slice(0, 30).map((a) => a.slice(0, 40)), modifiers: [], available: r.available ?? false,
          confidence: uncertain.length ? 0.5 : 1, uncertainFields: uncertain, source: null,
        };
      });
    } else {
      const parsed = parseMenuText(input.text, currency);
      rows = withIds(parsed.rows);
      uncertainties = parsed.uncertainties;
    }
    return this.db.scoped(ctx, async (tx) => {
      const row = await tx.one<any>(
        `insert into menu_extraction_jobs(org_id, status, mode, source_kind, source_name, source_text, provider, rows, uncertainties, version, created_by)
         values ($1, 'review', $2, $3, $4, $5, 'resuto_parser', $6::jsonb, $7::jsonb, 1, $8) returning *`,
        [ctx.orgId, input.kind === 'csv' ? 'csv_columns' : 'heuristic_text', input.kind, input.name?.slice(0, 120) ?? null, input.text,
          JSON.stringify(rows), JSON.stringify(uncertainties), ctx.userId]);
      await this.audit.record(tx, ctx, { action: 'menu_extraction.created', entityType: 'menu_extraction_job', entityId: row.id,
        metadata: { sourceKind: input.kind, provider: 'resuto_parser', rows: rows.length } });
      return this.view(tx, ctx.orgId, row);
    });
  }

  /**
   * Photos and PDFs: only with the restaurant's own model key. Refused (409 ai_not_configured) before anything is
   * stored when there is none. The original is kept privately (folder "imports") and a queued job is processed by the
   * worker (`studio.menu-extraction`), outside any request.
   */
  async createFromFile(ctx: TenantContext, file: { buffer: Buffer; mimetype: string; size: number; originalname: string } | undefined) {
    if (!file?.buffer?.length) throw invalid('file_required', 'Choose a photo or PDF of the menu');
    if (!(file.mimetype in FILE_TYPES)) throw invalid('unsupported_media', 'Upload a JPEG, PNG, WebP photo or a PDF; paste text or upload a CSV for anything else');
    if (file.buffer.length > EXTRACTION_MAX_FILE_BYTES) throw invalid('media_too_large', 'Menu files must be under 10 MB');
    if (!(await this.ai.byok(ctx.orgId))) throw aiNotConfigured();
    const object = await this.storage.store(ctx, { bytes: file.buffer, contentType: file.mimetype, folder: 'imports' });
    const name = (file.originalname || '').replace(/[^\p{L}\p{N} ._()-]+/gu, '').slice(0, 120) || null;
    const job = await this.db.scoped(ctx, async (tx) => {
      const media = await this.storage.record(tx, ctx, object, { source: 'import' });
      const row = await tx.one<any>(
        `insert into menu_extraction_jobs(org_id, status, mode, source_kind, source_name, source_media_id, provider, created_by)
         values ($1, 'queued', 'vision_model', $2, $3, $4, 'gemini_byok', $5) returning *`,
        [ctx.orgId, FILE_TYPES[file.mimetype as FileMime], name, media.id, ctx.userId]);
      await this.audit.record(tx, ctx, { action: 'menu_extraction.created', entityType: 'menu_extraction_job', entityId: row.id,
        metadata: { sourceKind: row.source_kind, provider: 'gemini_byok', bytes: file.buffer.length } });
      return this.view(tx, ctx.orgId, row);
    });
    if (this.env.NODE_ENV !== 'test') setImmediate(() => { void this.runDue(1).catch((e) => this.logger.warn(`extraction kick failed: ${(e as Error).message}`)); });
    return job;
  }

  // ---------------------------------------------------------------------------
  // Read / edit / discard
  // ---------------------------------------------------------------------------

  async list(ctx: TenantContext, limit = 20) {
    return this.db.scoped(ctx, async (tx) => {
      const rows = await tx.query<any>(
        `select * from menu_extraction_jobs where org_id = $1 and status <> 'discarded' order by created_at desc limit $2`, [ctx.orgId, Math.min(Math.max(limit, 1), 50)]);
      return { items: rows.map((r) => this.toJob(r, [])) };
    });
  }

  async get(ctx: TenantContext, id: string): Promise<MenuExtractionJob> {
    return this.db.scoped(ctx, async (tx) => this.view(tx, ctx.orgId, await this.load(tx, ctx.orgId, id, false)));
  }

  /** Saves the reviewer's edits (names, prices, categories, modifiers, approve/reject). Stale versions are refused. */
  async updateDraft(ctx: TenantContext, id: string, input: UpdateExtractionDraft): Promise<MenuExtractionJob> {
    const ids = new Set<string>();
    for (const r of input.rows) {
      if (ids.has(r.id)) throw invalid('duplicate_row_id', `Row id ${r.id} appears twice`);
      ids.add(r.id);
    }
    return this.db.scoped(ctx, async (tx) => {
      const job = await this.load(tx, ctx.orgId, id, true);
      if (job.status !== 'review') throw conflict('extraction_not_in_review', `This import is ${job.status}; only drafts in review can be edited`, { status: job.status });
      if (job.version !== input.version) throw conflict('extraction_stale', 'Someone changed this draft since you opened it. Reload to see their changes.', { version: job.version });
      const row = await tx.one<any>(
        `update menu_extraction_jobs set rows = $2::jsonb, version = version + 1, updated_at = now() where id = $1 returning *`, [id, JSON.stringify(input.rows)]);
      await this.audit.record(tx, ctx, { action: 'menu_extraction.edited', entityType: 'menu_extraction_job', entityId: id,
        metadata: { rows: input.rows.length, approved: input.rows.filter((r) => r.status === 'approved').length, version: row.version } });
      return this.view(tx, ctx.orgId, row);
    });
  }

  async discard(ctx: TenantContext, id: string) {
    return this.db.scoped(ctx, async (tx) => {
      const job = await this.load(tx, ctx.orgId, id, true);
      if (!['review', 'failed', 'queued'].includes(job.status)) throw conflict('extraction_not_discardable', `This import is ${job.status}`, { status: job.status });
      const row = await tx.one<any>(`update menu_extraction_jobs set status = 'discarded', lease = null, updated_at = now() where id = $1 returning *`, [id]);
      await this.audit.record(tx, ctx, { action: 'menu_extraction.discarded', entityType: 'menu_extraction_job', entityId: id });
      return this.toJob(row, []);
    });
  }

  // ---------------------------------------------------------------------------
  // Commit (approved rows only, through the menu module)
  // ---------------------------------------------------------------------------

  /**
   * Exactly one commit runs at a time per job: the commit claims the job row (under its row lock) with a short commit
   * lease, and every later step (modifier progress, the final 'committed' update) is fenced on that lease. A second
   * commit that arrives while the lease is live gets 409 extraction_commit_in_progress; one that arrives after a
   * crashed commit's lease has expired takes over and resumes from the recorded progress (read under the lock).
   */
  async commit(ctx: TenantContext, id: string, input: CommitExtraction): Promise<MenuExtractionJob> {
    const lease = randomUUID();
    const staged = await this.db.scoped(ctx, async (tx) => {
      const job = await this.load(tx, ctx.orgId, id, true);
      if (job.status === 'committed') return { job, approved: [] as ExtractionRow[], done: true };
      if (job.status !== 'review' && job.status !== 'committing') throw conflict('extraction_not_in_review', `This import is ${job.status}`, { status: job.status });
      const live = job.status === 'committing' && job.lease
        && (await tx.one<{ live: boolean }>(`select coalesce($1::timestamptz > now(), false) as live`, [job.leased_until])).live;
      if (live) {
        throw conflict('extraction_commit_in_progress', 'This import is already being added to the menu. Reload in a moment to see the result.', { status: job.status });
      }
      if (job.version !== input.version) throw conflict('extraction_stale', 'This draft changed since you reviewed it. Reload and check it again.', { version: job.version });
      const approved = (job.rows as ExtractionRow[]).filter((r) => r.status === 'approved');
      if (!approved.length) throw invalid('nothing_approved', 'Approve at least one item before adding it to the menu');
      // Once the import has run (recorded below), resuming must not re-check: the rows are on the menu now, and the
      // import replays by its key. Before that, the rows are checked against the live menu as on a first commit.
      const importDone = job.status === 'committing' && (job.commit_result ?? {}).importDone === true;
      if (!importDone) {
        const checks = await this.check(tx, ctx.orgId, approved);
        const failing = checks.filter((c) => c.errors.length);
        if (failing.length) throw new DomainError('import_has_errors', 'Correct the highlighted rows (or reject them) before adding them to the menu.', 422, { checks: failing });
      }
      // The claim: progress (commit_result) is the value read under the row lock, so a takeover resumes where the last commit stopped.
      const claimed = await tx.one<any>(
        `update menu_extraction_jobs set status = 'committing', error = null, lease = $2, leased_until = now() + make_interval(mins => $3),
                commit_result = coalesce(commit_result, '{}'::jsonb) || $4::jsonb, updated_at = now()
          where id = $1 returning *`,
        [id, lease, COMMIT_LEASE_MINUTES, JSON.stringify(job.status === 'review' ? { requestKey: input.key } : {})]);
      return { job: claimed, approved, done: false };
    });
    if (staged.done) return this.get(ctx, id);

    /** Runs an update only while this commit still holds the lease (renewing it); false when another commit took over. */
    const fenced = (sqlText: string, params: unknown[]) => this.db.scoped(ctx, async (tx) => !!(await tx.maybeOne<{ id: string }>(
      `update menu_extraction_jobs set ${sqlText}, updated_at = now() where id = $1 and lease = $2 and status = 'committing' returning id`, [id, lease, ...params])));
    const lost = () => conflict('extraction_commit_in_progress', 'Another request took over adding this import to the menu. Reload to see the result.', {});

    const source = staged.job.provider === 'gemini_byok' ? 'ai' : staged.job.source_kind === 'csv' ? 'csv' : 'text';
    let imported: { created: number; updated: number; categoriesCreated: string[] };
    try {
      // The import key is bound to this job and version: a retried commit replays the same import, never a second one.
      imported = await this.menu.importCommit(ctx, { rows: staged.approved.map(toImportRow), source, key: `menu-extraction:${id}:v${staged.job.version}` });
    } catch (e) {
      const message = e instanceof DomainError ? e.message : 'The menu could not be updated';
      await fenced(`status = 'review', lease = null, leased_until = null, error = $3`, [message.slice(0, 1000)]);
      throw e;
    }
    if (!(await fenced(`commit_result = coalesce(commit_result, '{}'::jsonb) || $3::jsonb`, [JSON.stringify({ ...imported, importDone: true })]))) throw lost();

    // Sizes and add-ons: created through the menu module, one row at a time; progress is recorded (fenced on the lease)
    // so a retry resumes and a concurrent commit can never create a row's groups a second time.
    const done = new Set<string>(((staged.job.commit_result ?? {}).modifiersDone as string[] | undefined) ?? []);
    let groupsCreated = Number((staged.job.commit_result ?? {}).modifierGroupsCreated ?? 0);
    try {
      for (const r of staged.approved) {
        if (!r.modifiers.length || done.has(r.id)) continue;
        if (!(await fenced(`leased_until = now() + make_interval(mins => $3)`, [COMMIT_LEASE_MINUTES]))) throw lost();
        const product = await this.db.scoped(ctx, (tx) => tx.maybeOne<{ id: string }>(
          `select id from products where org_id = $1 and is_active and lower(trim(name)) = lower(trim($2)) order by created_at desc limit 1`, [ctx.orgId, r.name]));
        if (!product) throw new DomainError('extraction_product_missing', `"${r.name.slice(0, 60)}" was not found after the import`, 500);
        const groupIds: string[] = [];
        for (const g of r.modifiers) {
          const group = await this.menu.createGroup(ctx, { name: g.name, nameAr: g.nameAr, minSelect: g.minSelect, maxSelect: Math.min(g.maxSelect, g.options.length) });
          for (const [i, o] of g.options.entries()) {
            await this.menu.createOption(ctx, group.id, { name: o.name, nameAr: o.nameAr, priceDeltaMinor: o.priceDeltaMinor, isDefault: g.minSelect > 0 && i === 0, sortOrder: i });
          }
          groupIds.push(group.id);
          groupsCreated++;
        }
        await this.menu.assignGroups(ctx, product.id, groupIds);
        done.add(r.id);
        if (!(await fenced(`commit_result = coalesce(commit_result, '{}'::jsonb) || $3::jsonb`, [JSON.stringify({ modifiersDone: [...done], modifierGroupsCreated: groupsCreated })]))) {
          throw lost();
        }
      }
    } catch (e) {
      const message = e instanceof DomainError ? e.message : 'Sizes and add-ons could not be added';
      // Releases the lease so "Commit again" can resume at once (only if this commit still holds it).
      await fenced(`lease = null, leased_until = null, error = $3`, [`Items were added; ${message}. Commit again to finish.`.slice(0, 1000)]);
      throw e;
    }

    return this.db.scoped(ctx, async (tx) => {
      const row = await tx.maybeOne<any>(
        `update menu_extraction_jobs set status = 'committed', error = null, lease = null, leased_until = null, committed_by = $3, committed_at = now(), updated_at = now(),
                commit_result = coalesce(commit_result, '{}'::jsonb) || $4::jsonb
          where id = $1 and lease = $2 and status = 'committing' returning *`,
        [id, lease, ctx.userId, JSON.stringify({ ...imported, modifierGroupsCreated: groupsCreated, modifiersDone: [...done] })]);
      if (!row) throw lost();
      await this.audit.record(tx, ctx, { action: 'menu_extraction.committed', entityType: 'menu_extraction_job', entityId: id,
        metadata: { source, created: imported.created, updated: imported.updated, modifierGroupsCreated: groupsCreated } });
      return this.view(tx, ctx.orgId, row);
    });
  }

  // ---------------------------------------------------------------------------
  // Worker: photos/PDFs with the restaurant's own model
  // ---------------------------------------------------------------------------

  @Scheduled('studio.menu-extraction', 15, { timeoutMs: 6 * 60_000 })
  async runDue(limit = 2): Promise<{ processed: number; failed: number }> {
    const lease = randomUUID();
    const claimed = await this.db.withPlatform(async (tx) => {
      // Jobs whose worker died after the last attempt are closed instead of retried forever.
      await tx.query(
        `update menu_extraction_jobs set status = 'failed', lease = null, error = coalesce(error, 'Reading the menu did not finish; try again with a smaller file.'), updated_at = now()
          where status = 'processing' and leased_until < now() and attempts >= $1`, [MAX_ATTEMPTS]);
      return tx.query<{ id: string; org_id: string; source_media_id: string | null; source_name: string | null; attempts: number }>(
        `update menu_extraction_jobs j set status = 'processing', attempts = attempts + 1, lease = $1, leased_until = now() + make_interval(mins => $3), updated_at = now()
          where id in (select id from menu_extraction_jobs
                        where mode = 'vision_model' and attempts < $4 and (status = 'queued' or (status = 'processing' and leased_until < now()))
                        order by created_at for update skip locked limit $2)
          returning id, org_id, source_media_id, source_name, attempts`, [lease, limit, LEASE_MINUTES, MAX_ATTEMPTS]);
    }, 'studio.menu-extraction');
    let processed = 0;
    let failed = 0;
    for (const job of claimed) {
      if (await this.process(job, lease)) processed++; else failed++;
    }
    return { processed, failed };
  }

  /** Reads the file and calls the model OUTSIDE any transaction; only short statements touch the database. */
  private async process(job: { id: string; org_id: string; source_media_id: string | null; source_name: string | null; attempts: number }, lease: string) {
    const finish = (fields: { status: 'review' | 'queued' | 'failed'; error?: string | null; rows?: ExtractionRow[]; uncertainties?: string[]; model?: string | null }) =>
      this.db.withTenant(job.org_id, async (tx) => {
        const row = await tx.maybeOne<any>(
          `update menu_extraction_jobs set status = $3, error = $4, rows = coalesce($5::jsonb, rows), uncertainties = coalesce($6::jsonb, uncertainties),
                  model = coalesce($7, model), version = version + case when $5::jsonb is null then 0 else 1 end, lease = null, leased_until = null, updated_at = now()
            where id = $1 and lease = $2 and status = 'processing' returning id`,
          [job.id, lease, fields.status, fields.error ?? null, fields.rows ? JSON.stringify(fields.rows) : null,
            fields.uncertainties ? JSON.stringify(fields.uncertainties) : null, fields.model ?? null]);
        if (row && fields.status !== 'queued') {
          const sys = TenantContext.system(job.org_id, 'studio.menu-extraction');
          await this.audit.record(tx, sys, { action: fields.status === 'review' ? 'menu_extraction.extracted' : 'menu_extraction.failed', entityType: 'menu_extraction_job',
            entityId: job.id, metadata: { attempts: job.attempts, ...(fields.rows ? { rows: fields.rows.length } : {}), ...(fields.error ? { error: fields.error.slice(0, 200) } : {}) } });
        }
        return !!row;
      }, 'studio.menu-extraction');
    try {
      const model = await this.ai.byok(job.org_id);
      if (!model) { await finish({ status: 'failed', error: 'Your Gemini connection is no longer available (disabled, revoked or failing its health check). Reconnect it and upload the menu again.' }); return false; }
      const src = await this.db.withTenant(job.org_id, (tx) => tx.maybeOne<{ path: string; content_type: string; currency: Currency }>(
        `select m.path, m.content_type, o.currency from media_assets m join organizations o on o.id = m.org_id where m.id = $1 and m.org_id = $2`,
        [job.source_media_id, job.org_id]), 'studio.menu-extraction');
      const bytes = src ? await this.storage.read(src.path) : null;
      if (!src || !bytes || !(src.content_type in FILE_TYPES)) { await finish({ status: 'failed', error: 'The uploaded file is no longer available. Upload it again.' }); return false; }
      const result = await extractMenuWithGemini({ apiKey: model.apiKey, model: model.model, fetch: model.fetch, currency: src.currency,
        file: { bytes, mime: src.content_type as FileMime, name: job.source_name } });
      const rows = withIds(result.rows);
      const uncertainties = rows.length ? result.uncertainties : ['The model did not find any menu items in this file.', ...result.uncertainties];
      await finish({ status: 'review', rows, uncertainties: uncertainties.slice(0, 60), model: model.model });
      return true;
    } catch (e) {
      const retry = e instanceof ProviderError && e.retryable && job.attempts < MAX_ATTEMPTS;
      const message = e instanceof ProviderError ? `Gemini: ${e.message.replace(/^gemini_byok:\s*/, '')}` : 'Reading the menu failed';
      if (!(e instanceof ProviderError)) this.logger.error(`menu extraction ${job.id}: ${(e as Error).message}`);
      await finish({ status: retry ? 'queued' : 'failed', error: message.slice(0, 500) }).catch(() => undefined);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async currency(ctx: TenantContext): Promise<Currency> {
    return this.db.scoped(ctx, async (tx) => (await tx.one<{ currency: Currency }>('select currency from organizations where id = $1', [ctx.orgId])).currency);
  }

  private async load(tx: Tx, orgId: string, id: string, lock: boolean) {
    const row = await tx.maybeOne<any>(`select * from menu_extraction_jobs where id = $1 and org_id = $2 ${lock ? 'for update' : ''}`, [id, orgId]);
    if (!row) throw notFound('Menu import');
    return row;
  }

  /** Validation of rows against the live menu with the menu module's own import rules (previewRows). */
  private async check(tx: Tx, orgId: string, rows: ExtractionRow[]): Promise<ExtractionRowCheck[]> {
    const live = rows.filter((r) => r.status !== 'rejected');
    if (!live.length) return rows.map((r) => ({ id: r.id, errors: [], warnings: [], action: null }));
    const existing = await tx.query<{ id: string; name: string; external_ref: string | null }>(
      'select id, name, external_ref from products where org_id = $1 and is_active', [orgId]);
    const categories = await tx.query<{ name: string }>('select name from menu_categories where org_id = $1 and is_active', [orgId]);
    const preview = previewRows(live.map(toImportRow), existing, categories.map((c) => c.name), 'ai');
    const byId = new Map(live.map((r, i) => [r.id, preview.rows[i]!]));
    return rows.map((r) => {
      const p = byId.get(r.id);
      if (!p) return { id: r.id, errors: [], warnings: [], action: null };
      const errors = p.errors.map((e) => (e === 'Duplicate item' && existing.some((x) => x.name.trim().toLowerCase() === r.name.trim().toLowerCase())
        ? 'Already on your menu: rename it or reject this row' : e));
      if (r.priceMinor === null) errors.unshift('Enter a price');
      const warnings = p.warnings.filter((w) => w !== 'Review price and allergens before publishing');
      if (r.confidence < 0.75) warnings.push('Low confidence: check this row against the source');
      if (r.uncertainFields.length) warnings.push(`Check: ${r.uncertainFields.join(', ')}`);
      return { id: r.id, errors: [...new Set(errors)], warnings, action: p.action };
    });
  }

  private async view(tx: Tx, orgId: string, row: any): Promise<MenuExtractionJob> {
    const checks = row.status === 'review' || row.status === 'committing' ? await this.check(tx, orgId, row.rows as ExtractionRow[]) : [];
    return this.toJob(row, checks);
  }

  private toJob(r: any, checks: ExtractionRowCheck[]): MenuExtractionJob {
    const rows = (r.rows ?? []) as ExtractionRow[];
    const errorIds = new Set(checks.filter((c) => c.errors.length).map((c) => c.id));
    const cr = r.commit_result ?? null;
    return {
      id: r.id, status: r.status, mode: r.mode, sourceKind: r.source_kind, sourceName: r.source_name ?? null, provider: r.provider, model: r.model ?? null,
      version: r.version, rows, checks, uncertainties: r.uncertainties ?? [],
      summary: {
        total: rows.length, approved: rows.filter((x) => x.status === 'approved').length, rejected: rows.filter((x) => x.status === 'rejected').length,
        review: rows.filter((x) => x.status === 'review').length, errors: rows.filter((x) => x.status !== 'rejected' && errorIds.has(x.id)).length,
        lowConfidence: rows.filter((x) => x.status !== 'rejected' && x.confidence < 0.75).length,
      },
      error: r.error ?? null, attempts: r.attempts,
      commitResult: r.status === 'committed' && cr ? { created: cr.created ?? 0, updated: cr.updated ?? 0, categoriesCreated: cr.categoriesCreated ?? [], modifierGroupsCreated: cr.modifierGroupsCreated ?? 0 } : null,
      createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)!, committedAt: iso(r.committed_at),
    };
  }
}
