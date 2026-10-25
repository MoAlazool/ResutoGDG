import { Injectable } from '@nestjs/common';
import { SETUP_STEPS, type ServiceMode, type SetupCheck, type SetupChecklist, type SetupStep } from '@resuto/contracts';
import type { TenantContext } from '../../common/auth/context';
import { DbService, type Tx } from '../../common/db/db.service';
import { DomainError, notFound } from '../../common/errors/domain-error';
import { AuditService } from '../../common/platform/audit.service';
import { OFFERED_SQL, SOLD_OUT_SQL } from '../menu/availability';

/** Steps that must be done before the restaurant can launch (welcome, payments and launch itself are not gates). */
const REQUIRED: ReadonlySet<SetupStep> = new Set(['profile', 'branch', 'mode', 'menu', 'floor']);

/**
 * Required steps for a restaurant's plan and service model (21-ONB, plan §6.2). A Free QR-menu restaurant does not
 * need a legal name, a floor plan or payments to publish its menu: those steps stay in the list as optional. The floor
 * is required only where guests are seated at tables. Without a live subscription the restaurant is on Free
 * (app.module_enabled falls back to the free plan), so it gets the Free requirements too.
 */
export function requiredSteps(planId: string, mode: ServiceMode): ReadonlySet<SetupStep> {
  const free = planId === 'free';
  return new Set([...REQUIRED].filter((s) => s !== 'floor' || (!free && mode === 'tables')));
}
/** Profile fields a plan requires before launch (the legal name is for invoices and fiscal documents on paid plans). */
export const requiredProfileFields = (planId: string) => (planId === 'free' ? ['name'] : ['name', 'legalName']);

/**
 * Guided setup (legacy /manager/setup, FT-13 / VS-17). Every step's completion is derived from the restaurant's data
 * on each read; nothing here can be ticked by hand. Choosing the service model is itself the data of the "mode" step,
 * and "launched" is the only explicit flag, refused until the required steps are done.
 */
