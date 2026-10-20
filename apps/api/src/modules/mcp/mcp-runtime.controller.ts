import { Body, Controller, Get, Param, Post, Res, UseFilters } from '@nestjs/common';
import type { McpWhoAmI } from '@resuto/contracts';
import type { Response } from 'express';
import type { AuthPrincipal, TenantContext } from '../../common/auth/context';
import { McpRuntime, Principal, RequiresModule, Tenant } from '../../common/auth/decorators';
import { DbService } from '../../common/db/db.service';
import { EntitlementsService } from '../../common/entitlements/entitlements.service';
import { DomainError } from '../../common/errors/domain-error';
import { McpCallFilter } from './mcp-call.filter';
import { McpExecutionService } from './mcp-execution.service';

const mcpOnly = (p: AuthPrincipal | undefined) => {
  if (p?.kind !== 'mcp') throw new DomainError('mcp_clients_only', 'This endpoint is only for MCP client keys; use the dashboard test tool instead', 403);
  return p;
};

/**
 * Endpoints called by the Resuto MCP server on behalf of an external AI client,
 * authenticated with the client's `rmcp_` key. Permissions are per tool (the
 * registry), so this controller carries @McpRuntime (the only routes an MCP key
 * may reach) + @RequiresModule('mcp') and each tool call is authorized inside
 * McpExecutionService.
 */
@Controller()
@McpRuntime()
@UseFilters(McpCallFilter)
export class McpRuntimeController {
  constructor(private readonly exec: McpExecutionService, private readonly db: DbService, private readonly entitlements: EntitlementsService) {}

  @Get('mcp/whoami')
  async whoami(@Principal() principal: AuthPrincipal): Promise<McpWhoAmI> {
    const p = mcpOnly(principal);
    await this.entitlements.assert(p.orgId, 'mcp');
    const row = await this.db.withTenant(p.orgId, (tx) => tx.one<any>(
      `select c.name, o.name as org_name from mcp_clients c join organizations o on o.id = c.org_id where c.id = $1`, [p.clientId]),
    `mcp_client:${p.clientId}`);
    return { clientId: p.clientId, name: row.name, orgId: p.orgId, orgName: row.org_name, actingRole: p.role, branchIds: p.branchIds,
      allowedTools: p.allowedTools as McpWhoAmI['allowedTools'], rateLimitPerMin: p.rateLimitPerMin };
  }

  @Get('o/:orgId/mcp/tools')
  @RequiresModule('mcp')
  async tools(@Tenant() ctx: TenantContext, @Principal() principal: AuthPrincipal) {
    const p = mcpOnly(principal);
    return { items: await this.exec.visibleTools(ctx, { clientId: p.clientId, allowedTools: p.allowedTools }) };
  }

  @Post('o/:orgId/mcp/tools/:tool')
  @RequiresModule('mcp')
  async call(@Tenant() ctx: TenantContext, @Principal() principal: AuthPrincipal, @Param('tool') tool: string,
    @Body() body: { input?: unknown } | undefined, @Res({ passthrough: true }) res: Response) {
    const p = mcpOnly(principal);
    const result = await this.exec.call(ctx, { clientId: p.clientId, allowedTools: p.allowedTools }, tool, body?.input ?? {}, 'mcp');
    res.status(result.httpStatus);
    return result.body;
  }
}
