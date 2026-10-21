import { Injectable } from '@nestjs/common';
import {
  pointsFor, pointsToReverse, rewardDiscount,
  type LoyaltyBalance, type LoyaltyLedgerEntry, type LoyaltyLedgerKind, type LoyaltyProgram, type LoyaltyProgramInput, type LoyaltyReward, type QuoteLoyalty,
} from '@resuto/contracts';
import type { TenantContext } from '../../common/auth/context';
import { DbService, type Tx } from '../../common/db/db.service';
import { DomainError, invalid, notFound } from '../../common/errors/domain-error';
import { AuditService } from '../../common/platform/audit.service';
import type { LoyaltyPort, LoyaltyPriceInput } from '../kernel/ports';

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

export const DEFAULT_PROGRAM: LoyaltyProgramInput = {
  isActive: false, earnMode: 'spend', pointsPerUnit: 1, unitMinor: 100, stampsPerVisit: 1, rounding: 'floor', minOrderMinor: 0,
  eligibleChannels: null, eligibleBranchIds: null, excludedProductIds: [], expiryDays: null,
};

interface ProgramRow {
  is_active: boolean; earn_mode: 'spend' | 'visit'; points_per_unit: string; unit_minor: number; stamps_per_visit: number;
  rounding: 'floor' | 'round' | 'ceil'; min_order_minor: string; eligible_channels: string[] | null; eligible_branch_ids: string[] | null;
  excluded_product_ids: string[]; expiry_days: number | null; updated_at: Date | null;
}
const toProgram = (r: ProgramRow | null): LoyaltyProgram => r ? {
  isActive: r.is_active, earnMode: r.earn_mode, pointsPerUnit: Number(r.points_per_unit), unitMinor: r.unit_minor, stampsPerVisit: r.stamps_per_visit,
  rounding: r.rounding, minOrderMinor: Number(r.min_order_minor), eligibleChannels: r.eligible_channels as any, eligibleBranchIds: r.eligible_branch_ids,
  excludedProductIds: r.excluded_product_ids ?? [], expiryDays: r.expiry_days, updatedAt: iso(r.updated_at),
} : { ...DEFAULT_PROGRAM, updatedAt: null };
const toReward = (r: any): LoyaltyReward => ({
  id: r.id, name: r.name, nameAr: r.name_ar, pointsCost: r.points_cost, kind: r.kind, value: Number(r.value),
  maxDiscountMinor: r.max_discount_minor === null ? null : Number(r.max_discount_minor), minOrderMinor: Number(r.min_order_minor), isActive: r.is_active,
});

export interface AppendInput {
  customerId: string; kind: LoyaltyLedgerKind; points: number; idempotencyKey: string; actor: string;
  orderId?: string | null; paymentId?: string | null; rewardId?: string | null; discountMinor?: number | null; reason?: string | null; expiresAt?: Date | null;
}

/**
 * Loyalty (FT-03). The ledger is the source of truth: every change of points is one append-only row, written under
 * the customer's account row lock with an idempotency key, and the account keeps the running balance for fast reads.
 * Earning happens only when an order is fully paid (order.paid); refunds and cancellations reverse it; redemptions
 * are an order discount computed by the kernel pricing engine through LoyaltyPort and committed in the order's
 * transaction.
 */
