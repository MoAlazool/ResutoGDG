import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Res, UseFilters } from '@nestjs/common';
import { openMcpSession, type McpSessionView, type McpWhoAmI } from '@resuto/contracts';
import type { Response } from 'express';
import type { z } from 'zod';
import type { AuthMcpClient, AuthPrincipal, TenantContext } from '../../common/auth/context';
import { McpRuntime, Principal, RequiresModule, Tenant } from '../../common/auth/decorators';
import { DbService } from '../../common/db/db.service';
import { EntitlementsService } from '../../common/entitlements/entitlements.service';
import { DomainError } from '../../common/errors/domain-error';
import { zod } from '../../common/http/zod.pipe';
import { McpCallFilter } from './mcp-call.filter';
import { McpExecutionService } from './mcp-execution.service';
import { iso } from './mcp.util';

const mcpOnly = (p: AuthPrincipal | undefined) => {
  if (p?.kind !== 'mcp') throw new DomainError('mcp_clients_only', 'This endpoint is only for MCP client keys; use the dashboard test tool instead', 403);
  return p;
};

/** Open sessions one connection may hold at a time (an MCP client normally keeps one or two). */
export const MAX_SESSIONS_PER_CONNECTION = 100;

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

  private async who(p: AuthMcpClient): Promise<McpWhoAmI> {
    await this.entitlements.assert(p.orgId, 'mcp');
    const row = await this.db.withTenant(p.orgId, (tx) => tx.one<any>(
      `select c.name, o.name as org_name from mcp_clients c join organizations o on o.id = c.org_id where c.id = $1`, [p.clientId]),
    `mcp_client:${p.clientId}`);
    return { clientId: p.clientId, name: row.name, orgId: p.orgId, orgName: row.org_name, actingRole: p.role, branchIds: p.branchIds,
      allowedTools: p.allowedTools as McpWhoAmI['allowedTools'], rateLimitPerMin: p.rateLimitPerMin,
      auth: p.oauthResource ? 'oauth' : 'key', resource: p.oauthResource ?? null };
  }

  @Get('mcp/whoami')
  async whoami(@Principal() principal: AuthPrincipal): Promise<McpWhoAmI> {
    return this.who(mcpOnly(principal));
  }

  /**
   * 21-MCP: Streamable HTTP sessions live in the database, so any MCP server instance can serve any request of a
   * session (no in-memory map). A session belongs to one connection: another connection's credential is refused (403),
   * and a refreshed OAuth access token of the same connection continues it.
   */
  @Post('mcp/sessions')
  async openSession(@Principal() principal: AuthPrincipal, @Body(zod(openMcpSession)) body: z.infer<typeof openMcpSession>): Promise<McpSessionView> {
    const p = mcpOnly(principal);
    const who = await this.who(p);
    const row = await this.db.withTenant(p.orgId, async (tx) => {
      await tx.query(`delete from mcp_sessions where client_id = $1 and (expires_at < now() or closed_at is not null)`, [p.clientId]);
      const { n } = await tx.one<{ n: number }>('select count(*)::int as n from mcp_sessions where client_id = $1', [p.clientId]);
      if (n >= MAX_SESSIONS_PER_CONNECTION) throw new DomainError('too_many_sessions', 'Too many open sessions for this connection; close some and retry', 429);
      return tx.one<{ id: string; expires_at: Date }>(
        `insert into mcp_sessions(org_id, client_id, auth_kind, protocol_version, client_name, idle_seconds, expires_at)
         values ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7)) returning id, expires_at`,
        [p.orgId, p.clientId, p.oauthResource ? 'oauth' : 'key', body.protocolVersion ?? null, body.clientName ?? null, body.idleMinutes * 60, body.idleMinutes * 60]);
    }, `mcp_client:${p.clientId}`);
    return { sessionId: row.id, expiresAt: iso(row.expires_at)!, who };
  }

  @Get('mcp/sessions/:sessionId')
  async touchSession(@Principal() principal: AuthPrincipal, @Param('sessionId', ParseUUIDPipe) id: string): Promise<McpSessionView> {
    const p = mcpOnly(principal);
    const row = await this.db.withTenant(p.orgId, async (tx) => {
      const s = await tx.maybeOne<{ client_id: string }>(
        `select client_id from mcp_sessions where org_id = $1 and id = $2 and closed_at is null and expires_at > now() for update`, [p.orgId, id]);
      if (!s) throw new DomainError('session_not_found', 'Session not found or expired; initialize a new one', 404);
      if (s.client_id !== p.clientId) throw new DomainError('session_other_connection', 'This session belongs to another connection', 403);
      return tx.one<{ id: string; expires_at: Date }>(
        `update mcp_sessions set last_seen_at = now(), expires_at = now() + make_interval(secs => idle_seconds) where id = $1 returning id, expires_at`, [id]);
    }, `mcp_client:${p.clientId}`);
    return { sessionId: row.id, expiresAt: iso(row.expires_at)!, who: await this.who(p) };
  }

  @Delete('mcp/sessions/:sessionId')
  @HttpCode(204)
  async closeSession(@Principal() principal: AuthPrincipal, @Param('sessionId', ParseUUIDPipe) id: string): Promise<void> {
    const p = mcpOnly(principal);
    await this.db.withTenant(p.orgId, async (tx) => {
      const s = await tx.maybeOne<{ client_id: string }>(`select client_id from mcp_sessions where org_id = $1 and id = $2 and closed_at is null`, [p.orgId, id]);
      if (!s) throw new DomainError('session_not_found', 'Session not found or expired', 404);
      if (s.client_id !== p.clientId) throw new DomainError('session_other_connection', 'This session belongs to another connection', 403);
      await tx.query('update mcp_sessions set closed_at = now() where id = $1', [id]);
    }, `mcp_client:${p.clientId}`);
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
    try {
      const result = await this.exec.call(ctx, { clientId: p.clientId, allowedTools: p.allowedTools, oauthScopes: p.oauthScopes }, tool, body?.input ?? {}, 'mcp');
      res.status(result.httpStatus);
      return result.body;
    } catch (e) {
      // RFC 6750 §3.1 / MCP "scope challenge": tell the client which scope to request.
      if (e instanceof DomainError && e.code === 'insufficient_scope') {
        const scope = (e.details as { scope?: string } | undefined)?.scope ?? 'mcp:act';
        res.setHeader('WWW-Authenticate', `Bearer error="insufficient_scope", scope="${scope}", error_description="The access token lacks the ${scope} scope"`);
      }
      throw e;
    }
  }
}
