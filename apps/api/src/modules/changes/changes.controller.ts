import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import {
  CHANGE_OP_GROUPS, changePolicyUpdate, changeSetAuditQuery, changeSetDecision, changeSetsQuery, proposeChangeSet,
  type ChangeOpGroup, type ChangePolicyUpdate, type ChangeSetDecision, type ChangeSetsQuery, type ProposeChangeSet,
} from '@resuto/contracts';
import { z } from 'zod';
import type { AuthPrincipal } from '../../common/auth/context';
import type { TenantContext } from '../../common/auth/context';
import { Principal, RequirePermission, Tenant } from '../../common/auth/decorators';
import { aalOf, RequireMfa } from '../../common/auth/mfa.guard';
import { badRequest } from '../../common/errors/domain-error';
import { zod } from '../../common/http/zod.pipe';
import { ChangesService } from './changes.service';

const opGroup = z.enum(CHANGE_OP_GROUPS);
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{8,200}$/;

/**
 * Change sets (21-CS): the approvals inbox (every origin: MCP, Studio AI, copilot, staff), decisions, staff proposals,
 * the per-set audit trail and the restaurant's approval policy. Approve, reject, undo and policy edits step up to MFA
 * for users who enrolled a factor (the same opt-in semantics as other sensitive routes).
 */
@Controller('o/:orgId/change-sets')
export class ChangesController {
  constructor(private readonly changes: ChangesService) {}

  @Get()
  @RequirePermission('changes:read')
  list(@Tenant() ctx: TenantContext, @Query(zod(changeSetsQuery)) q: ChangeSetsQuery) {
    return this.changes.list(ctx, q);
  }

  /** Staff proposal: every op needs its own permission; the policy decides auto-apply, approval or refusal. */
  @Post()
  propose(@Tenant() ctx: TenantContext, @Body(zod(proposeChangeSet)) body: ProposeChangeSet, @Headers('idempotency-key') key?: string) {
    if (!key) throw badRequest('idempotency_key_required', 'An Idempotency-Key header is required');
    if (!IDEMPOTENCY_KEY.test(key)) throw badRequest('invalid_idempotency_key', 'Idempotency-Key must be 8-200 printable characters');
    return this.changes.propose(ctx, { origin: 'staff', title: body.title, summary: body.summary ?? null, ops: body.ops, idempotencyKey: key });
  }

  @Get(':changeSetId')
  @RequirePermission('changes:read')
  get(@Tenant() ctx: TenantContext, @Param('changeSetId', ParseUUIDPipe) id: string) {
    return this.changes.get(ctx, id);
  }

  @Get(':changeSetId/audit')
  @RequirePermission('changes:read')
  audit(@Tenant() ctx: TenantContext, @Param('changeSetId', ParseUUIDPipe) id: string, @Query(zod(changeSetAuditQuery)) q: z.infer<typeof changeSetAuditQuery>) {
    return this.changes.auditTrail(ctx, id, q);
  }

  @HttpCode(200)
  @Post(':changeSetId/approve')
  @RequireMfa()
  @RequirePermission('changes:approve')
  approve(@Tenant() ctx: TenantContext, @Principal() principal: AuthPrincipal, @Param('changeSetId', ParseUUIDPipe) id: string,
    @Body(zod(changeSetDecision)) body: ChangeSetDecision) {
    return this.changes.approve(ctx, id, body, principal?.kind === 'user' ? aalOf(principal.claims) : null);
  }

  @HttpCode(200)
  @Post(':changeSetId/reject')
  @RequireMfa()
  @RequirePermission('changes:approve')
  reject(@Tenant() ctx: TenantContext, @Param('changeSetId', ParseUUIDPipe) id: string, @Body(zod(changeSetDecision)) body: ChangeSetDecision) {
    return this.changes.reject(ctx, id, body.note ?? null);
  }

  /** Re-runs apply for an approved set (a no-op once it was applied: apply is keyed by the change set id). */
  @HttpCode(200)
  @Post(':changeSetId/apply')
  @RequirePermission('changes:approve')
  async apply(@Tenant() ctx: TenantContext, @Param('changeSetId', ParseUUIDPipe) id: string) {
    await this.changes.get(ctx, id);
    const r = await this.changes.apply(ctx.orgId, id);
    return { ...(await this.changes.get(ctx, id)), replayed: r.replayed };
  }

  /** Undo of a succeeded, reversible effect of a partially applied set (for example: cancel the payment link). */
  @HttpCode(200)
  @Post(':changeSetId/ops/:opId/reverse')
  @RequireMfa()
  @RequirePermission('changes:approve')
  reverse(@Tenant() ctx: TenantContext, @Param('changeSetId', ParseUUIDPipe) id: string, @Param('opId', ParseUUIDPipe) opId: string,
    @Body(zod(changeSetDecision)) body: ChangeSetDecision) {
    return this.changes.reverse(ctx, id, opId, body.note ?? null);
  }
}

/** The restaurant's approval policy per op group: auto | approval | blocked, second approver, owner discount threshold. */
@Controller('o/:orgId/change-policies')
export class ChangePoliciesController {
  constructor(private readonly changes: ChangesService) {}

  @Get()
  @RequirePermission('changes:read')
  list(@Tenant() ctx: TenantContext) {
    return this.changes.policies(ctx);
  }

  @Put(':group')
  @RequireMfa()
  @RequirePermission('changes:manage')
  update(@Tenant() ctx: TenantContext, @Param('group', zod(opGroup)) group: ChangeOpGroup, @Body(zod(changePolicyUpdate)) body: ChangePolicyUpdate) {
    return this.changes.setPolicy(ctx, group, body);
  }
}
