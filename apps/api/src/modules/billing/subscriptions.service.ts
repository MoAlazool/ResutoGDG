import { Injectable } from '@nestjs/common';
import {
  MODULE_KEYS,
  type ChangePlan, type ChangePlanResult, type ModuleKey, type PriceQuote, type SubscriptionView,
} from '@resuto/contracts';
import type { TenantContext } from '../../common/auth/context';
import { DbService, type Tx } from '../../common/db/db.service';
import { EntitlementsService } from '../../common/entitlements/entitlements.service';
import { DomainError, conflict, invalid, notFound } from '../../common/errors/domain-error';
import { AuditService } from '../../common/platform/audit.service';
import { OutboxService } from '../../common/platform/outbox.service';
import { CatalogService, sortModules, type PlanRow } from './catalog.service';
import { PlanLimitsService } from './plan-limits.service';

export const TRIAL_DAYS = 14;
export const GRACE_DAYS = 7;
/**
 * There is no billing-provider integration (no credentials exist for one):
 * Resuto cannot charge a card or collect a subscription fee. Every paid period
 * therefore starts as `past_due` with a grace period and a DRAFT invoice; the
 * restaurant (or Resuto finance, offline) settles it. When a provider such as
 * Paymob/Stripe Billing is integrated, its webhook moves the subscription to
 * `active` and the invoice to `paid` — nothing in this codebase does so today.
 */
export const NO_PROVIDER_NOTE =
  'No billing provider is connected yet, so Resuto cannot collect subscription fees automatically. Paid periods are recorded as draft invoices and the subscription shows "payment due" until settled with Resuto.';

export interface SubRow {
  id: string; org_id: string; plan_id: string; status: SubscriptionView['status']; billing_interval: 'month' | 'year';
  country: 'EG' | 'SA'; currency: 'EGP' | 'SAR'; current_period_start: Date; current_period_end: Date; trial_ends_at: Date | null;
  grace_until: Date | null; cancel_at_period_end: boolean; pending_plan_id: string | null; pending_interval: 'month' | 'year' | null;
  pending_addons: ModuleKey[] | null; provider: string | null; created_at: Date;
}

interface Config { planId: string; interval: 'month' | 'year'; addons: ModuleKey[] }

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));
const monthly = (q: PriceQuote) => (q.interval === 'year' ? q.subtotalMinor / 12 : q.subtotalMinor);
/** Postgres parses `{a,b}` enum arrays as strings unless a parser is registered. */
export const parseModules = (v: unknown): ModuleKey[] =>
  Array.isArray(v) ? (v as ModuleKey[]) : typeof v === 'string' ? (v.replace(/^\{|\}$/g, '').split(',').filter(Boolean) as ModuleKey[]) : [];

