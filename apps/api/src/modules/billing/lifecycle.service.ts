import { Injectable, Logger } from '@nestjs/common';
import { DbService, type Tx } from '../../common/db/db.service';
import { EntitlementsService } from '../../common/entitlements/entitlements.service';
import { Scheduled } from '../../common/events/events';
import { OutboxService } from '../../common/platform/outbox.service';
import { CatalogService } from './catalog.service';
import { PlanLimitsService } from './plan-limits.service';
import { GRACE_DAYS, SubscriptionsService, parseModules, type SubRow } from './subscriptions.service';

export interface LifecycleStats { trialsEnded: number; periodsRolled: number; changesApplied: number; changesBlocked: number; canceled: number; graceExpired: number; invoicesDrafted: number }

/**
 * Subscription lifecycle (worker job, every 5 minutes, single runner):
 *
 * 1. Trial end → the first paid period starts at trial end. Without a billing
 *    provider nothing can be charged, so the subscription becomes `past_due`
 *    with `grace_until = now + 7 days` and a draft invoice. Modules stay
 *    enabled during grace (see app.module_enabled).
 * 2. Period end (active / past_due) → apply a scheduled cancellation or
 *    downgrade, then roll the period. Free configurations become `active`;
 *    paid ones become `past_due` (again: no provider) with a draft invoice.
 * 3. Grace expiry (past_due, grace_until passed) → `unpaid` (modules off).
 *
 * `run(now)` takes the clock as a parameter so tests control time.
 */
@Injectable()
export class BillingLifecycleService {
  private readonly logger = new Logger('BillingLifecycle');

  constructor(
    private readonly db: DbService,
    private readonly subs: SubscriptionsService,
    private readonly catalog: CatalogService,
    private readonly limits: PlanLimitsService,
    private readonly outbox: OutboxService,
    private readonly entitlements: EntitlementsService,
  ) {}

  @Scheduled('billing.lifecycle', 300)
  async scheduled() {
    return this.run(new Date());
  }

  async run(now: Date, opts: { orgIds?: string[] } = {}): Promise<LifecycleStats> {
    const stats: LifecycleStats = { trialsEnded: 0, periodsRolled: 0, changesApplied: 0, changesBlocked: 0, canceled: 0, graceExpired: 0, invoicesDrafted: 0 };
    const scope = opts.orgIds ?? null;
    const due = (sql: string) => this.db.withPlatform((tx) => tx.query<{ id: string; org_id: string }>(
      `select id, org_id from subscriptions where ${sql} and ($2::uuid[] is null or org_id = any($2)) order by id limit 500`, [now, scope]));

    for (const s of await due(`status = 'trialing' and trial_ends_at is not null and trial_ends_at <= $1`)) {
      await this.inTenant(s.org_id, async (tx) => {
        const sub = await this.lock(tx, s.id);
        if (sub?.status !== 'trialing' || !sub.trial_ends_at || new Date(sub.trial_ends_at) > now) return;
        stats.trialsEnded++;
        await this.subs.event(tx, sub.org_id, sub.id, 'trial_ended', sub.plan_id, sub.plan_id, { trialEndsAt: new Date(sub.trial_ends_at).toISOString() });
        await this.periodEnd(tx, sub, new Date(sub.trial_ends_at), now, stats);
      });
    }
    for (const s of await due(`status in ('active', 'past_due') and current_period_end <= $1`)) {
      await this.inTenant(s.org_id, async (tx) => {
        const sub = await this.lock(tx, s.id);
        if (!sub || !['active', 'past_due'].includes(sub.status) || new Date(sub.current_period_end) > now) return;
        await this.periodEnd(tx, sub, new Date(sub.current_period_end), now, stats);
      });
    }
    for (const s of await due(`status = 'past_due' and grace_until is not null and grace_until <= $1`)) {
      await this.inTenant(s.org_id, async (tx) => {
        const sub = await this.lock(tx, s.id);
        if (sub?.status !== 'past_due' || !sub.grace_until || new Date(sub.grace_until) > now) return;
        await tx.query(`update subscriptions set status = 'unpaid' where id = $1`, [sub.id]);
        await this.subs.event(tx, sub.org_id, sub.id, 'grace_expired', sub.plan_id, sub.plan_id, { graceUntil: new Date(sub.grace_until).toISOString() });
        await this.outbox.publish(tx, sub.org_id, { type: 'subscription.changed', aggregateType: 'subscription', aggregateId: sub.id, payload: { status: 'unpaid' } });
        stats.graceExpired++;
      });
    }
    if (Object.values(stats).some(Boolean)) this.logger.log(JSON.stringify(stats));
    return stats;
  }

