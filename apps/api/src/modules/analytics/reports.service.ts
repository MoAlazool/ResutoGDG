import { Injectable } from '@nestjs/common';
import {
  SAVED_REPORT_LIMIT_PER_USER, unknownReportFilters,
  type ReportSection, type SavedReport, type SavedReportInput, type SavedReportListQuery, type SavedReportUpdate,
} from '@resuto/contracts/reports';
import type { TenantContext } from '../../common/auth/context';
import { DbService, type Tx } from '../../common/db/db.service';
import { badRequest, conflict, forbidden, invalid, notFound } from '../../common/errors/domain-error';
import { cursorAt, keyset, pageOf } from '../../common/http/pagination';
import { AuditService } from '../../common/platform/audit.service';
import { iso } from './scope';

const isUnique = (e: unknown) => (e as { code?: string }).code === '23505';

interface Row {
  id: string; user_id: string; branch_id: string | null; name: string; section: string; view: SavedReport['view']; shared: boolean;
  created_at: Date; updated_at: Date; author_name?: string | null; sort_key?: string;
}

const SELECT = `r.id, r.user_id, r.branch_id, r.name, r.section, r.view, r.shared, r.created_at, r.updated_at,
  coalesce(p.full_name, p.email) as author_name`;

/**
 * Saved Insights reports (21-INSIGHTS): a member's named views (section, period, comparison, branch, filters). The
 * saved_reports RLS lets a staff session read its own reports plus colleagues' shared ones when its role may read
 * analytics, and write only its own; this service adds the API rules (limits, unique names, branch scope, audit). A
 * colleague's report is not found for writes (only its author changes it). Only signed-in staff have reports.
 */
