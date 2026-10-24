import { Injectable } from '@nestjs/common';
import type { PromotionInput } from '@resuto/contracts';
import type { TenantContext } from '../../common/auth/context';
import { DbService, type Tx } from '../../common/db/db.service';
import { conflict, invalid, notFound } from '../../common/errors/domain-error';
import { cursorAt, keyset, pageOf } from '../../common/http/pagination';
import { AuditService } from '../../common/platform/audit.service';

const iso = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString() : null);
const view = (r: any) => ({
  id: r.id, code: r.code, name: r.name, nameAr: r.name_ar, kind: r.kind, value: r.value, maxDiscountMinor: r.max_discount_minor, minOrderMinor: r.min_order_minor,
  branchIds: r.branch_ids, channels: r.channels, startsAt: iso(r.starts_at), endsAt: iso(r.ends_at), maxRedemptions: r.max_redemptions,
  perCustomerLimit: r.per_customer_limit, redemptionCount: r.redemption_count, isActive: r.is_active, createdAt: iso(r.created_at),
});

const COLUMNS: Array<[keyof PromotionInput, string]> = [
  ['code', 'code'], ['name', 'name'], ['nameAr', 'name_ar'], ['kind', 'kind'], ['value', 'value'], ['maxDiscountMinor', 'max_discount_minor'],
  ['minOrderMinor', 'min_order_minor'], ['branchIds', 'branch_ids'], ['channels', 'channels'], ['startsAt', 'starts_at'], ['endsAt', 'ends_at'],
  ['maxRedemptions', 'max_redemptions'], ['perCustomerLimit', 'per_customer_limit'], ['isActive', 'is_active'],
];

/** Offer codes. The kernel PricingService applies them at checkout; this module only manages them. */
@Injectable()
export class PromotionsService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  list(ctx: TenantContext, q: { limit: number; cursor?: string }) {
    const k = keyset(q.cursor);
    return this.db.scoped(ctx, async (tx) => pageOf(await tx.query(
      `select *, ${cursorAt('created_at')} as cursor_at from promotions where org_id = $1 ${k.after('created_at', 'id', 2)}
        order by created_at desc, id desc limit ${k.fetch(q.limit)}`, [ctx.orgId, ...k.params]), q.limit, (r) => ({ at: r.cursor_at, id: r.id }), view));
  }

  async checkBranches(tx: Tx, ctx: TenantContext, branchIds: string[] | null | undefined) {
    if (!branchIds?.length) return;
    const { n } = await tx.one(`select count(*)::int as n from branches where org_id = $1 and id = any($2::uuid[])`, [ctx.orgId, branchIds]);
    if (n !== new Set(branchIds).size) throw invalid('unknown_branch', 'A selected branch does not exist');
  }

  create(ctx: TenantContext, input: PromotionInput) {
    return this.db.scoped(ctx, (tx) => this.createTx(tx, ctx, input));
  }

  /** Creates an offer inside the caller's transaction (the route above, and change sets). */
  async createTx(tx: Tx, ctx: TenantContext, input: PromotionInput) {
    await this.checkBranches(tx, ctx, input.branchIds);
    const row = await tx.one(
      `insert into promotions(org_id, code, name, name_ar, kind, value, max_discount_minor, min_order_minor, branch_ids, channels, starts_at, ends_at,
          max_redemptions, per_customer_limit, is_active)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::order_channel[], $11, $12, $13, $14, $15) returning *`,
      [ctx.orgId, input.code ?? null, input.name, input.nameAr ?? null, input.kind, input.kind === 'free_delivery' ? 0 : input.value, input.maxDiscountMinor ?? null,
        input.minOrderMinor, input.branchIds?.length ? input.branchIds : null, input.channels?.length ? input.channels : null, input.startsAt ?? null, input.endsAt ?? null,
        input.maxRedemptions ?? null, input.perCustomerLimit ?? null, input.isActive]);
    await this.audit.record(tx, ctx, { action: 'marketing.promotion_created', entityType: 'promotion', entityId: row.id, metadata: { code: row.code, kind: row.kind } });
    return view(row);
  }

  update(ctx: TenantContext, id: string, input: Partial<PromotionInput>) {
    return this.db.scoped(ctx, async (tx) => {
      const r = await tx.maybeOne(`select * from promotions where id = $1 and org_id = $2 for update`, [id, ctx.orgId]);
      if (!r) throw notFound('Promotion');
      if (r.redemption_count > 0 && (input.kind !== undefined || input.value !== undefined || input.code !== undefined)) {
        throw conflict('promotion_redeemed', 'This offer was already used; create a new one instead of changing its value or code');
      }
      await this.checkBranches(tx, ctx, input.branchIds);
      const sets: string[] = [];
      const params: unknown[] = [id];
      for (const [key, col] of COLUMNS) {
        if (input[key] === undefined) continue;
        params.push(col === 'branch_ids' || col === 'channels' ? ((input[key] as unknown[] | null)?.length ? input[key] : null) : input[key]);
        sets.push(`${col} = $${params.length}${col === 'channels' ? '::order_channel[]' : ''}`);
      }
      const row = sets.length ? await tx.one(`update promotions set ${sets.join(', ')} where id = $1 returning *`, params) : r;
      await this.audit.record(tx, ctx, { action: 'marketing.promotion_updated', entityType: 'promotion', entityId: id, metadata: { fields: Object.keys(input) } });
      return view(row);
    });
  }

  remove(ctx: TenantContext, id: string) {
    return this.db.scoped(ctx, async (tx) => {
      const r = await tx.maybeOne(`select redemption_count from promotions where id = $1 and org_id = $2 for update`, [id, ctx.orgId]);
      if (!r) throw notFound('Promotion');
      if (r.redemption_count > 0) {
        await tx.query(`update promotions set is_active = false where id = $1`, [id]);
        await this.audit.record(tx, ctx, { action: 'marketing.promotion_deactivated', entityType: 'promotion', entityId: id });
        return { id, deleted: false, deactivated: true };
      }
      await tx.query(`delete from promotions where id = $1`, [id]);
      await this.audit.record(tx, ctx, { action: 'marketing.promotion_deleted', entityType: 'promotion', entityId: id });
      return { id, deleted: true, deactivated: false };
    });
  }
}