  private async inTenant(orgId: string, fn: (tx: Tx) => Promise<void>) {
    try {
      await this.db.withTenant(orgId, fn, 'system:billing-lifecycle');
    } finally {
      this.entitlements.invalidate(orgId);
    }
  }

  private lock(tx: Tx, id: string) {
    return tx.maybeOne<SubRow>(`select * from subscriptions where id = $1 for update`, [id]);
  }

  /** Applies what is due at `boundary` (trial or period end) and starts the next period. */
  private async periodEnd(tx: Tx, sub: SubRow, boundary: Date, now: Date, stats: LifecycleStats) {
    if (sub.cancel_at_period_end) {
      await tx.query(`update subscriptions set status = 'canceled', cancel_at_period_end = false, pending_plan_id = null,
                        pending_interval = null, pending_addons = null where id = $1`, [sub.id]);
      await this.subs.event(tx, sub.org_id, sub.id, 'canceled', sub.plan_id, null, { at: boundary.toISOString() });
      await this.outbox.publish(tx, sub.org_id, { type: 'subscription.changed', aggregateType: 'subscription', aggregateId: sub.id, payload: { status: 'canceled' } });
      stats.canceled++;
      return;
    }

    let planId = sub.plan_id;
    let interval = sub.billing_interval;
    if (sub.pending_plan_id) {
      const target = await this.catalog.plan(tx, sub.pending_plan_id);
      const violations = target ? await this.limits.violations(tx, sub.org_id, target.limits ?? {}) : [{ limit: 'plan', current: 0, allowed: 0 }];
      if (target && !violations.length) {
        planId = target.id;
        interval = sub.pending_interval ?? sub.billing_interval;
        await this.subs.replaceAddons(tx, sub.org_id, sub.id, parseModules(sub.pending_addons), target.is_custom);
        await this.subs.event(tx, sub.org_id, sub.id, 'scheduled_change_applied', sub.plan_id, planId, { interval, addons: parseModules(sub.pending_addons) });
        stats.changesApplied++;
      } else {
        // Usage grew past the target limits after scheduling: keep the current plan.
        await this.subs.event(tx, sub.org_id, sub.id, 'scheduled_change_blocked', sub.plan_id, sub.pending_plan_id, { violations });
        stats.changesBlocked++;
      }
    }

    // Roll forward from the boundary until the period contains `now`.
    const step = interval === 'year' ? '1 year' : '1 month';
    const period = await tx.one<{ start: Date; end: Date }>(
      `with recursive p(s, e) as (select $1::timestamptz, $1::timestamptz + $2::interval
         union all select e, e + $2::interval from p where e <= $3::timestamptz)
       select s as start, e as end from p order by s desc limit 1`, [boundary, step, now]);
    const config = { planId, interval, addons: await this.subs.addons(tx, sub.id) };
    const quote = await this.subs.recurringQuote(tx, sub, config, now);
    const paid = (quote?.subtotalMinor ?? 0) > 0;
    // Paid period + no billing provider ⇒ payment due. Keep an existing grace window rather than extending it.
    const graceUntil = paid ? (sub.status === 'past_due' && sub.grace_until ? sub.grace_until : new Date(now.getTime() + GRACE_DAYS * 864e5)) : null;
    const row = await tx.one<SubRow>(
      `update subscriptions set plan_id = $2, billing_interval = $3, status = $4, grace_until = $5, current_period_start = $6, current_period_end = $7,
              pending_plan_id = null, pending_interval = null, pending_addons = null
        where id = $1 returning *`,
      [sub.id, planId, interval, paid ? 'past_due' : 'active', graceUntil, period.start, period.end]);
    await this.subs.event(tx, sub.org_id, sub.id, 'period_rolled', sub.plan_id, planId, {
      periodStart: new Date(period.start).toISOString(), periodEnd: new Date(period.end).toISOString(),
      status: row.status, recurringMinor: quote?.subtotalMinor ?? null, ...(paid ? { note: 'payment_due_no_billing_provider' } : {}),
    });
    if (paid && quote && await this.subs.draftInvoice(tx, row, quote, new Date(period.start), new Date(period.end))) stats.invoicesDrafted++;
    await this.outbox.publish(tx, sub.org_id, { type: 'subscription.changed', aggregateType: 'subscription', aggregateId: sub.id, payload: { status: row.status, planId } });
    stats.periodsRolled++;
  }
}
