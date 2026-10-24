import { Injectable } from '@nestjs/common';
import { USAGE_LIMIT_FOR, type DowngradeViolation } from '@resuto/contracts';
import type { Tx } from '../../common/db/db.service';
import { DomainError } from '../../common/errors/domain-error';
import { startOfMonth, UsageService } from './usage.service';

/**
 * Synchronous plan-limit checks. Exported (BillingModule is global) so the
 * kernel can call `assertCanPlaceOrder` inside the order transaction.
 */
@Injectable()
export class PlanLimitsService {
  constructor(private readonly usage: UsageService) {}

  async current(tx: Tx, orgId: string): Promise<{ planId: string | null; status: string | null; limits: Record<string, number>; periodStart: Date | null }> {
    const row = await tx.maybeOne<{ plan_id: string; status: string; limits: Record<string, number>; current_period_start: Date }>(
      `select s.plan_id, s.status, p.limits, s.current_period_start
         from subscriptions s join plans p on p.id = s.plan_id where s.org_id = $1 and s.status <> 'canceled'`, [orgId]);
    return { planId: row?.plan_id ?? null, status: row?.status ?? null, limits: row?.limits ?? {}, periodStart: row?.current_period_start ?? null };
  }

  /**
   * Free-plan style monthly order cap (`plans.limits.orders_per_month`) for the
   * current billing period. Throws 402 `plan_limit_reached` when the next order
   * would exceed it. Plans without the limit are unlimited.
   */
  async assertCanPlaceOrder(tx: Tx, orgId: string): Promise<void> {
    const { limits, periodStart } = await this.current(tx, orgId);
    const cap = limits.orders_per_month;
    if (cap === undefined || cap === null || !periodStart) return;
    const { n } = await tx.one<{ n: number }>(
      `select count(*)::int as n from orders where org_id = $1 and placed_at >= $2`, [orgId, periodStart]);
    if (n >= cap) {
      throw new DomainError('plan_limit_reached', `This restaurant's plan allows ${cap} orders per month. Upgrade to keep taking orders.`, 402,
        { limit: 'orders_per_month', current: n, allowed: cap });
    }
  }

  /**
   * Monthly AI request quota (`plans.limits.ai_requests_per_month`) for the
   * current billing period, counted from metered `ai_requests` usage rows.
   * Call it before every model-backed call (AI service or LLM); deterministic
   * features (rule-based insights, template copy, rules assistant) are free.
   * Throws 402 `plan_limit_reached` with `limit: 'ai_requests_per_month'` once
   * `requests` more calls would exceed the cap. Plans without the limit are
   * unlimited. The check and the metering run in separate transactions (the
   * model call happens outside any transaction), so concurrent calls at the
   * boundary can overshoot by at most the number of in-flight requests.
   */
  async assertAiQuota(tx: Tx, orgId: string, requests = 1): Promise<void> {
    const { limits, periodStart } = await this.current(tx, orgId);
    const cap = limits.ai_requests_per_month;
    if (cap === undefined || cap === null) return;
    const from = periodStart ?? startOfMonth(new Date());
    const used = await this.usage.total(tx, orgId, 'ai_requests', from);
    if (used + requests > cap) {
      throw new DomainError('plan_limit_reached',
        cap === 0
          ? 'Resuto Intelligence is not included in this plan. Upgrade to use AI features.'
          : `This restaurant's plan allows ${cap} AI requests per month and they have been used. Upgrade or wait for the next billing period.`,
        402, { limit: 'ai_requests_per_month', current: used, allowed: cap });
    }
  }

  /**
   * Monthly MCP tool-call quota (`plans.limits.mcp_calls_per_month`, USAGE_LIMIT_FOR.mcp_calls) for the current billing
   * period, counted from metered `mcp_calls` usage rows (successful calls and approval requests). Throws 402
   * `plan_limit_reached` with `limit: 'mcp_calls_per_month'` once the cap is used. No plan seeds this limit today, so
   * it is unlimited until a limit is configured (plan §7: limits are set by the owner, never invented here).
   */
  async assertMcpQuota(tx: Tx, orgId: string): Promise<void> {
    const { limits, periodStart } = await this.current(tx, orgId);
    const cap = limits[USAGE_LIMIT_FOR.mcp_calls!];
    if (cap === undefined || cap === null) return;
    const from = periodStart ?? startOfMonth(new Date());
    const used = await this.usage.total(tx, orgId, 'mcp_calls', from);
    if (used + 1 > cap) {
      throw new DomainError('plan_limit_reached',
        cap === 0
          ? 'AI assistant connections (MCP) are not included in this plan. Upgrade to use them.'
          : `This restaurant's plan allows ${cap} AI assistant (MCP) calls per month and they have been used. Upgrade or wait for the next billing period.`,
        402, { limit: 'mcp_calls_per_month', current: used, allowed: cap });
    }
  }

  /** Usage that would exceed `targetLimits` (used to refuse downgrades). Monthly counters reset with the period and are not checked. */
  async violations(tx: Tx, orgId: string, targetLimits: Record<string, number>): Promise<DowngradeViolation[]> {
    const snap = await this.usage.snapshot(tx, orgId);
    const out: DowngradeViolation[] = [];
    for (const key of ['branches', 'staff'] as const) {
      const allowed = targetLimits[key];
      if (allowed !== undefined && snap.usage[key] > allowed) out.push({ limit: key, current: snap.usage[key], allowed });
    }
    return out;
  }
}