@Injectable()
export class LoyaltyService implements LoyaltyPort {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  // -------------------------------------------------------------------------
  // Ledger core
  // -------------------------------------------------------------------------
  /**
   * Appends one ledger row and moves the balance, idempotently. Returns the existing row for a repeated key.
   * A redeem, negative adjustment or expiry that would take the balance below zero is refused under the account row
   * lock (409 loyalty_insufficient_points / loyalty_negative_balance), so a concurrent redemption cannot be overdrawn.
   * Exempt: reverse_earn (a refund after the points were spent) and the customer-merge pair, which moves a balance as is.
   */
  async append(tx: Tx, orgId: string, e: AppendInput): Promise<{ id: string; balanceAfter: number; created: boolean }> {
    if (!Number.isSafeInteger(e.points) || e.points === 0) throw invalid('invalid_points', 'Points must be a non-zero whole number');
    await tx.query(`insert into loyalty_accounts(org_id, customer_id) values ($1, $2) on conflict do nothing`, [orgId, e.customerId]);
    const acct = await tx.one<{ balance: number }>(`select balance from loyalty_accounts where org_id = $1 and customer_id = $2 for update`, [orgId, e.customerId]);
    const existing = await tx.maybeOne<{ id: string; balance_after: number }>(
      'select id, balance_after from loyalty_ledger where org_id = $1 and idempotency_key = $2', [orgId, e.idempotencyKey]);
    if (existing) return { id: existing.id, balanceAfter: existing.balance_after, created: false };
    const after = acct.balance + e.points;
    if (e.points < 0 && after < 0 && (e.kind === 'redeem' || e.kind === 'adjust' || e.kind === 'expire') && !e.idempotencyKey.startsWith('merge-')) {
      if (e.kind === 'redeem') throw new DomainError('loyalty_insufficient_points', 'Not enough points for this reward', 409, { balance: acct.balance, required: -e.points });
      throw new DomainError('loyalty_negative_balance', 'An adjustment cannot take the balance below zero', 409, { balance: acct.balance });
    }
    const row = await tx.one<{ id: string }>(
      `insert into loyalty_ledger(org_id, customer_id, kind, points, balance_after, order_id, payment_id, reward_id, discount_minor, reason, actor, idempotency_key, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id`,
      [orgId, e.customerId, e.kind, e.points, after, e.orderId ?? null, e.paymentId ?? null, e.rewardId ?? null, e.discountMinor ?? null,
        e.reason ?? null, e.actor, e.idempotencyKey, e.expiresAt ?? null]);
    await tx.query(
      `update loyalty_accounts set balance = $3, lifetime_earned = lifetime_earned + $4, updated_at = now() where org_id = $1 and customer_id = $2`,
      [orgId, e.customerId, after, e.kind === 'earn' ? e.points : e.kind === 'reverse_earn' ? e.points : 0]);
    return { id: row.id, balanceAfter: after, created: true };
  }

  async program(tx: Tx, orgId: string): Promise<LoyaltyProgram> {
    return toProgram(await tx.maybeOne<ProgramRow>('select * from loyalty_programs where org_id = $1', [orgId]));
  }

  /** Eligible spend of an order: subtotal of non-excluded items minus their share of the discount. */
  private eligibleSpend(lines: Array<{ productId: string; lineTotalMinor: number }>, subtotalMinor: number, discountMinor: number, excluded: string[]) {
    const eligible = lines.filter((l) => !excluded.includes(l.productId)).reduce((s, l) => s + l.lineTotalMinor, 0);
    if (subtotalMinor <= 0 || eligible <= 0) return 0;
    const share = Math.ceil((discountMinor * eligible) / subtotalMinor);
    return Math.max(0, eligible - share);
  }

  private eligible(p: LoyaltyProgram, o: { branchId: string; channel: string; subtotalMinor: number }) {
    if (!p.isActive) return false;
    if (p.eligibleChannels && !p.eligibleChannels.includes(o.channel as any)) return false;
    if (p.eligibleBranchIds && !p.eligibleBranchIds.includes(o.branchId)) return false;
    return o.subtotalMinor >= p.minOrderMinor;
  }

