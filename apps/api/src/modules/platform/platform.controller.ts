import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import {
  acceptInvitation, branchInput, branchUpdate, createOrganization, inviteMember, listQuery, updateMember, updateOrganization,
} from '@resuto/contracts';
import { z } from 'zod';
import type { AuthPrincipal, ResutoRequest, TenantContext } from '../../common/auth/context';
import { Principal, RequirePermission, Tenant } from '../../common/auth/decorators';
import { DbService } from '../../common/db/db.service';
import { DomainError, forbidden } from '../../common/errors/domain-error';
import { idKeyset, pageOf } from '../../common/http/pagination';
import { RateLimiter } from '../../common/http/rate-limiter';
import { zod } from '../../common/http/zod.pipe';
import { OrganizationsService } from './organizations.service';
import { SetupService } from './setup.service';

/** Restaurant sign-ups: a few per account and per address each hour (audit PS-13; each org seeds menus, plans …). */
const ORG_CREATE_PER_USER_HOUR = 5;
const ORG_CREATE_PER_IP_HOUR = 30;

/** Audit log query (PS-21): validated limit/cursor; `before` is the cursor parameter the web page has always sent. */
const auditQuery = listQuery.extend({
  before: z.string().min(1).max(500).optional(),
  entityType: z.string().regex(/^[a-z_]{1,60}$/).optional(),
});

const iso = (v: Date | string | null) => (v ? new Date(v).toISOString() : null);

const user = (p: AuthPrincipal) => {
  if (p.kind !== 'user') throw forbidden();
  return p;
};

@Controller()
export class PlatformController {
  constructor(private readonly orgs: OrganizationsService, private readonly db: DbService, private readonly limiter: RateLimiter, private readonly setup: SetupService) {}

  @Post('orgs')
  create(@Principal() principal: AuthPrincipal, @Req() req: ResutoRequest, @Body(zod(createOrganization)) body: z.infer<typeof createOrganization>) {
    const u = user(principal);
    this.limiter.hit(`org-create:user:${u.userId}`, ORG_CREATE_PER_USER_HOUR, 3_600_000);
    this.limiter.hit(`org-create:ip:${req.ip ?? 'unknown'}`, ORG_CREATE_PER_IP_HOUR, 3_600_000);
    return this.orgs.create(u, body);
  }

  @Post('invitations/accept')
  accept(@Principal() principal: AuthPrincipal, @Body(zod(acceptInvitation)) body: { token: string }) {
    return this.orgs.acceptInvitation(user(principal), body.token);
  }

  @Get('o/:orgId')
  get(@Tenant() ctx: TenantContext) {
    return this.orgs.get(ctx);
  }

  @Patch('o/:orgId')
  @RequirePermission('org:manage')
  update(@Tenant() ctx: TenantContext, @Body(zod(updateOrganization)) body: z.infer<typeof updateOrganization>) {
    return this.orgs.update(ctx, body);
  }

  /**
   * Former self-asserted checklist (FT-13): steps are now derived from data (GET /o/:orgId/setup). Only "launched"
   * remains, and it is gated on the required steps; any other step answers 409 setup_step_derived.
   */
  @HttpCode(200)
  @Post('o/:orgId/onboarding/:step')
  @RequirePermission('org:manage')
  async onboardingStep(@Tenant() ctx: TenantContext, @Param('step') step: string) {
    const s = z.enum(['profile', 'branch', 'menu', 'floor', 'website', 'payments', 'launched']).parse(step);
    if (s !== 'launched') throw new DomainError('setup_step_derived', 'This step is checked automatically from your restaurant data.', 409, { step: s });
    const r = await this.setup.launch(ctx);
    return { onboarding: { launched: r.launchedAt }, status: r.status };
  }

  @Post('o/:orgId/branches')
  @RequirePermission('branches:manage')
  createBranch(@Tenant() ctx: TenantContext, @Body(zod(branchInput)) body: z.infer<typeof branchInput>) {
    return this.orgs.createBranch(ctx, body);
  }

  @Patch('o/:orgId/branches/:branchId')
  @RequirePermission('branches:manage')
  updateBranch(@Tenant() ctx: TenantContext, @Param('branchId', ParseUUIDPipe) branchId: string, @Body(zod(branchUpdate)) body: z.infer<typeof branchUpdate>) {
    return this.orgs.updateBranch(ctx, branchId, body);
  }

  @Get('o/:orgId/members')
  @RequirePermission('members:manage')
  members(@Tenant() ctx: TenantContext) {
    return this.orgs.listMembers(ctx);
  }

  @Post('o/:orgId/invitations')
  @RequirePermission('members:manage')
  invite(@Tenant() ctx: TenantContext, @Body(zod(inviteMember)) body: z.infer<typeof inviteMember>) {
    return this.orgs.invite(ctx, body);
  }

  @Delete('o/:orgId/invitations/:invitationId')
  @RequirePermission('members:manage')
  revokeInvitation(@Tenant() ctx: TenantContext, @Param('invitationId', ParseUUIDPipe) id: string) {
    return this.orgs.revokeInvitation(ctx, id);
  }

  @Patch('o/:orgId/members/:membershipId')
  @RequirePermission('members:manage')
  updateMember(@Tenant() ctx: TenantContext, @Param('membershipId', ParseUUIDPipe) id: string, @Body(zod(updateMember)) body: z.infer<typeof updateMember>) {
    return this.orgs.updateMember(ctx, id, body);
  }

  @Delete('o/:orgId/members/:membershipId')
  @RequirePermission('members:manage')
  removeMember(@Tenant() ctx: TenantContext, @Param('membershipId', ParseUUIDPipe) id: string) {
    return this.orgs.removeMember(ctx, id);
  }

  @Get('o/:orgId/audit')
  @RequirePermission('audit:read')
  auditLog(@Tenant() ctx: TenantContext, @Query(zod(auditQuery)) q: z.infer<typeof auditQuery>) {
    const k = idKeyset(q.cursor ?? q.before);
    return this.db.scoped(ctx, async (tx) => {
      const rows = await tx.query(
        `select id, branch_id, actor_type, actor_id, action, entity_type, entity_id, source, metadata, created_at from audit_logs
          where org_id = $1 and ($2::text is null or entity_type = $2) ${k.after('id', 3)}
          order by id desc limit ${k.fetch(q.limit)}`, [ctx.orgId, q.entityType ?? null, ...k.params]);
      // camelCase fields (API style); the snake_case keys stay for existing clients until they move over (additive).
      return pageOf(rows, q.limit, (r) => ({ at: Number(r.id), id: String(r.id) }), (r) => ({
        ...r, id: Number(r.id), created_at: iso(r.created_at),
        branchId: r.branch_id, actorType: r.actor_type, actorId: r.actor_id, entityType: r.entity_type, entityId: r.entity_id,
        createdAt: iso(r.created_at),
      }));
    });
  }
}
