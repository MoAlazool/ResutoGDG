// Loyalty (FT-03): programme rules, rewards, the append-only points ledger and the pure earning maths shared by the
// API and the UI preview. Points are integers; money is minor units.
import { z } from 'zod';

const uuid = z.uuid();
export const LOYALTY_CHANNELS = ['qr', 'web', 'whatsapp', 'staff', 'pos', 'phone', 'messenger', 'instagram'] as const;
export const LOYALTY_LEDGER_KINDS = ['earn', 'redeem', 'reverse_earn', 'reverse_redeem', 'expire', 'adjust'] as const;
export type LoyaltyLedgerKind = (typeof LOYALTY_LEDGER_KINDS)[number];
export type LoyaltyRounding = 'floor' | 'round' | 'ceil';

export const loyaltyProgramInput = z.object({
  isActive: z.boolean(),
  earnMode: z.enum(['spend', 'visit']),
  pointsPerUnit: z.number().min(0).max(1000).multipleOf(0.01),
  unitMinor: z.number().int().min(1).max(10_000_000),
  stampsPerVisit: z.number().int().min(0).max(100),
  rounding: z.enum(['floor', 'round', 'ceil']),
  minOrderMinor: z.number().int().min(0).max(1e12),
  eligibleChannels: z.array(z.enum(LOYALTY_CHANNELS)).min(1).max(LOYALTY_CHANNELS.length).nullable(),
  eligibleBranchIds: z.array(uuid).min(1).max(100).nullable(),
  excludedProductIds: z.array(uuid).max(500),
  expiryDays: z.number().int().min(1).max(3650).nullable(),
}).strict();
export type LoyaltyProgramInput = z.infer<typeof loyaltyProgramInput>;
export interface LoyaltyProgram extends LoyaltyProgramInput { updatedAt: string | null }

export const loyaltyRewardInput = z.object({
  name: z.string().trim().min(1).max(80),
  nameAr: z.string().trim().min(1).max(80).nullable().optional(),
  pointsCost: z.number().int().min(1).max(1_000_000),
  kind: z.enum(['fixed', 'percent']),
  /** Minor units for 'fixed', basis points (1-10000) for 'percent'. */
  value: z.number().int().min(1).max(1e12),
  maxDiscountMinor: z.number().int().min(1).max(1e12).nullable().optional(),
  minOrderMinor: z.number().int().min(0).max(1e12).optional(),
  isActive: z.boolean().optional(),
}).strict().refine((r) => r.kind !== 'percent' || r.value <= 10_000, { message: 'A percent reward is at most 100%', path: ['value'] });
export const loyaltyRewardUpdate = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  nameAr: z.string().trim().min(1).max(80).nullable().optional(),
  pointsCost: z.number().int().min(1).max(1_000_000).optional(),
  maxDiscountMinor: z.number().int().min(1).max(1e12).nullable().optional(),
  minOrderMinor: z.number().int().min(0).max(1e12).optional(),
  isActive: z.boolean().optional(),
}).strict();
export interface LoyaltyReward {
  id: string; name: string; nameAr: string | null; pointsCost: number; kind: 'fixed' | 'percent'; value: number;
  maxDiscountMinor: number | null; minOrderMinor: number; isActive: boolean;
}

export const loyaltyAdjustInput = z.object({
  customerId: uuid,
  /** Signed, non-zero. */
  points: z.number().int().min(-1_000_000).max(1_000_000).refine((n) => n !== 0, 'Points must not be zero'),
  reason: z.string().trim().min(3).max(300),
}).strict();

export const loyaltyLedgerQuery = z.object({
  customerId: uuid.optional(),
  kind: z.enum(LOYALTY_LEDGER_KINDS).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(64).optional(),
});

export interface LoyaltyLedgerEntry {
  id: string; customerId: string; customerName: string | null; kind: LoyaltyLedgerKind; points: number; balanceAfter: number;
  orderId: string | null; orderNumber: string | null; rewardId: string | null; discountMinor: number | null; reason: string | null;
  actor: string; expiresAt: string | null; createdAt: string;
}
export interface LoyaltyBalance { customerId: string; balance: number; lifetimeEarned: number; expiringSoon: { points: number; at: string } | null }

/** What the pricing engine attaches to a quote when a reward is applied (and what an order would earn). */
export interface QuoteLoyalty {
  reward: { id: string; name: string; nameAr: string | null; pointsCost: number; discountMinor: number } | null;
  /** Points this order would earn once paid (null when the programme is off or the order is not eligible). */
  earnPreview: number | null;
  /** The identified customer's balance (only when the channel has verified who the customer is). */
  balance: number | null;
}

/**
 * Points earned for an eligible paid order. `eligibleSpendMinor` is the order subtotal minus excluded items and
 * minus discounts (delivery fee, service charge and tax never earn). Pure and deterministic; the API and the UI
 * preview both use it.
 */
export function pointsFor(rule: { earnMode: 'spend' | 'visit'; pointsPerUnit: number; unitMinor: number; stampsPerVisit: number; rounding: LoyaltyRounding },
  eligibleSpendMinor: number): number {
  if (eligibleSpendMinor <= 0) return 0;
  if (rule.earnMode === 'visit') return rule.stampsPerVisit;
  const raw = (eligibleSpendMinor / rule.unitMinor) * rule.pointsPerUnit;
  // Guard binary noise (e.g. 2.9999999) before rounding.
  const x = Math.round(raw * 1e6) / 1e6;
  return Math.max(0, rule.rounding === 'ceil' ? Math.ceil(x) : rule.rounding === 'round' ? Math.round(x) : Math.floor(x));
}

/** Discount a reward gives on `baseMinor` (subtotal after other discounts), never more than the base. */
export function rewardDiscount(reward: Pick<LoyaltyReward, 'kind' | 'value' | 'maxDiscountMinor'>, baseMinor: number): number {
  if (baseMinor <= 0) return 0;
  let d = reward.kind === 'fixed' ? reward.value : Math.floor((baseMinor * reward.value) / 10_000);
  if (reward.maxDiscountMinor !== null && reward.maxDiscountMinor !== undefined) d = Math.min(d, reward.maxDiscountMinor);
  return Math.max(0, Math.min(d, baseMinor));
}

/**
 * Points to take back when `refundedMinor` of a `paidMinor` order has been refunded, given what it earned:
 * proportional, rounded down in the customer's favour, and never more than earned. Full refunds take everything.
 */
export function pointsToReverse(earned: number, paidMinor: number, refundedMinor: number): number {
  if (earned <= 0 || paidMinor <= 0 || refundedMinor <= 0) return 0;
  if (refundedMinor >= paidMinor) return earned;
  return Math.min(earned, Math.floor((earned * refundedMinor) / paidMinor));
}