  // -------------------------------------------------------------------------
  // LoyaltyPort (kernel pricing / placement)
  // -------------------------------------------------------------------------
  async priceOrder(tx: Tx, orgId: string, q: LoyaltyPriceInput): Promise<QuoteLoyalty | null> {
    // Loyalty is part of Resuto Marketing: without the module nothing is earned or redeemed.
    const { ok } = await tx.one<{ ok: boolean }>(`select app.module_enabled($1, 'marketing') as ok`, [orgId]);
    if (!ok) {
      if (q.rewardId) throw new DomainError('module_not_entitled', 'Loyalty is part of Resuto Marketing, which this plan does not include', 402);
      return null;
    }
    const p = await this.program(tx, orgId);
    if (!p.isActive && !q.rewardId) return null;
    let reward: QuoteLoyalty['reward'] = null;
    let balance: number | null = null;
    if (q.customerId && q.identified) {
      balance = (await tx.maybeOne<{ balance: number }>('select balance from loyalty_accounts where org_id = $1 and customer_id = $2', [orgId, q.customerId]))?.balance ?? 0;
    }
    if (q.rewardId) {
      if (!p.isActive) throw new DomainError('loyalty_inactive', 'The loyalty programme is not active', 409);
      if (!q.customerId || !q.identified) throw new DomainError('loyalty_customer_required', 'Identify the customer to redeem points', 409);
      const r = await tx.maybeOne<any>('select * from loyalty_rewards where id = $1 and org_id = $2 and is_active', [q.rewardId, orgId]);
      if (!r) throw new DomainError('loyalty_reward_unavailable', 'This reward is not available', 409);
      const rw = toReward(r);
      if (q.subtotalMinor < rw.minOrderMinor) throw new DomainError('loyalty_reward_minimum', 'The order is below this reward’s minimum', 409, { minOrderMinor: rw.minOrderMinor });
      if ((balance ?? 0) < rw.pointsCost) throw new DomainError('loyalty_insufficient_points', 'Not enough points for this reward', 409, { balance, required: rw.pointsCost });
      const discountMinor = rewardDiscount(rw, q.subtotalMinor - q.discountMinor);
      if (discountMinor <= 0) throw new DomainError('loyalty_reward_no_effect', 'This reward does not apply to this order', 409);
      reward = { id: rw.id, name: rw.name, nameAr: rw.nameAr, pointsCost: rw.pointsCost, discountMinor };
    }
    const discount = q.discountMinor + (reward?.discountMinor ?? 0);
    const earnPreview = this.eligible(p, { branchId: q.branchId, channel: q.channel ?? 'staff', subtotalMinor: q.subtotalMinor })
      ? pointsFor(p, this.eligibleSpend(q.lines, q.subtotalMinor, discount, p.excludedProductIds)) : null;
    return { reward, earnPreview, balance: balance === null ? null : balance };
  }

  async commitRedemption(tx: Tx, ctx: TenantContext, r: { orderId: string; customerId: string; rewardId: string; pointsCost: number; discountMinor: number }) {
    await this.append(tx, ctx.orgId, {
      customerId: r.customerId, kind: 'redeem', points: -r.pointsCost, orderId: r.orderId, rewardId: r.rewardId, discountMinor: r.discountMinor,
      idempotencyKey: `redeem:${r.orderId}`, actor: `${ctx.actorType}:${ctx.actorId}`,
    });
  }

  // -------------------------------------------------------------------------
  // Earning and reversal (worker)
  // -------------------------------------------------------------------------
  /** Earns points for a fully paid order (once). Returns the points earned (0 when not eligible). */
  async earnForOrder(tx: Tx, orgId: string, orderId: string): Promise<number> {
    const o = await tx.maybeOne<any>(
      `select id, branch_id, channel, customer_id, status, subtotal_minor, discount_minor, total_minor, paid_minor, refunded_minor from orders where id = $1 and org_id = $2`, [orderId, orgId]);
    if (!o || !o.customer_id || o.status === 'cancelled') return 0;
    if (Number(o.paid_minor) - Number(o.refunded_minor) < Number(o.total_minor) || Number(o.total_minor) <= 0) return 0; // PAID orders only
    const p = await this.program(tx, orgId);
    if (!this.eligible(p, { branchId: o.branch_id, channel: o.channel, subtotalMinor: Number(o.subtotal_minor) })) return 0;
    const lines = await tx.query<{ product_id: string; line_total_minor: string }>(
      `select product_id, line_total_minor from order_lines where order_id = $1 and kitchen_status <> 'cancelled'`, [orderId]);
    const spend = this.eligibleSpend(lines.map((l) => ({ productId: l.product_id, lineTotalMinor: Number(l.line_total_minor) })),
      Number(o.subtotal_minor), Number(o.discount_minor), p.excludedProductIds);
    const points = pointsFor(p, spend);
    if (points <= 0) return 0;
    const res = await this.append(tx, orgId, {
      customerId: o.customer_id, kind: 'earn', points, orderId, idempotencyKey: `earn:${orderId}`, actor: 'system:loyalty',
      reason: p.earnMode === 'visit' ? 'visit' : `spend ${spend}`, expiresAt: p.expiryDays ? new Date(Date.now() + p.expiryDays * 86_400_000) : null,
    });
    return res.created ? points : 0;
  }

