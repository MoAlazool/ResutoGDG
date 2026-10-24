import { CHANGE_OPS, changeOpInputs, type ChangeOpInput } from '@resuto/contracts';
import { conflict, invalid } from '../../../common/errors/domain-error';
import type { PromotionsService } from '../../marketing/promotions.service';
import { fmtMoney, type OpHandler } from '../op-handler';

type PromotionCreate = ChangeOpInput<'promotion.create'>;

/** Discount bounds for offers created through change sets: 1–90 % for percent offers. */
export const PERCENT_MIN_BPS = 100;
export const PERCENT_MAX_BPS = 9000;

const describe = (p: PromotionCreate, currency: string) =>
  p.kind === 'percent' ? `${p.value / 100}% off` : p.kind === 'fixed' ? `${fmtMoney(p.value, currency)} off` : 'free delivery';

export function promotionOps(deps: { promotions: PromotionsService }): OpHandler[] {
  const create: OpHandler<PromotionCreate> = {
    type: 'promotion.create', meta: CHANGE_OPS['promotion.create'], input: changeOpInputs['promotion.create'],
    discountBps: (input) => (input.kind === 'percent' ? input.value : null),
    async validate(tx, ctx, input) {
      if (input.kind === 'percent' && (input.value < PERCENT_MIN_BPS || input.value > PERCENT_MAX_BPS)) {
        throw invalid('discount_out_of_bounds', `Percent offers must be between ${PERCENT_MIN_BPS / 100}% and ${PERCENT_MAX_BPS / 100}%`,
          { minBps: PERCENT_MIN_BPS, maxBps: PERCENT_MAX_BPS, valueBps: input.value });
      }
      if (input.kind === 'fixed' && input.minOrderMinor > 0 && input.value > input.minOrderMinor) {
        throw invalid('discount_out_of_bounds', 'A fixed discount cannot be larger than the minimum order', { valueMinor: input.value, minOrderMinor: input.minOrderMinor });
      }
      if (input.kind === 'fixed' && input.maxDiscountMinor != null && input.value > input.maxDiscountMinor) {
        throw invalid('discount_out_of_bounds', 'A fixed discount cannot be larger than its own cap', { valueMinor: input.value, maxDiscountMinor: input.maxDiscountMinor });
      }
      if (input.endsAt && new Date(input.endsAt).getTime() <= Date.now()) throw invalid('schedule_in_past', 'The offer must end in the future');
      for (const b of input.branchIds ?? []) ctx.assertBranch(b);
      await deps.promotions.checkBranches(tx, ctx, input.branchIds);
      if (input.code && await tx.maybeOne('select 1 from promotions where org_id = $1 and code = $2', [ctx.orgId, input.code])) {
        throw conflict('promotion_code_taken', `The offer code ${input.code} is already in use`);
      }
    },
    async snapshot(_tx, _ctx, input) {
      // A new record: only the code (when there is one) is a shared resource worth locking.
      return { target: input.code ? { type: 'promotion_code', id: input.code } : null, version: null, before: null };
    },
    async preview(tx, ctx, input) {
      const org = await tx.one<{ currency: string }>('select currency from organizations where id = $1', [ctx.orgId]);
      const what = describe(input, org.currency);
      const window = input.endsAt ? `, until ${input.endsAt}` : '';
      return {
        summary: `Create the offer "${input.name}" (${what}${input.code ? `, code ${input.code}` : ''}${window})`,
        changes: [{ label: 'Offer', before: null, after: `${input.name}: ${what}${input.minOrderMinor ? `, minimum order ${fmtMoney(input.minOrderMinor, org.currency)}` : ''}${window}` }],
        after: { name: input.name, kind: input.kind, value: input.value, code: input.code ?? null, isActive: input.isActive },
      };
    },
    async applyLocal(tx, ctx, input) {
      const p = await deps.promotions.createTx(tx, ctx, input);
      return { promotionId: p.id, code: p.code ?? null };
    },
  };
  return [create];
}
