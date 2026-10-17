import { ArgumentsHost, Catch, ExceptionFilter, Injectable } from '@nestjs/common';
import { TenantContext, type ResutoRequest } from '../../common/auth/context';
import { fingerprint } from '../../common/crypto/hash';
import { DbService } from '../../common/db/db.service';
import { ApiExceptionFilter } from '../../common/errors/exception.filter';
import { AuditService } from '../../common/platform/audit.service';
import { McpExecutionService, MCP_RECORDED } from './mcp-execution.service';

/**
 * Controller-scoped filter for the MCP runtime routes. The global guard rejects
 * some MCP requests before any handler runs (key of another tenant → 404,
 * per-client rate limit → 429, module not entitled → 402). This filter records
 * those denials in the key owner's tenant (mcp_tool_calls for tool calls and
 * audit_logs for every cross-tenant attempt), then renders the standard error.
 */
@Catch()
@Injectable()
export class McpCallFilter implements ExceptionFilter {
  private readonly fallback = new ApiExceptionFilter();

  constructor(private readonly exec: McpExecutionService, private readonly db: DbService, private readonly audit: AuditService) {}

  async catch(exception: unknown, host: ArgumentsHost) {
    const req = host.switchToHttp().getRequest<ResutoRequest & { body?: any; method?: string; originalUrl?: string }>();
    const p = req.principal;
    if (p?.kind === 'mcp' && !(exception && typeof exception === 'object' && (exception as any)[MCP_RECORDED])) {
      const ctx = new TenantContext(p.orgId, p.role, p.branchIds, null, 'mcp_client', p.clientId, 'mcp');
      const attemptedOrg = req.params?.orgId;
      const crossTenant = attemptedOrg !== undefined && attemptedOrg !== p.orgId;
      const extra = crossTenant ? { attemptedOrgId: String(attemptedOrg).slice(0, 64) } : undefined;
      try {
        if (req.params?.tool !== undefined) {
          await this.exec.recordFailure(ctx, ctx, p.clientId, String(req.params.tool), fingerprint(req.body?.input ?? {}), exception, Date.now(), 'mcp', extra);
        }
        if (crossTenant) {
          await this.db.withTenant(p.orgId, (tx) => this.audit.record(tx, ctx, {
            action: 'mcp.cross_tenant_denied', entityType: 'mcp_client', entityId: p.clientId,
            metadata: { attemptedOrgId: String(attemptedOrg).slice(0, 64), method: req.method, path: String(req.originalUrl ?? '').slice(0, 200) },
          }), `mcp_client:${p.clientId}`);
        }
      } catch {
        // Recording must never mask the original error.
      }
    }
    return this.fallback.catch(exception, host);
  }
}