@Injectable()
export class ReportsService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  private userOf(ctx: TenantContext): string {
    if (ctx.actorType !== 'user' || !ctx.userId) throw forbidden('Only a signed-in staff member can save reports');
    return ctx.userId;
  }

  private view(r: Row, userId: string): SavedReport {
    const mine = r.user_id === userId;
    return {
      id: r.id, name: r.name, section: r.section as ReportSection, view: r.view, branchId: r.branch_id, shared: r.shared, mine,
      authorName: mine ? null : r.author_name ?? null, createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)!,
    };
  }

  private async assertBranch(tx: Tx, ctx: TenantContext, branchId: string | null) {
    if (!branchId) return;
    ctx.assertBranch(branchId);
    if (!(await tx.maybeOne(`select 1 from branches where id = $1 and org_id = $2`, [branchId, ctx.orgId]))) {
      throw invalid('unknown_branch', 'This branch does not exist');
    }
  }

  list(ctx: TenantContext, q: SavedReportListQuery) {
    const userId = this.userOf(ctx);
    const k = keyset(q.cursor);
    return this.db.scoped(ctx, async (tx) => pageOf(await tx.query<Row>(
      `select ${SELECT}, ${cursorAt('r.updated_at')} as sort_key
         from saved_reports r left join profiles p on p.id = r.user_id
        where r.org_id = $1
          and ($2::text is null or r.section = $2)
          and ($3 = 'all' or ($3 = 'mine' and r.user_id = $4) or ($3 = 'shared' and r.user_id <> $4))
          ${k.after('r.updated_at', 'r.id', 5)}
        order by r.updated_at desc, r.id desc limit ${k.fetch(q.limit)}`,
      [ctx.orgId, q.section ?? null, q.owner, userId, ...k.params]), q.limit, (r) => ({ at: r.sort_key!, id: r.id }), (r) => this.view(r, userId)));
  }

  get(ctx: TenantContext, id: string) {
    const userId = this.userOf(ctx);
    return this.db.scoped(ctx, async (tx) => {
      const r = await tx.maybeOne<Row>(`select ${SELECT} from saved_reports r left join profiles p on p.id = r.user_id where r.id = $1 and r.org_id = $2`,
        [id, ctx.orgId]);
      if (!r) throw notFound('Saved report');
      return this.view(r, userId);
    });
  }

  create(ctx: TenantContext, input: SavedReportInput) {
    const userId = this.userOf(ctx);
    const branchId = input.branchId ?? null;
    return this.db.scoped(ctx, async (tx) => {
      await this.assertBranch(tx, ctx, branchId);
      await tx.query(`select pg_advisory_xact_lock(hashtextextended('saved_reports:' || $1::text || ':' || $2::text, 0))`, [ctx.orgId, userId]);
      const { n } = await tx.one<{ n: number }>(`select count(*)::int as n from saved_reports where org_id = $1 and user_id = $2`, [ctx.orgId, userId]);
      if (n >= SAVED_REPORT_LIMIT_PER_USER) {
        throw invalid('saved_report_limit_reached', `You can keep up to ${SAVED_REPORT_LIMIT_PER_USER} saved reports; delete one first`);
      }
      let row: Row;
      try {
        row = await tx.one<Row>(
          `insert into saved_reports(org_id, user_id, branch_id, name, section, view, shared) values ($1, $2, $3, $4, $5, $6, $7)
           returning id, user_id, branch_id, name, section, view, shared, created_at, updated_at`,
          [ctx.orgId, userId, branchId, input.name, input.section, input.view, input.shared ?? false]);
      } catch (e) {
        if (isUnique(e)) throw conflict('saved_report_name_taken', 'You already have a saved report with this name');
        throw e;
      }
      await this.audit.record(tx, ctx, { action: 'insights.report_saved', entityType: 'saved_report', entityId: row.id, branchId,
        metadata: { section: row.section, shared: row.shared } });
      return this.view(row, userId);
    });
  }

  update(ctx: TenantContext, id: string, input: SavedReportUpdate) {
    const userId = this.userOf(ctx);
    return this.db.scoped(ctx, async (tx) => {
      const r = await this.lockOwn(tx, ctx, id, userId);
      if (input.view) {
        const unknown = unknownReportFilters(r.section as ReportSection, input.view.filters);
        if (unknown.length) throw badRequest('validation_failed', `Not a filter of the ${r.section} view: ${unknown.join(', ')}`, { fields: unknown });
      }
      const branchId = input.branchId !== undefined ? input.branchId : r.branch_id;
      if (input.branchId !== undefined && input.branchId !== r.branch_id) await this.assertBranch(tx, ctx, branchId);
      let row: Row;
      try {
        row = await tx.one<Row>(
          `update saved_reports set name = $2, view = $3, branch_id = $4, shared = $5 where id = $1
           returning id, user_id, branch_id, name, section, view, shared, created_at, updated_at`,
          [id, input.name ?? r.name, input.view ?? r.view, branchId, input.shared ?? r.shared]);
      } catch (e) {
        if (isUnique(e)) throw conflict('saved_report_name_taken', 'You already have a saved report with this name');
        throw e;
      }
      await this.audit.record(tx, ctx, { action: 'insights.report_updated', entityType: 'saved_report', entityId: id, branchId,
        metadata: { fields: Object.keys(input), shared: row.shared } });
      return this.view(row, userId);
    });
  }

  remove(ctx: TenantContext, id: string) {
    const userId = this.userOf(ctx);
    return this.db.scoped(ctx, async (tx) => {
      const r = await this.lockOwn(tx, ctx, id, userId);
      await tx.query(`delete from saved_reports where id = $1`, [id]);
      await this.audit.record(tx, ctx, { action: 'insights.report_deleted', entityType: 'saved_report', entityId: id, branchId: r.branch_id,
        metadata: { section: r.section } });
      return { id, deleted: true };
    });
  }

  /** The caller's own report, locked: a colleague's (even shared) or another restaurant's is not found. */
  private async lockOwn(tx: Tx, ctx: TenantContext, id: string, userId: string): Promise<Row> {
    const r = await tx.maybeOne<Row>(`select * from saved_reports where id = $1 and org_id = $2 and user_id = $3 for update`, [id, ctx.orgId, userId]);
    if (!r) throw notFound('Saved report');
    return r;
  }
}