  /**
   * Brings the order's ledger in line with its refunds/cancellation: earned points are reversed in proportion to the
   * refunded amount (all of them when cancelled or fully refunded); redeemed points are returned when the order is
   * cancelled or fully refunded. Each step is keyed by the order state, so repeats are no-ops.
   */
  async reconcileOrder(tx: Tx, orgId: string, orderId: string, paymentId: string | null = null): Promise<{ reversed: number; returned: number }> {
    const o = await tx.maybeOne<any>('select id, customer_id, status, paid_minor, refunded_minor, total_minor from orders where id = $1 and org_id = $2', [orderId, orgId]);
    if (!o) return { reversed: 0, returned: 0 };
    const rows = await tx.query<{ kind: string; points: number; customer_id: string; reward_id: string | null }>(
      `select kind, points, customer_id, reward_id from loyalty_ledger where org_id = $1 and order_id = $2`, [orgId, orderId]);
    if (!rows.length) return { reversed: 0, returned: 0 };
    const sum = (k: string) => rows.filter((r) => r.kind === k).reduce((s, r) => s + r.points, 0);
    const earned = sum('earn');
    const alreadyReversed = -sum('reverse_earn');
    const redeemed = -sum('redeem');
    const returnedBefore = sum('reverse_redeem');
    const cancelled = o.status === 'cancelled';
    const paid = Number(o.paid_minor);
    const refunded = Number(o.refunded_minor);
    const fullyRefunded = paid > 0 && refunded >= paid;
    // The order's current customer (a merge moves orders and balances to the surviving profile).
    const customerId: string = o.customer_id ?? rows[0]!.customer_id;
    let reversed = 0, returned = 0;

    const target = cancelled ? earned : pointsToReverse(earned, paid, refunded);
    if (target > alreadyReversed) {
      reversed = target - alreadyReversed;
      await this.append(tx, orgId, { customerId, kind: 'reverse_earn', points: -reversed, orderId, paymentId,
        idempotencyKey: `reverse_earn:${orderId}:${target}`, actor: 'system:loyalty', reason: cancelled ? 'order cancelled' : `refunded ${refunded} of ${paid}` });
    }
    if ((cancelled || fullyRefunded) && redeemed > returnedBefore) {
      returned = redeemed - returnedBefore;
      await this.append(tx, orgId, { customerId, kind: 'reverse_redeem', points: returned, orderId, paymentId,
        rewardId: rows.find((r) => r.kind === 'redeem')?.reward_id ?? null, idempotencyKey: `reverse_redeem:${orderId}`, actor: 'system:loyalty',
        reason: cancelled ? 'order cancelled' : 'order fully refunded' });
    }
    return { reversed, returned };
  }

  /** Orders a refunded payment was allocated to (refunds move money per allocation). */
  ordersOfPayment(tx: Tx, paymentId: string) {
    return tx.query<{ order_id: string }>('select distinct order_id from payment_allocations where payment_id = $1', [paymentId]);
  }

