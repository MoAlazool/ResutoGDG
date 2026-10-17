import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ModuleKey, Permission, Role } from '@resuto/contracts';
import { sha256 } from '../crypto/hash';
import { DbService } from '../db/db.service';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { DomainError, forbidden } from '../errors/domain-error';
import { RateLimiter } from '../http/rate-limiter';
import { TenantContext, type AuthPrincipal, type ResutoRequest } from './context';
import { ALLOW_MCP, IS_PUBLIC, MODULE, PERMISSION, PLATFORM_ROLE } from './decorators';
import { JwtService } from './jwt.service';

const unauthorized = () => new DomainError('unauthorized', 'Sign in to continue', 401);
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
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<ResutoRequest>();
    const meta = <T>(key: string) => this.reflector.getAllAndOverride<T>(key, [context.getHandler(), context.getClass()]);

    const token = this.bearer(req);
    if (meta<boolean>(IS_PUBLIC)) {
      if (token && !token.startsWith('rmcp_')) req.principal = await this.verifyUser(token).catch(() => undefined);
      return true;
    }
    if (!token) throw unauthorized();
    const principal = token.startsWith('rmcp_') ? await this.resolveMcp(token) : await this.verifyUser(token);
    req.principal = principal;

    if (principal.kind === 'mcp') {
      if (!meta<boolean>(ALLOW_MCP)) throw forbidden('This endpoint is not available to MCP clients');
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
      `update mcp_clients set last_used_at = now()
        where key_hash = $1 and status = 'active' and (expires_at is null or expires_at > now())
        returning id, org_id, acting_role, branch_ids, allowed_tools, rate_limit_per_min`, [sha256(token)]));
    if (!client) throw unauthorized();
    return {
      kind: 'mcp', clientId: client.id, orgId: client.org_id, role: client.acting_role as Role,
      branchIds: client.branch_ids, allowedTools: client.allowed_tools, rateLimitPerMin: client.rate_limit_per_min,
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
        where m.org_id = $1 and m.user_id = $2 and m.status = 'active' and o.status <> 'closed'`, [orgId, principal.userId]));
    if (!m) throw new DomainError('not_found', 'Restaurant not found', 404);
    return new TenantContext(orgId, m.role, m.branch_ids, principal.userId, 'user', principal.userId);
  }
}
