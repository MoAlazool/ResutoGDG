import { Injectable } from '@nestjs/common';
import type { ChangeSetView, StudioAiPlan, StudioAiProposal } from '@resuto/contracts';
import type { TenantContext } from '../../../common/auth/context';
import { DbService } from '../../../common/db/db.service';
import { notFound } from '../../../common/errors/domain-error';
import { ChangesService } from '../../changes/changes.service';
import { planStudioEdit, type PlannerBranch, type PlannerContext } from './studio-edit-planner';

const HOURS = /^\d{2}:\d{2}$/;

/**
 * Studio AI editing (21-STUDIO): a request in plain words becomes ONE change set (origin studio_ai) of typed ops, which
 * always waits for a person's approval (floor 'approval', whatever the restaurant's auto policy says) and is never
 * published by the planner. The engine validates every op as usual: the proposer needs each op's permission (menu:write
 * for a dish discount, marketing:write for an offer), the records must be this restaurant's, discounts stay in bounds,
 * and approving a price change steps up to MFA (POST /change-sets/:id/approve).
 */
@Injectable()
export class StudioEditingService {
  constructor(private readonly db: DbService, private readonly changes: ChangesService) {}

  async propose(ctx: TenantContext, body: StudioAiProposal, idempotencyKey: string): Promise<{ changeSet: ChangeSetView; plan: StudioAiPlan }> {
    const context = await this.db.scoped(ctx, async (tx): Promise<PlannerContext> => {
      const org = await tx.one<{ name: string; name_ar: string | null }>('select name, name_ar from organizations where id = $1', [ctx.orgId]);
      const site = await tx.maybeOne<{ id: string }>('select id from websites where org_id = $1', [ctx.orgId]);
      if (!site) throw notFound('Website');
      const products = await tx.query<{ id: string; name: string; name_ar: string | null }>(
        'select id, name, name_ar from products where org_id = $1 and is_active order by sort_order, name limit 500', [ctx.orgId]);
      const sections = await tx.query<{ id: string; kind: string; content: any }>(
        'select id, kind, content from website_sections where website_id = $1 order by sort_order, id', [site.id]);
      const branches = await tx.query<any>(
        `select name, name_ar, address, city, phone, opening_hours, accepts_pickup, accepts_delivery, accepts_reservations
           from branches where org_id = $1 and is_active order by created_at limit 5`, [ctx.orgId]);
      return {
        restaurant: { name: org.name, nameAr: org.name_ar },
        products: products.map((p) => ({ id: p.id, name: p.name, nameAr: p.name_ar })),
        sections: sections.map((s) => ({ id: s.id, kind: s.kind, content: s.content ?? {} })),
        branches: branches.map((b): PlannerBranch => ({
          name: b.name, nameAr: b.name_ar, address: b.address, city: b.city, phone: b.phone,
          hours: (Array.isArray(b.opening_hours) ? b.opening_hours : [])
            .filter((h: any) => h && typeof h.day === 'number' && HOURS.test(h.opens) && HOURS.test(h.closes))
            .map((h: any) => ({ day: h.day, opens: h.opens, closes: h.closes })),
          acceptsPickup: b.accepts_pickup, acceptsDelivery: b.accepts_delivery, acceptsReservations: b.accepts_reservations,
        })),
      };
    });
    const plan = planStudioEdit({ prompt: body.prompt, productIds: body.productIds, locale: body.locale }, context);
    const changeSet = await this.changes.propose(ctx, { origin: 'studio_ai', title: plan.title, summary: plan.summary, ops: plan.ops, idempotencyKey },
      { floor: 'approval' });
    return { changeSet, plan: { planner: 'resuto_rules', model: null, notes: plan.notes } };
  }
}