  /**
   * Expires points earned more than `expiry_days` ago that were not used, oldest first (FIFO): what the expired lots
   * still hold (their earn net of reverse_earn on the same orders) minus what the customer actually used (redeemed net
   * of returned redemptions, earlier expiries, negative adjustments), capped at the balance. A refund of a newer order
   * reverses that order's own lot, so it does not shield an old lot from expiring.
   */
  async expireDue(tx: Tx, orgId: string, now = new Date()): Promise<number> {
    const due = await tx.query<{ customer_id: string; boundary: Date }>(
      `select customer_id, max(expires_at) as boundary from loyalty_ledger
        where org_id = $1 and kind = 'earn' and expires_at is not null and expires_at <= $2 group by customer_id`, [orgId, now]);
    let total = 0;
    for (const d of due) {
      const r = await tx.one<{ expired_lots: number; debits: number; balance: number }>(
        `with lots as (select order_id from loyalty_ledger where org_id = $1 and customer_id = $2 and kind = 'earn' and expires_at is not null and expires_at <= $3)
         select coalesce(sum(points) filter (where kind = 'earn' and expires_at is not null and expires_at <= $3), 0)::int
                  + coalesce(sum(points) filter (where kind = 'reverse_earn' and order_id in (select order_id from lots where order_id is not null)), 0)::int as expired_lots,
                coalesce(-sum(points) filter (where kind in ('redeem', 'reverse_redeem', 'expire') or (kind = 'adjust' and points < 0 and idempotency_key not like 'merge-%')), 0)::int as debits,
                coalesce((select balance from loyalty_accounts where org_id = $1 and customer_id = $2), 0) as balance
           from loyalty_ledger where org_id = $1 and customer_id = $2`, [orgId, d.customer_id, d.boundary]);
      const points = Math.min(Math.max(0, r.expired_lots - r.debits), Math.max(0, r.balance));
      if (points <= 0) continue;
      const res = await this.append(tx, orgId, { customerId: d.customer_id, kind: 'expire', points: -points,
        idempotencyKey: `expire:${d.customer_id}:${new Date(d.boundary).toISOString()}`, actor: 'system:loyalty', reason: 'points expired' });
      if (res.created) total += points;
    }
    return total;
  }

  // -------------------------------------------------------------------------
  // Staff API
  // -------------------------------------------------------------------------
  getProgram(ctx: TenantContext) {
    return this.db.scoped(ctx, async (tx) => ({ program: await this.program(tx, ctx.orgId), rewards: (await tx.query('select * from loyalty_rewards where org_id = $1 order by points_cost, name', [ctx.orgId])).map(toReward) }));
  }

  saveProgram(ctx: TenantContext, input: LoyaltyProgramInput) {
    return this.db.scoped(ctx, async (tx) => {
      if (input.eligibleBranchIds?.length) {
        const { n } = await tx.one<{ n: number }>('select count(*)::int as n from branches where org_id = $1 and id = any($2::uuid[])', [ctx.orgId, input.eligibleBranchIds]);
        if (n !== new Set(input.eligibleBranchIds).size) throw invalid('unknown_branch', 'A selected branch does not belong to this restaurant');
      }
      if (input.excludedProductIds.length) {
        const { n } = await tx.one<{ n: number }>('select count(*)::int as n from products where org_id = $1 and id = any($2::uuid[])', [ctx.orgId, input.excludedProductIds]);
        if (n !== new Set(input.excludedProductIds).size) throw invalid('unknown_product', 'An excluded item does not belong to this restaurant');
      }
      const before = await this.program(tx, ctx.orgId);
      await tx.query(
        `insert into loyalty_programs(org_id, is_active, earn_mode, points_per_unit, unit_minor, stamps_per_visit, rounding, min_order_minor,
            eligible_channels, eligible_branch_ids, excluded_product_ids, expiry_days, updated_at, updated_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now(), $13)
         on conflict (org_id) do update set is_active = excluded.is_active, earn_mode = excluded.earn_mode, points_per_unit = excluded.points_per_unit,
           unit_minor = excluded.unit_minor, stamps_per_visit = excluded.stamps_per_visit, rounding = excluded.rounding, min_order_minor = excluded.min_order_minor,
           eligible_channels = excluded.eligible_channels, eligible_branch_ids = excluded.eligible_branch_ids, excluded_product_ids = excluded.excluded_product_ids,
           expiry_days = excluded.expiry_days, updated_at = now(), updated_by = excluded.updated_by`,
        [ctx.orgId, input.isActive, input.earnMode, input.pointsPerUnit, input.unitMinor, input.stampsPerVisit, input.rounding, input.minOrderMinor,
          input.eligibleChannels, input.eligibleBranchIds, input.excludedProductIds, input.expiryDays, ctx.userId]);
      const { updatedAt: _u, ...prev } = before;
      await this.audit.record(tx, ctx, { action: 'loyalty.program.saved', entityType: 'loyalty_program', entityId: ctx.orgId, metadata: { before: prev, after: input } });
      return this.program(tx, ctx.orgId);
    });
  }

