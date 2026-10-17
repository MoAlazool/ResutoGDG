import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import {
  acceptInvitation, branchInput, branchUpdate, createOrganization, inviteMember, updateMember, updateOrganization,
} from '@resuto/contracts';
import { z } from 'zod';
import type { AuthPrincipal, TenantContext } from '../../common/auth/context';
import { AllowMcp, Principal, RequirePermission, Tenant } from '../../common/auth/decorators';
import { DbService } from '../../common/db/db.service';
import { forbidden } from '../../common/errors/domain-error';
import { zod } from '../../common/http/zod.pipe';
import { OrganizationsService } from './organizations.service';

const user = (p: AuthPrincipal) => {
  if (p.kind !== 'user') throw forbidden();
  return p;
};

@Controller()
export class PlatformController {
  constructor(private readonly orgs: OrganizationsService, private readonly db: DbService) {}

  @Post('orgs')
  create(@Principal() principal: AuthPrincipal, @Body(zod(createOrganization)) body: z.infer<typeof createOrganization>) {
    return this.orgs.create(user(principal), body);
  }

  @Post('invitations/accept')
  accept(@Principal() principal: AuthPrincipal, @Body(zod(acceptInvitation)) body: { token: string }) {
    return this.orgs.acceptInvitation(user(principal), body.token);
  }

  @Get('o/:orgId')
  @AllowMcp()
  get(@Tenant() ctx: TenantContext) {
    return this.orgs.get(ctx);
  }

  @Patch('o/:orgId')
  @RequirePermission('org:manage')
  update(@Tenant() ctx: TenantContext, @Body(zod(updateOrganization)) body: z.infer<typeof updateOrganization>) {
    return this.orgs.update(ctx, body);
  }

  @Post('o/:orgId/onboarding/:step')
  @RequirePermission('org:manage')
  onboardingStep(@Tenant() ctx: TenantContext, @Param('step') step: string) {
    return this.orgs.completeOnboardingStep(ctx, z.enum(['profile', 'branch', 'menu', 'floor', 'website', 'payments', 'launched']).parse(step));
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
  auditLog(@Tenant() ctx: TenantContext, @Query('limit') limit?: string, @Query('before') before?: string, @Query('entityType') entityType?: string) {
    const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
    return this.db.scoped(ctx, async (tx) => {
      const rows = await tx.query(
        `select id, branch_id, actor_type, actor_id, action, entity_type, entity_id, source, metadata, created_at from audit_logs
          where org_id = $1 and ($2::bigint is null or id < $2) and ($3::text is null or entity_type = $3)
          order by id desc limit $4`, [ctx.orgId, before ? Number(before) : null, entityType ?? null, n]);
      return { items: rows, nextCursor: rows.length === n ? String(rows[rows.length - 1].id) : null };
    });
  }
}
