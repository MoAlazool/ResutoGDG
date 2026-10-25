import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { createMcpClient, mcpApprovalsQuery, mcpCallsQuery, mcpDecision, mcpGroupsQuery, updateMcpClient } from '@resuto/contracts';
import type { z } from 'zod';
import type { TenantContext } from '../../common/auth/context';
import { RequirePermission, RequiresModule, Tenant } from '../../common/auth/decorators';
import { RequireMfa } from '../../common/auth/mfa.guard';
import { DbService } from '../../common/db/db.service';
import { conflict, forbidden, notFound } from '../../common/errors/domain-error';
import { zod } from '../../common/http/zod.pipe';
import { McpClientsService } from './mcp-clients.service';
import { clientContext, McpExecutionService } from './mcp-execution.service';

/** Dashboard management of MCP connections, approvals and the call log (staff only). */
@Controller('o/:orgId/mcp')
@RequiresModule('mcp')
export class McpController {
  constructor(private readonly clients: McpClientsService, private readonly exec: McpExecutionService, private readonly db: DbService) {}

  @Get('catalog')
  @RequirePermission('mcp:manage')
  catalog(@Tenant() ctx: TenantContext) {
    return this.exec.catalog(ctx.orgId);
  }

  /**
   * Permission groups for a connection acting as `role` (21-MCP wizard): which groups and tools work for that role in
   * this restaurant (entitlements), and the approval policy that governs each group's changes.
   */
  @Get('groups')
  @RequirePermission('mcp:manage')
  groups(@Tenant() ctx: TenantContext, @Query(zod(mcpGroupsQuery)) q: z.infer<typeof mcpGroupsQuery>) {
    return this.clients.groups(ctx, q.role);
  }

  @Get('clients')
  @RequirePermission('mcp:manage')
  list(@Tenant() ctx: TenantContext) {
    return this.clients.list(ctx);
  }

  @Post('clients')
  @RequireMfa()
  @RequirePermission('mcp:manage')
  create(@Tenant() ctx: TenantContext, @Body(zod(createMcpClient)) body: z.infer<typeof createMcpClient>) {
    return this.clients.create(ctx, body);
  }

  @Get('clients/:clientId')
  @RequirePermission('mcp:manage')
  get(@Tenant() ctx: TenantContext, @Param('clientId', ParseUUIDPipe) id: string) {
    return this.clients.get(ctx, id);
  }

  @Patch('clients/:clientId')
  @RequireMfa()
  @RequirePermission('mcp:manage')
  update(@Tenant() ctx: TenantContext, @Param('clientId', ParseUUIDPipe) id: string, @Body(zod(updateMcpClient)) body: z.infer<typeof updateMcpClient>) {
    return this.clients.update(ctx, id, body);
  }

  @HttpCode(200)
  @Post('clients/:clientId/revoke')
  @RequirePermission('mcp:manage')
  revoke(@Tenant() ctx: TenantContext, @Param('clientId', ParseUUIDPipe) id: string) {
    return this.clients.revoke(ctx, id);
  }

  @Get('clients/:clientId/usage')
  @RequirePermission('mcp:manage')
  usage(@Tenant() ctx: TenantContext, @Param('clientId', ParseUUIDPipe) id: string) {
    return this.clients.usage(ctx, id);
  }

  /** Runs a read-only tool exactly as the connection would (its role, branches and allow-list). */
  @HttpCode(200)
  @Post('clients/:clientId/test/:tool')
  @RequirePermission('mcp:manage')
  async test(@Tenant() ctx: TenantContext, @Param('clientId', ParseUUIDPipe) id: string, @Param('tool') tool: string,
    @Body() body: { input?: unknown } | undefined) {
    const client = await this.db.scoped(ctx, (tx) => tx.maybeOne<any>(
      `select id, acting_role, branch_ids, allowed_tools, status, expires_at from mcp_clients where org_id = $1 and id = $2`, [ctx.orgId, id]));
    if (!client) throw notFound('MCP client');
    // The test runs with the connection's scope: a branch-limited caller may test only connections inside their
    // branches, or it would read other branches' data through an all-branch connection (1D threat model).
    if (ctx.branchFilter && (!client.branch_ids || client.branch_ids.some((b: string) => !ctx.branchFilter!.includes(b)))) {
      throw forbidden('This connection reaches branches you do not have access to');
    }
    if (client.status !== 'active' || (client.expires_at && new Date(client.expires_at) <= new Date())) {
      throw conflict('client_inactive', 'This connection is revoked or expired');
    }
    const result = await this.exec.call(clientContext(ctx.orgId, client), { clientId: client.id, allowedTools: client.allowed_tools },
      tool, body?.input ?? {}, 'dashboard_test', ctx);
    return result.body;
  }

  @Get('calls')
  @RequirePermission('mcp:manage')
  calls(@Tenant() ctx: TenantContext, @Query(zod(mcpCallsQuery)) q: z.infer<typeof mcpCallsQuery>) {
    return this.clients.calls(ctx, q);
  }

  @Get('approvals')
  @RequirePermission('mcp:approve')
  approvals(@Tenant() ctx: TenantContext, @Query(zod(mcpApprovalsQuery)) q: z.infer<typeof mcpApprovalsQuery>) {
    return this.exec.listApprovals(ctx, q.status, q.limit, q.cursor);
  }

  @Get('approvals/:approvalId')
  @RequirePermission('mcp:approve')
  approval(@Tenant() ctx: TenantContext, @Param('approvalId', ParseUUIDPipe) id: string) {
    return this.exec.getApproval(ctx, id);
  }

  /** MFA step-up for users with a verified factor (21-CS: approving an AI action is as sensitive as issuing a key). */
  @HttpCode(200)
  @Post('approvals/:approvalId/approve')
  @RequireMfa()
  @RequirePermission('mcp:approve')
  approve(@Tenant() ctx: TenantContext, @Param('approvalId', ParseUUIDPipe) id: string, @Body(zod(mcpDecision)) body: z.infer<typeof mcpDecision>) {
    return this.exec.approve(ctx, id, body.note, body.previewDigest);
  }

  @HttpCode(200)
  @Post('approvals/:approvalId/reject')
  @RequireMfa()
  @RequirePermission('mcp:approve')
  reject(@Tenant() ctx: TenantContext, @Param('approvalId', ParseUUIDPipe) id: string, @Body(zod(mcpDecision)) body: z.infer<typeof mcpDecision>) {
    return this.exec.reject(ctx, id, body.note);
  }
}