  createReward(ctx: TenantContext, input: { name: string; nameAr?: string | null; pointsCost: number; kind: 'fixed' | 'percent'; value: number; maxDiscountMinor?: number | null; minOrderMinor?: number; isActive?: boolean }) {
    return this.db.scoped(ctx, async (tx) => {
      const r = await tx.one(
        `insert into loyalty_rewards(org_id, name, name_ar, points_cost, kind, value, max_discount_minor, min_order_minor, is_active)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning *`,
        [ctx.orgId, input.name, input.nameAr ?? null, input.pointsCost, input.kind, input.value, input.maxDiscountMinor ?? null, input.minOrderMinor ?? 0, input.isActive ?? true]);
      await this.audit.record(tx, ctx, { action: 'loyalty.reward.created', entityType: 'loyalty_reward', entityId: r.id, metadata: { pointsCost: input.pointsCost, kind: input.kind, value: input.value } });
      return toReward(r);
    });
  }

  updateReward(ctx: TenantContext, id: string, input: Record<string, unknown>) {
    return this.db.scoped(ctx, async (tx) => {
      const has = (k: string) => Object.prototype.hasOwnProperty.call(input, k);
      const r = await tx.maybeOne(
        `update loyalty_rewards set name = coalesce($3, name), name_ar = case when $4 then $5 else name_ar end, points_cost = coalesce($6, points_cost),
            max_discount_minor = case when $7 then $8 else max_discount_minor end, min_order_minor = coalesce($9, min_order_minor), is_active = coalesce($10, is_active)
          where id = $1 and org_id = $2 returning *`,
        [id, ctx.orgId, input.name ?? null, has('nameAr'), input.nameAr ?? null, input.pointsCost ?? null, has('maxDiscountMinor'), input.maxDiscountMinor ?? null,
          input.minOrderMinor ?? null, input.isActive ?? null]);
      if (!r) throw notFound('Reward');
      await this.audit.record(tx, ctx, { action: 'loyalty.reward.updated', entityType: 'loyalty_reward', entityId: id, metadata: { fields: Object.keys(input) } });
      return toReward(r);
    });
  }

  balance(ctx: TenantContext, customerId: string): Promise<LoyaltyBalance> {
    return this.db.scoped(ctx, async (tx) => {
      const c = await tx.maybeOne('select 1 from customers where id = $1 and org_id = $2', [customerId, ctx.orgId]);
      if (!c) throw notFound('Customer');
      const a = await tx.maybeOne<{ balance: number; lifetime_earned: number }>('select balance, lifetime_earned from loyalty_accounts where org_id = $1 and customer_id = $2', [ctx.orgId, customerId]);
      const soon = await tx.maybeOne<{ points: number; at: Date }>(
        `select sum(points)::int as points, min(expires_at) as at from loyalty_ledger
          where org_id = $1 and customer_id = $2 and kind = 'earn' and expires_at > now() and expires_at <= now() + interval '30 days' having count(*) > 0`,
        [ctx.orgId, customerId]);
      return { customerId, balance: a?.balance ?? 0, lifetimeEarned: a?.lifetime_earned ?? 0,
        expiringSoon: soon && a && a.balance > 0 ? { points: Math.min(soon.points, a.balance), at: new Date(soon.at).toISOString() } : null };
    });
  }

