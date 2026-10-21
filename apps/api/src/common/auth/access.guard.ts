import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { ENV, type Env } from '../../config/env';
import { Reflector } from '@nestjs/core';
import { MCP_TOOLS, type McpToolName, type ModuleKey, type Permission, type Role } from '@resuto/contracts';
import { sha256 } from '../crypto/hash';
import { DbService } from '../db/db.service';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { DomainError, forbidden } from '../errors/domain-error';
import { RateLimiter } from '../http/rate-limiter';
import { TenantContext, type AuthPrincipal, type ResutoRequest } from './context';
import { IS_PUBLIC, MCP_RUNTIME, MODULE, PERMISSION, PLATFORM_ROLE } from './decorators';
import { JwtService } from './jwt.service';

const unauthorized = () => new DomainError('unauthorized', 'Sign in to continue', 401);
/** MCP credentials: connection keys (rmcp_) and OAuth access tokens issued for the MCP resource (rmat_, FT-17). */
const isMcpToken = (t: string) => t.startsWith('rmcp_') || t.startsWith('rmat_');
/** Canonical resource URI for audience comparison (lowercase scheme/host, no trailing slash). */
function canonicalResource(v: string): string | null {
  try {
    const u = new URL(v);
    if (u.hash || !/^https?:$/.test(u.protocol)) return null;
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '')}${u.search}`;
  } catch { return null; }
}
/** The OAuth scope a tool needs (FT-17): read-only tools need mcp:read, everything else mcp:act. */
export const mcpToolScope = (tool: string): 'mcp:read' | 'mcp:act' | null =>
  (Object.prototype.hasOwnProperty.call(MCP_TOOLS, tool) ? (MCP_TOOLS[tool as McpToolName].readOnly ? 'mcp:read' : 'mcp:act') : null);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Single global guard: authentication → platform role → tenant membership →
 * permission → module entitlement. Order matters and is tested.
 */
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly db: DbService,
    private readonly entitlements: EntitlementsService,
    private readonly limiter: RateLimiter,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<ResutoRequest>();
    const meta = <T>(key: string) => this.reflector.getAllAndOverride<T>(key, [context.getHandler(), context.getClass()]);

    const token = this.bearer(req);
    if (meta<boolean>(IS_PUBLIC)) {
      if (token && !isMcpToken(token)) req.principal = await this.verifyUser(token).catch(() => undefined);
      return true;
    }
    if (!token) throw unauthorized();
    const principal = token.startsWith('rmcp_') ? await this.resolveMcp(token)
      : token.startsWith('rmat_') ? await this.resolveMcpOAuth(token, req) : await this.verifyUser(token);
    req.principal = principal;

    if (principal.kind === 'mcp') {
      // Keys reach only the MCP runtime, never REST routes (see McpRuntime in decorators.ts).
      if (!this.reflector.get<boolean>(MCP_RUNTIME, context.getClass())) {
        throw new DomainError('mcp_runtime_only', 'MCP client keys can only call Resuto MCP tools', 403);
      }
      this.limiter.hit(`mcp:${principal.clientId}`, principal.rateLimitPerMin);
    }

    const platformRoles = meta<string[]>(PLATFORM_ROLE);
    if (platformRoles) {
      if (principal.kind !== 'user') throw forbidden();
      const admin = await this.db.withPlatform((tx) =>
        tx.maybeOne<{ role: string }>('select role from platform_admins where user_id = $1', [principal.userId]));
      if (!admin || !platformRoles.includes(admin.role)) throw forbidden('Platform administrators only');
      return true;
    }

    const orgId = req.params?.orgId;
    if (orgId !== undefined) {
      if (!UUID.test(orgId)) throw new DomainError('not_found', 'Restaurant not found', 404);
      req.tenant = await this.tenantFor(principal, orgId);
      const permissions = meta<Permission[]>(PERMISSION) ?? [];
      for (const p of permissions) req.tenant.require(p);
      const module = meta<ModuleKey>(MODULE);
      if (module) await this.entitlements.assert(orgId, module);
    } else if (meta<Permission[]>(PERMISSION)) {
      throw new Error('RequirePermission used on a route without :orgId');
    }
    return true;
  }

  private bearer(req: ResutoRequest): string | null {
    const h = req.headers['authorization'];
    const value = Array.isArray(h) ? h[0] : h;
    return value?.startsWith('Bearer ') ? value.slice(7).trim() || null : null;
  }

  private async verifyUser(token: string): Promise<AuthPrincipal> {
    try {
      const claims = await this.jwt.verify(token);
      return { kind: 'user', userId: claims.sub, email: claims.email ?? null, claims };
    } catch {
      throw unauthorized();
    }
  }

  private async resolveMcp(token: string): Promise<AuthPrincipal> {
    const client = await this.db.withPlatform((tx) => tx.maybeOne<any>(
      `update mcp_clients c set last_used_at = now()
         from organizations o
        where c.key_hash = $1 and c.status = 'active' and (c.expires_at is null or c.expires_at > now())
          and o.id = c.org_id and o.status not in ('closed', 'suspended')
        returning c.id, c.org_id, c.acting_role, c.branch_ids, c.allowed_tools, c.rate_limit_per_min`, [sha256(token)]));
    if (!client) throw unauthorized();
    return {
      kind: 'mcp', clientId: client.id, orgId: client.org_id, role: client.acting_role as Role,
      branchIds: client.branch_ids, allowedTools: client.allowed_tools, rateLimitPerMin: client.rate_limit_per_min,
    };
  }

  /**
   * OAuth access token (FT-17): valid, unexpired, not revoked, issued for one of this deployment's MCP resources
   * (MCP_OAUTH_RESOURCES) and, when the MCP server names the resource it serves (X-Mcp-Resource), for that one.
   * Tokens issued for another audience are refused (no passthrough). The connection itself must still be active.
   */
  private async resolveMcpOAuth(token: string, req: ResutoRequest): Promise<AuthPrincipal> {
    const allowed = (this.env.MCP_OAUTH_RESOURCES ?? '').split(',').map((s) => canonicalResource(s.trim())).filter(Boolean);
    if (!allowed.length) throw unauthorized();
    const row = await this.db.withPlatform((tx) => tx.maybeOne<any>(
      `update mcp_clients c set last_used_at = now()
         from organizations o, mcp_oauth_tokens t
        where t.token_hash = $1 and t.kind = 'access' and t.revoked_at is null and t.expires_at > now() and c.id = t.mcp_client_id
          and c.status = 'active' and (c.expires_at is null or c.expires_at > now()) and o.id = c.org_id and o.status not in ('closed', 'suspended')
        returning c.id, c.org_id, c.acting_role, c.branch_ids, c.allowed_tools, c.rate_limit_per_min, t.resource, t.scopes`, [sha256(token)]));
    if (!row || !allowed.includes(row.resource)) throw unauthorized();
    const h = req.headers['x-mcp-resource'];
    const named = Array.isArray(h) ? h[0] : h;
    if (named !== undefined && canonicalResource(named) !== row.resource) throw unauthorized();
    // The token's own scopes bound what it can do, not only the connection's allowlist: a token down-scoped on refresh
    // (RFC 6749 §6) to mcp:read cannot call action tools even when the connection allows them.
    const scopes: string[] = row.scopes ?? [];
    const allowedTools = (row.allowed_tools as string[]).filter((n) => { const s = mcpToolScope(n); return s !== null && scopes.includes(s); });
    return {
      kind: 'mcp', clientId: row.id, orgId: row.org_id, role: row.acting_role as Role, branchIds: row.branch_ids, allowedTools,
      rateLimitPerMin: row.rate_limit_per_min, oauthResource: row.resource, oauthScopes: scopes,
    };
  }

  private async tenantFor(principal: AuthPrincipal, orgId: string): Promise<TenantContext> {
    if (principal.kind === 'mcp') {
      // Not-found rather than forbidden: never confirm another tenant exists.
      if (principal.orgId !== orgId) throw new DomainError('not_found', 'Restaurant not found', 404);
      return new TenantContext(orgId, principal.role, principal.branchIds, null, 'mcp_client', principal.clientId, 'mcp');
    }
    const m = await this.db.withPlatform((tx) => tx.maybeOne<{ role: Role; branch_ids: string[] | null }>(
      `select m.role, m.branch_ids from memberships m join organizations o on o.id = m.org_id
        where m.org_id = $1 and m.user_id = $2 and m.status = 'active' and o.status not in ('closed', 'suspended')`, [orgId, principal.userId]));
    if (!m) throw new DomainError('not_found', 'Restaurant not found', 404);
    return new TenantContext(orgId, m.role, m.branch_ids, principal.userId, 'user', principal.userId);
  }
}