@Injectable()
export class SubscriptionsService {
  constructor(
    private readonly db: DbService,
    private readonly catalog: CatalogService,
    private readonly limits: PlanLimitsService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly entitlements: EntitlementsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------
  async live(tx: Tx, orgId: string, lock = false): Promise<SubRow | null> {
    return tx.maybeOne<SubRow>(`select * from subscriptions where org_id = $1 and status <> 'canceled' ${lock ? 'for update' : ''}`, [orgId]);
  }

  async addons(tx: Tx, subscriptionId: string): Promise<ModuleKey[]> {
    const rows = await tx.query<{ module: ModuleKey }>(
      `select module from subscription_modules where subscription_id = $1 and source in ('addon', 'custom_plan')`, [subscriptionId]);
    return sortModules(rows.map((r) => r.module));
  }

  async recurringQuote(tx: Tx, sub: SubRow, config?: Config, at?: Date): Promise<PriceQuote | null> {
    const c = config ?? { planId: sub.plan_id, interval: sub.billing_interval, addons: await this.addons(tx, sub.id) };
    try {
      return await this.catalog.quote(tx, { ...c, country: sub.country }, { publicOnly: false, at });
    } catch (e) {
      if (e instanceof DomainError && e.code === 'price_unavailable') return null;
      throw e;
    }
  }

  async view(tx: Tx, orgId: string): Promise<SubscriptionView> {
    const sub = (await this.live(tx, orgId))
      ?? await tx.maybeOne<SubRow>(`select * from subscriptions where org_id = $1 order by created_at desc limit 1`, [orgId]);
    if (!sub) throw notFound('Subscription');
    const plan = (await this.catalog.plan(tx, sub.plan_id))!;
    const addons = await this.addons(tx, sub.id);
    const invoices = await tx.query(
      `select id, number, status, currency, total_minor, period_start, period_end, created_at from platform_invoices
        where subscription_id = $1 order by period_start desc limit 24`, [sub.id]);
    const events = await tx.query(
      `select id, event_type, from_plan_id, to_plan_id, details, created_at from subscription_events
        where org_id = $1 order by id desc limit 30`, [orgId]);
    return {
      id: sub.id, planId: sub.plan_id,
      plan: { id: plan.id, name: plan.name, nameAr: plan.name_ar, limits: plan.limits ?? {}, modules: await this.catalog.planModules(tx, plan.id) },
      status: sub.status, interval: sub.billing_interval, country: sub.country, currency: sub.currency,
      currentPeriodStart: iso(sub.current_period_start)!, currentPeriodEnd: iso(sub.current_period_end)!,
      trialEndsAt: iso(sub.trial_ends_at), graceUntil: iso(sub.grace_until), cancelAtPeriodEnd: sub.cancel_at_period_end,
      pendingChange: sub.pending_plan_id ? {
        planId: sub.pending_plan_id, interval: sub.pending_interval ?? sub.billing_interval, addons: parseModules(sub.pending_addons),
        effectiveAt: iso(this.boundary(sub))!,
      } : null,
      addons,
      recurring: sub.status === 'canceled' ? null : await this.recurringQuote(tx, sub),
      billingProvider: { connected: false, note: NO_PROVIDER_NOTE },
      invoices: invoices.map((i) => ({ id: i.id, number: i.number, status: i.status, currency: i.currency, totalMinor: Number(i.total_minor),
        periodStart: iso(i.period_start)!, periodEnd: iso(i.period_end)!, createdAt: iso(i.created_at)! })),
      events: events.map((e) => ({ id: Number(e.id), type: e.event_type, fromPlanId: e.from_plan_id, toPlanId: e.to_plan_id, details: e.details, createdAt: iso(e.created_at)! })),
    };
  }

  /** When scheduled changes and cancellations take effect: trial end while trialing, otherwise period end. */
  boundary(sub: SubRow): Date {
    return sub.status === 'trialing' && sub.trial_ends_at ? new Date(sub.trial_ends_at) : new Date(sub.current_period_end);
  }

  // ---------------------------------------------------------------------------
  // Changes (owner: billing:manage)
  // ---------------------------------------------------------------------------
  /**
   * Upgrades (more modules / higher limits / higher monthly-equivalent price)
   * apply immediately. Downgrades are scheduled for the end of the current
   * period (or trial) and refused when current usage exceeds the target
   * plan's limits. A subscription that is past due or unpaid has no paid
   * period to honour, so any change applies immediately.
   */
  async changePlan(ctx: TenantContext, input: ChangePlan): Promise<ChangePlanResult> {
    const outcome = await this.db.scoped(ctx, async (tx) => {
      const now = new Date();
      const plan = await this.catalog.plan(tx, input.planId, { publicOnly: true });
      if (!plan) throw invalid('unknown_plan', 'Choose an available plan');
      const included = await this.catalog.planModules(tx, plan.id);
      const sub = await this.live(tx, ctx.orgId, true);
      const normalize = (mods: readonly ModuleKey[]) => sortModules([...new Set(mods)].filter((m) => m !== 'core' && !included.includes(m)));

      if (!sub) return this.resubscribe(tx, ctx, plan, { planId: plan.id, interval: input.interval ?? 'month', addons: normalize(input.addons ?? []) }, now);

      const current: Config = { planId: sub.plan_id, interval: sub.billing_interval, addons: await this.addons(tx, sub.id) };
      const target: Config = { planId: plan.id, interval: input.interval ?? current.interval, addons: normalize(input.addons ?? current.addons) };

      if (target.planId === current.planId && target.interval === current.interval && sameSet(target.addons, current.addons)) {
        if (!sub.pending_plan_id) throw conflict('no_change', 'This is already your plan');
        await tx.query(`update subscriptions set pending_plan_id = null, pending_interval = null, pending_addons = null where id = $1`, [sub.id]);
        await this.event(tx, ctx.orgId, sub.id, 'scheduled_change_cleared', sub.pending_plan_id, current.planId, {});
        await this.audit.record(tx, ctx, { action: 'subscription.scheduled_change_cleared', entityType: 'subscription', entityId: sub.id });
        return 'cleared' as const;
      }

      const currentPlan = (await this.catalog.plan(tx, sub.plan_id))!;
      const curQuote = await this.recurringQuote(tx, sub, current, now);
      const newQuote = await this.catalog.quote(tx, { ...target, country: sub.country }, { publicOnly: true, at: now });
      const lostModules = (curQuote?.modules ?? []).filter((m) => !newQuote.modules.includes(m));
      const limitDecrease = Object.entries(currentPlan.limits ?? {}).some(([k, v]) => plan.limits?.[k] !== undefined && plan.limits[k]! < v);
      const isDowngrade = lostModules.length > 0 || limitDecrease || (curQuote !== null && monthly(newQuote) < monthly(curQuote))
        || (current.interval === 'year' && target.interval === 'month');

      if (isDowngrade) {
        const violations = await this.limits.violations(tx, ctx.orgId, plan.limits ?? {});
        if (violations.length) {
          throw new DomainError('downgrade_blocked',
            `Current usage exceeds the ${plan.name} plan: ${violations.map((v) => `${v.limit} ${v.current}/${v.allowed}`).join(', ')}. Reduce usage first.`,
            409, { violations });
        }
      }

      if (isDowngrade && !['past_due', 'unpaid'].includes(sub.status)) {
        await tx.query(`update subscriptions set pending_plan_id = $2, pending_interval = $3, pending_addons = $4 where id = $1`,
          [sub.id, target.planId, target.interval, target.addons]);
        const effectiveAt = this.boundary(sub);
        await this.event(tx, ctx.orgId, sub.id, 'change_scheduled', current.planId, target.planId,
          { interval: target.interval, addons: target.addons, effectiveAt: effectiveAt.toISOString(), lostModules });
        await this.audit.record(tx, ctx, { action: 'subscription.change_scheduled', entityType: 'subscription', entityId: sub.id,
          metadata: { from: current.planId, to: target.planId, effectiveAt: effectiveAt.toISOString() } });
        await this.outbox.publish(tx, ctx.orgId, { type: 'subscription.changed', aggregateType: 'subscription', aggregateId: sub.id,
          payload: { outcome: 'scheduled', planId: target.planId } });
        return 'scheduled' as const;
      }

      await this.applyNow(tx, ctx.orgId, sub, plan, target, curQuote, newQuote, now, isDowngrade ? 'downgrade' : 'upgrade');
      await this.audit.record(tx, ctx, { action: 'subscription.plan_changed', entityType: 'subscription', entityId: sub.id,
        metadata: { from: current.planId, to: target.planId, interval: target.interval, addons: target.addons } });
      return 'applied' as const;
    });
    this.entitlements.invalidate(ctx.orgId);
    return { outcome, subscription: await this.db.scoped(ctx, (tx) => this.view(tx, ctx.orgId)) };
  }

  async cancel(ctx: TenantContext, reason?: string) {
    await this.db.scoped(ctx, async (tx) => {
      const sub = await this.live(tx, ctx.orgId, true);
      if (!sub) throw notFound('Subscription');
      if (sub.cancel_at_period_end) throw conflict('already_canceling', 'This subscription is already set to cancel');
      const q = await this.recurringQuote(tx, sub);
      if (!q || q.subtotalMinor === 0) throw conflict('free_plan_cannot_cancel', 'The free plan has nothing to cancel. Contact Resuto support to close the account.');
      await tx.query(`update subscriptions set cancel_at_period_end = true where id = $1`, [sub.id]);
      const effectiveAt = this.boundary(sub).toISOString();
      await this.event(tx, ctx.orgId, sub.id, 'cancel_scheduled', sub.plan_id, null, { reason: reason ?? null, effectiveAt });
      await this.audit.record(tx, ctx, { action: 'subscription.cancel_scheduled', entityType: 'subscription', entityId: sub.id, metadata: { effectiveAt } });
      await this.outbox.publish(tx, ctx.orgId, { type: 'subscription.changed', aggregateType: 'subscription', aggregateId: sub.id, payload: { outcome: 'cancel_scheduled' } });
    });
    return this.db.scoped(ctx, (tx) => this.view(tx, ctx.orgId));
  }

  async resume(ctx: TenantContext) {
    await this.db.scoped(ctx, async (tx) => {
      const sub = await this.live(tx, ctx.orgId, true);
      if (!sub) throw notFound('Subscription');
      if (!sub.cancel_at_period_end) throw conflict('not_canceling', 'This subscription is not set to cancel');
      await tx.query(`update subscriptions set cancel_at_period_end = false where id = $1`, [sub.id]);
      await this.event(tx, ctx.orgId, sub.id, 'resumed', sub.plan_id, sub.plan_id, {});
      await this.audit.record(tx, ctx, { action: 'subscription.resumed', entityType: 'subscription', entityId: sub.id });
      await this.outbox.publish(tx, ctx.orgId, { type: 'subscription.changed', aggregateType: 'subscription', aggregateId: sub.id, payload: { outcome: 'resumed' } });
    });
    return this.db.scoped(ctx, (tx) => this.view(tx, ctx.orgId));
  }

  // ---------------------------------------------------------------------------
  // Internals shared with the lifecycle job
  // ---------------------------------------------------------------------------
  async applyNow(tx: Tx, orgId: string, sub: SubRow, plan: PlanRow, target: Config, curQuote: PriceQuote | null, newQuote: PriceQuote, now: Date, kind: 'upgrade' | 'downgrade') {
    const wasPaid = (curQuote?.subtotalMinor ?? 0) > 0;
    const nowPaid = newQuote.subtotalMinor > 0;
    const intervalChanged = target.interval !== sub.billing_interval;
    let status = sub.status;
    let trialEndsAt = sub.trial_ends_at;
    let graceUntil = sub.grace_until;
    let restartPeriod = intervalChanged;
    let invoice = false;

    if (!nowPaid) {
      // Moving to a free configuration settles nothing but needs no payment either.
      if (status !== 'active') { status = 'active'; graceUntil = null; restartPeriod = true; }
    } else if (status === 'trialing') {
      // Trial continues on the new plan.
    } else if (!wasPaid && !sub.trial_ends_at) {
      status = 'trialing'; trialEndsAt = new Date(now.getTime() + TRIAL_DAYS * 864e5); restartPeriod = true;
    } else if (!wasPaid || intervalChanged || status === 'unpaid') {
      // A new paid period begins now and needs payment that no provider can collect.
      graceUntil = sub.status === 'past_due' && sub.grace_until ? sub.grace_until : new Date(now.getTime() + GRACE_DAYS * 864e5);
      status = 'past_due';
      restartPeriod = true; invoice = true;
    }

    const row = await tx.one<SubRow>(
      `update subscriptions set plan_id = $2, billing_interval = $3, status = $4, trial_ends_at = $5, grace_until = $6,
              pending_plan_id = null, pending_interval = null, pending_addons = null,
              current_period_start = case when $7 then $8::timestamptz else current_period_start end,
              current_period_end = case when $7 then $8::timestamptz + (case when $3 = 'year' then interval '1 year' else interval '1 month' end) else current_period_end end
        where id = $1 returning *`,
      [sub.id, plan.id, target.interval, status, trialEndsAt, graceUntil, restartPeriod, now]);
    await this.replaceAddons(tx, orgId, sub.id, target.addons, plan.is_custom);
    await this.event(tx, orgId, sub.id, kind === 'upgrade' ? 'upgraded' : 'downgraded', sub.plan_id, plan.id, {
      interval: target.interval, addons: target.addons, fromStatus: sub.status, toStatus: status,
      recurringMinor: newQuote.subtotalMinor, previousRecurringMinor: curQuote?.subtotalMinor ?? null, proration: 'none',
    });
    if (invoice) await this.draftInvoice(tx, row, newQuote, new Date(row.current_period_start), new Date(row.current_period_end));
    await this.outbox.publish(tx, orgId, { type: 'subscription.changed', aggregateType: 'subscription', aggregateId: sub.id,
      payload: { outcome: 'applied', planId: plan.id, status } });
    return row;
  }

  async replaceAddons(tx: Tx, orgId: string, subscriptionId: string, addons: readonly ModuleKey[], isCustom: boolean) {
    await tx.query(`delete from subscription_modules where subscription_id = $1 and source in ('addon', 'custom_plan')`, [subscriptionId]);
    for (const m of addons) {
      if (!MODULE_KEYS.includes(m)) continue;
      await tx.query(
        `insert into subscription_modules(subscription_id, org_id, module, source) values ($1, $2, $3, $4)
         on conflict (subscription_id, module) do update set source = excluded.source`,
        [subscriptionId, orgId, m, isCustom ? 'custom_plan' : 'addon']);
    }
  }

  /** Draft platform invoice for one paid period. Never marked paid by Resuto (no provider). Idempotent per period. */
  async draftInvoice(tx: Tx, sub: SubRow, quote: PriceQuote, periodStart: Date, periodEnd: Date) {
    if (quote.subtotalMinor <= 0) return null;
    const { n } = await tx.one<{ n: number }>(`select nextval('platform_invoice_number_seq')::int as n`);
    const ym = `${periodStart.getUTCFullYear()}${String(periodStart.getUTCMonth() + 1).padStart(2, '0')}`;
    return tx.maybeOne(
      `insert into platform_invoices(org_id, subscription_id, number, currency, subtotal_minor, tax_minor, status, period_start, period_end, lines)
       values ($1, $2, $3, $4, $5, 0, 'draft', $6, $7, $8)
       on conflict (subscription_id, period_start) where status <> 'void' do nothing returning id`,
      [sub.org_id, sub.id, `RS-${ym}-${String(n).padStart(6, '0')}`, quote.currency, quote.subtotalMinor, periodStart, periodEnd,
        JSON.stringify(quote.lines.map((l) => ({ ...l, interval: quote.interval })))]);
  }

  async event(tx: Tx, orgId: string, subscriptionId: string, type: string, from: string | null, to: string | null, details: Record<string, unknown>) {
    await tx.query(
      `insert into subscription_events(org_id, subscription_id, event_type, from_plan_id, to_plan_id, details) values ($1, $2, $3, $4, $5, $6)`,
      [orgId, subscriptionId, type, from, to, details]);
  }

  /** Starting again after cancellation. */
  private async resubscribe(tx: Tx, ctx: TenantContext, plan: PlanRow, target: Config, now: Date) {
    const org = await tx.one<{ country: 'EG' | 'SA'; currency: 'EGP' | 'SAR' }>(`select country, currency from organizations where id = $1`, [ctx.orgId]);
    const quote = await this.catalog.quote(tx, { ...target, country: org.country }, { publicOnly: true, at: now });
    const paid = quote.subtotalMinor > 0;
    const sub = await tx.one<SubRow>(
      `insert into subscriptions(org_id, plan_id, status, billing_interval, country, currency, current_period_start, current_period_end, grace_until)
       values ($1, $2, $3, $4, $5, $6, $7, $7::timestamptz + (case when $4 = 'year' then interval '1 year' else interval '1 month' end), $8) returning *`,
      [ctx.orgId, plan.id, paid ? 'past_due' : 'active', target.interval, org.country, org.currency, now,
        paid ? new Date(now.getTime() + GRACE_DAYS * 864e5) : null]);
    await this.replaceAddons(tx, ctx.orgId, sub.id, target.addons, plan.is_custom);
    await this.event(tx, ctx.orgId, sub.id, 'created', null, plan.id, { interval: target.interval, addons: target.addons, resubscribed: true });
    if (paid) await this.draftInvoice(tx, sub, quote, new Date(sub.current_period_start), new Date(sub.current_period_end));
    await this.audit.record(tx, ctx, { action: 'subscription.created', entityType: 'subscription', entityId: sub.id, metadata: { plan: plan.id } });
    await this.outbox.publish(tx, ctx.orgId, { type: 'subscription.changed', aggregateType: 'subscription', aggregateId: sub.id, payload: { outcome: 'applied', planId: plan.id } });
    return 'applied' as const;
  }
}