  /**
   * FT-03: what staff may redeem for a customer at the till (new order / customer card): the balance and the active
   * rewards, each marked affordable or not. Empty while the programme is off.
   */
  redeemable(ctx: TenantContext, customerId: string) {
    return this.db.scoped(ctx, async (tx) => {
      const c = await tx.maybeOne<{ display_name: string | null }>(
        'select display_name from customers where id = $1 and org_id = $2 and anonymized_at is null and merged_into_id is null', [customerId, ctx.orgId]);
      if (!c) throw notFound('Customer');
      const p = await this.program(tx, ctx.orgId);
      const balance = (await tx.maybeOne<{ balance: number }>('select balance from loyalty_accounts where org_id = $1 and customer_id = $2', [ctx.orgId, customerId]))?.balance ?? 0;
      const rewards = p.isActive ? (await tx.query('select * from loyalty_rewards where org_id = $1 and is_active order by points_cost, name', [ctx.orgId])).map(toReward) : [];
      return { customerId, displayName: c.display_name, active: p.isActive, balance, rewards: rewards.map((r) => ({ ...r, affordable: balance >= r.pointsCost })) };
    });
  }

  ledger(ctx: TenantContext, q: { customerId?: string; kind?: LoyaltyLedgerKind; limit: number; cursor?: string }) {
    return this.db.scoped(ctx, async (tx) => {
      const rows = await tx.query<any>(
        `select l.*, c.display_name, o.number as order_number from loyalty_ledger l
           join customers c on c.id = l.customer_id left join orders o on o.id = l.order_id
          where l.org_id = $1 and ($2::uuid is null or l.customer_id = $2) and ($3::text is null or l.kind = $3)
            and ($4::timestamptz is null or l.created_at < $4)
          order by l.created_at desc, l.seq desc limit $5`,
        [ctx.orgId, q.customerId ?? null, q.kind ?? null, q.cursor ?? null, q.limit]);
      const items: LoyaltyLedgerEntry[] = rows.map((r) => ({
        id: r.id, customerId: r.customer_id, customerName: r.display_name, kind: r.kind, points: r.points, balanceAfter: r.balance_after,
        orderId: r.order_id, orderNumber: r.order_number, rewardId: r.reward_id, discountMinor: r.discount_minor === null ? null : Number(r.discount_minor),
        reason: r.reason, actor: r.actor, expiresAt: iso(r.expires_at), createdAt: iso(r.created_at)!,
      }));
      const totals = await tx.one<{ outstanding: number; members: number }>(
        `select coalesce(sum(balance) filter (where balance > 0), 0)::int as outstanding, count(*) filter (where balance > 0)::int as members from loyalty_accounts where org_id = $1`, [ctx.orgId]);
      return { items, nextCursor: rows.length === q.limit ? items.at(-1)!.createdAt : null, totals };
    });
  }

  adjust(ctx: TenantContext, input: { customerId: string; points: number; reason: string }, idempotencyKey?: string) {
    return this.db.scoped(ctx, async (tx) => {
      const c = await tx.maybeOne('select 1 from customers where id = $1 and org_id = $2', [input.customerId, ctx.orgId]);
      if (!c) throw notFound('Customer');
      const bal = (await tx.maybeOne<{ balance: number }>('select balance from loyalty_accounts where org_id = $1 and customer_id = $2', [ctx.orgId, input.customerId]))?.balance ?? 0;
      if (bal + input.points < 0) throw new DomainError('loyalty_negative_balance', 'An adjustment cannot take the balance below zero', 409, { balance: bal });
      const key = `adjust:${ctx.userId}:${idempotencyKey ?? `${Date.now()}:${Math.random().toString(36).slice(2)}`}`;
      const res = await this.append(tx, ctx.orgId, { customerId: input.customerId, kind: 'adjust', points: input.points, reason: input.reason,
        idempotencyKey: key, actor: `${ctx.actorType}:${ctx.actorId}` });
      if (res.created) {
        await this.audit.record(tx, ctx, { action: 'loyalty.points.adjusted', entityType: 'customer', entityId: input.customerId,
          metadata: { points: input.points, reason: input.reason, balanceAfter: res.balanceAfter, ledgerId: res.id } });
      }
      return { ledgerId: res.id, balance: res.balanceAfter, replayed: !res.created };
    });
  }
}