@Injectable()
export class SetupService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  checklist(ctx: TenantContext, branchId?: string): Promise<SetupChecklist> {
    if (branchId) ctx.assertBranch(branchId);
    return this.db.scoped(ctx, (tx) => this.derive(tx, ctx, branchId));
  }

  private async derive(tx: Tx, ctx: TenantContext, wanted?: string): Promise<SetupChecklist> {
    const org = await tx.one<any>('select id, name, legal_name, tax_registration_number, status, onboarding from organizations where id = $1', [ctx.orgId]);
    const branches = await tx.query<any>(
      `select id, name, address, city, phone, opening_hours, accepts_dine_in, accepts_pickup, accepts_delivery, service_mode, is_active
         from branches where org_id = $1 and is_active order by created_at`, [ctx.orgId]);
    const visible = branches.filter((b) => ctx.canAccessBranch(b.id));
    const branch = (wanted ? visible.find((b) => b.id === wanted) : visible[0]) ?? null;
    if (wanted && !branch) throw notFound('Branch');
    const onboarding = (org.onboarding ?? {}) as Record<string, unknown>;
    const mode: ServiceMode = branch?.service_mode ?? 'tables';
    const sub = await tx.maybeOne<{ plan_id: string; live: boolean }>(
      `select plan_id, (status in ('trialing', 'active') or (status = 'past_due' and grace_until is not null and grace_until > now())) as live
         from subscriptions where org_id = $1 and status <> 'canceled'`, [ctx.orgId]);
    const planId = sub?.live ? sub.plan_id : 'free';
    const required = requiredSteps(planId, mode);
    const check = (step: SetupStep, done: boolean, detail: Record<string, unknown> = {}): SetupCheck => ({ step, done, required: required.has(step), detail });

    const profileFields = requiredProfileFields(planId);
    const blank = { name: !org.name?.trim(), legalName: !org.legal_name?.trim() } as const;
    const missingProfile = profileFields.filter((f) => blank[f as keyof typeof blank]);
    const optionalProfile = (['legalName'] as const).filter((f) => !profileFields.includes(f) && blank[f]);
    const branchMissing = !branch ? ['branch'] : [
      !(branch.address?.trim() || branch.city?.trim()) && 'address',
      !(Array.isArray(branch.opening_hours) && branch.opening_hours.length) && 'openingHours',
      !(branch.accepts_dine_in || branch.accepts_pickup || branch.accepts_delivery) && 'fulfilment',
    ].filter(Boolean);
    const products = branch ? (await tx.one<{ offered: number; orderable: number }>(
      `select count(*) filter (where ${OFFERED_SQL})::int as offered, count(*) filter (where ${OFFERED_SQL} and not ${SOLD_OUT_SQL})::int as orderable
         from products p left join product_branch_settings s on s.product_id = p.id and s.branch_id = $2
        where p.org_id = $1 and p.is_active`, [ctx.orgId, branch.id])) : { offered: 0, orderable: 0 };
    const tables = branch ? (await tx.one<{ n: number }>('select count(*)::int as n from dining_tables where branch_id = $1 and is_active', [branch.id])).n : 0;
    const payments = await tx.one<{ n: number }>(
      `select count(*)::int as n from integration_connections where org_id = $1 and category = 'payments' and status in ('connected', 'sandbox')`, [ctx.orgId]);
    const site = await tx.maybeOne<{ status: string; published_revision: number }>('select status, published_revision from websites where org_id = $1', [ctx.orgId]);

    const steps: SetupCheck[] = [
      check('welcome', true),
      check('profile', missingProfile.length === 0, { missing: missingProfile, optional: optionalProfile, taxRegistration: !!org.tax_registration_number }),
      check('branch', branchMissing.length === 0, { missing: branchMissing }),
      check('mode', !!onboarding.mode, { mode }),
      check('menu', products.orderable > 0, products),
      check('floor', mode !== 'tables' || tables > 0, { mode, tables }),
      check('payments', payments.n > 0, { onlineProviders: payments.n }),
      check('launch', !!onboarding.launched, { websitePublished: site?.status === 'published' && site.published_revision > 0 }),
    ];
    const ready = steps.filter((s) => s.required).every((s) => s.done);
    return {
      orgId: ctx.orgId, status: org.status, launched: !!onboarding.launched, launchedAt: typeof onboarding.launched === 'string' ? onboarding.launched : null,
      ready, serviceMode: mode, branchId: branch?.id ?? null, planId, steps: SETUP_STEPS.map((s) => steps.find((x) => x.step === s)!),
    };
  }

  /** Launch: the one explicit step, refused until every required step is done (no self-asserted checklist). */
  async launch(ctx: TenantContext): Promise<SetupChecklist> {
    return this.db.scoped(ctx, async (tx) => {
      await tx.one('select id from organizations where id = $1 for update', [ctx.orgId]);
      const before = await this.derive(tx, ctx);
      if (!before.ready) {
        const missing = before.steps.filter((s) => s.required && !s.done).map((s) => s.step);
        throw new DomainError('setup_incomplete', 'Finish the required setup steps before launching.', 409, { missing });
      }
      if (!before.launched) {
        await tx.query(
          `update organizations set onboarding = onboarding || jsonb_build_object('launched', now()),
              status = case when status = 'onboarding' then 'active' else status end where id = $1`, [ctx.orgId]);
        await this.audit.record(tx, ctx, { action: 'organization.launched', entityType: 'organization', entityId: ctx.orgId });
      }
      return this.derive(tx, ctx);
    });
  }

  /**
   * Service model of a branch (legacy settings cards). Keeps the ordering flags consistent with the mode: counter and
   * online branches take no dine-in or table reservations; a counter takes pickup. Recording the choice completes the
   * setup "mode" step.
   */
  async setServiceMode(ctx: TenantContext, branchId: string, input: { mode: ServiceMode; acceptsReservations?: boolean }) {
    ctx.assertBranch(branchId);
    return this.db.scoped(ctx, async (tx) => {
      const b = await tx.maybeOne<any>('select id, service_mode, accepts_reservations from branches where id = $1 and org_id = $2 for update', [branchId, ctx.orgId]);
      if (!b) throw notFound('Branch');
      if (input.mode !== 'tables' && input.acceptsReservations) {
        throw new DomainError('reservations_need_tables', 'Table reservations need table service.', 422);
      }
      const row = await tx.one<any>(
        `update branches set service_mode = $2,
            accepts_dine_in = ($2 = 'tables'),
            accepts_pickup = case when $2 = 'counter' then true else accepts_pickup end,
            accepts_reservations = case when $2 = 'tables' then coalesce($3, accepts_reservations) else false end
          where id = $1
          returning id, service_mode, accepts_dine_in, accepts_pickup, accepts_delivery, accepts_reservations`,
        [branchId, input.mode, input.acceptsReservations ?? null]);
      await tx.query(`update organizations set onboarding = onboarding || jsonb_build_object('mode', now()) where id = $1`, [ctx.orgId]);
      await this.audit.record(tx, ctx, { action: 'branch.service_mode_changed', entityType: 'branch', entityId: branchId, branchId,
        metadata: { from: b.service_mode, to: input.mode, acceptsReservations: row.accepts_reservations } });
      return {
        branchId: row.id, serviceMode: row.service_mode as ServiceMode, acceptsDineIn: row.accepts_dine_in, acceptsPickup: row.accepts_pickup,
        acceptsDelivery: row.accepts_delivery, acceptsReservations: row.accepts_reservations,
      };
    });
  }
}
