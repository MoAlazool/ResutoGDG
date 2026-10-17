import { Injectable } from '@nestjs/common';
import { segmentDefinition, type SegmentGroup } from '@resuto/contracts';
import { ZodError } from 'zod';
import type { TenantContext } from '../../common/auth/context';
import { DbService, type Tx } from '../../common/db/db.service';
import { invalid, notFound } from '../../common/errors/domain-error';
import { AuditService } from '../../common/platform/audit.service';
import type { SegmentsPort } from '../kernel/ports';
import { segmentQuery } from './segment-sql';

const iso = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString() : null);
const view = (r: any) => ({
  id: r.id, name: r.name, description: r.description, kind: r.kind, definition: r.definition, source: r.source, memberCount: r.member_count,
  lastComputedAt: iso(r.last_computed_at), createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
});

/** Customer segments (SEGMENTS_PORT). Membership is recomputed from the rule DSL. */
@Injectable()
export class SegmentsService implements SegmentsPort {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  private validate(definition: unknown): SegmentGroup {
    try {
      return segmentDefinition.parse(definition);
    } catch (e) {
      if (e instanceof ZodError) throw invalid('invalid_segment', 'The segment rules are invalid', e.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
      throw e;
    }
  }

  async count(tx: Tx, orgId: string, definition: unknown) {
    const q = segmentQuery(orgId, this.validate(definition), 'count(*)::int as n, count(*) filter (where c.marketing_consent)::int as consented');
    return tx.one<{ n: number; consented: number }>(q.sql, q.params);
  }

  preview(ctx: TenantContext, definition: unknown) {
    return this.db.scoped(ctx, async (tx) => {
      const r = await this.count(tx, ctx.orgId, definition);
      return { count: r.n, consentedCount: r.consented };
    });
  }

  /** SEGMENTS_PORT: creates and computes a segment (manual, ai, mcp or system source). */
  async create(tx: Tx, ctx: TenantContext, input: { name: string; description?: string | null; definition: unknown; source: 'manual' | 'ai' | 'mcp' | 'system' }) {
    const definition = this.validate(input.definition);
    const name = input.name.trim().slice(0, 80);
    if (!name) throw invalid('name_required', 'Name the segment');
    const row = await tx.one(`insert into segments(org_id, name, description, definition, source, created_by) values ($1, $2, $3, $4, $5, $6) returning *`,
      [ctx.orgId, name, input.description ?? null, definition, input.source, ctx.userId]);
    const memberCount = await this.compute(tx, ctx.orgId, row.id);
    await this.audit.record(tx, ctx, { action: 'marketing.segment_created', entityType: 'segment', entityId: row.id, metadata: { source: input.source, memberCount } });
    return { id: row.id as string, memberCount };
  }

  /** Replaces the member list from the current definition; returns the new count. */
  async compute(tx: Tx, orgId: string, segmentId: string) {
    const s = await tx.maybeOne<{ definition: unknown }>(`select definition from segments where id = $1 and org_id = $2 for update`, [segmentId, orgId]);
    if (!s) throw notFound('Segment');
    const q = segmentQuery(orgId, s.definition);
    await tx.query(`delete from segment_members where segment_id = $1`, [segmentId]);
    const inserted = await tx.query(
      `insert into segment_members(org_id, segment_id, customer_id) select $1::uuid, $${q.params.length + 1}::uuid, x.id from (${q.sql}) x returning customer_id`,
      [...q.params, segmentId]);
    await tx.query(`update segments set member_count = $2, last_computed_at = now() where id = $1`, [segmentId, inserted.length]);
    return inserted.length;
  }

  list(ctx: TenantContext) {
    return this.db.scoped(ctx, async (tx) => ({ items: (await tx.query(`select * from segments where org_id = $1 order by created_at desc`, [ctx.orgId])).map(view), nextCursor: null }));
  }

  get(ctx: TenantContext, id: string) {
    return this.db.scoped(ctx, async (tx) => {
      const r = await tx.maybeOne(`select * from segments where id = $1 and org_id = $2`, [id, ctx.orgId]);
      if (!r) throw notFound('Segment');
      return view(r);
    });
  }

  createFromApi(ctx: TenantContext, input: { name: string; description?: string | null; definition: unknown }) {
    return this.db.scoped(ctx, async (tx) => {
      const r = await this.create(tx, ctx, { ...input, source: 'manual' });
      return view(await tx.one(`select * from segments where id = $1`, [r.id]));
    });
  }

  update(ctx: TenantContext, id: string, input: { name?: string; description?: string | null; definition?: unknown }) {
    return this.db.scoped(ctx, async (tx) => {
      const r = await tx.maybeOne(`select * from segments where id = $1 and org_id = $2 for update`, [id, ctx.orgId]);
      if (!r) throw notFound('Segment');
      const definition = input.definition !== undefined ? this.validate(input.definition) : r.definition;
      await tx.query(`update segments set name = coalesce($2, name), description = case when $3 then $4 else description end, definition = $5 where id = $1`,
        [id, input.name ?? null, input.description !== undefined, input.description ?? null, definition]);
      if (input.definition !== undefined) await this.compute(tx, ctx.orgId, id);
      await this.audit.record(tx, ctx, { action: 'marketing.segment_updated', entityType: 'segment', entityId: id });
      return view(await tx.one(`select * from segments where id = $1`, [id]));
    });
  }

  refresh(ctx: TenantContext, id: string) {
    return this.db.scoped(ctx, async (tx) => {
      await this.compute(tx, ctx.orgId, id);
      return view(await tx.one(`select * from segments where id = $1`, [id]));
    });
  }

  remove(ctx: TenantContext, id: string) {
    return this.db.scoped(ctx, async (tx) => {
      const r = await tx.maybeOne(`delete from segments where id = $1 and org_id = $2 returning id`, [id, ctx.orgId]);
      if (!r) throw notFound('Segment');
      await this.audit.record(tx, ctx, { action: 'marketing.segment_deleted', entityType: 'segment', entityId: id });
      return { id, deleted: true };
    });
  }

  members(ctx: TenantContext, id: string, limit: number) {
    return this.db.scoped(ctx, async (tx) => {
      const s = await tx.maybeOne(`select id from segments where id = $1 and org_id = $2`, [id, ctx.orgId]);
      if (!s) throw notFound('Segment');
      const rows = await tx.query(
        `select c.id, c.display_name, c.phone_e164, c.marketing_consent, c.last_seen_at from segment_members m join customers c on c.id = m.customer_id
          where m.segment_id = $1 order by c.last_seen_at desc limit $2`, [id, limit]);
      return { items: rows.map((r) => ({ id: r.id, name: r.display_name, phone: r.phone_e164, marketingConsent: r.marketing_consent, lastSeenAt: iso(r.last_seen_at) })), nextCursor: null };
    });
  }
}
