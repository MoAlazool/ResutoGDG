import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { ModuleKey, Permission } from '@resuto/contracts';
import type { ResutoRequest } from './context';

export const IS_PUBLIC = 'resuto:public';
export const PERMISSION = 'resuto:permission';
export const MODULE = 'resuto:module';
export const PLATFORM_ROLE = 'resuto:platform';
export const MCP_RUNTIME = 'resuto:mcp-runtime';

/** No authentication required (guest, webhook, public website endpoints). */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** Tenant route permission (route must contain :orgId). */
export const RequirePermission = (...permissions: Permission[]) => SetMetadata(PERMISSION, permissions);
/** Backend entitlement: the tenant's subscription must include this module. */
export const RequiresModule = (module: ModuleKey) => SetMetadata(MODULE, module);
/** Platform administration routes. */
export const PlatformAdmin = (...roles: Array<'superadmin' | 'support' | 'finance'>) => SetMetadata(PLATFORM_ROLE, roles.length ? roles : ['superadmin', 'support', 'finance']);
/**
 * The MCP runtime (whoami, tool list, tool calls): the ONLY routes an MCP client key (rmcp_...) may reach. Every MCP
 * action goes through the tool path, so the key's allow-list, approvals for sensitive tools, per-tool limits, PII
 * masking, output caps and the mcp_tool_calls audit always apply. Class-level only; a regression test enumerates every
 * route (apps/api/test/mcp-route-lockdown.test.ts).
 */
export const McpRuntime = (): ClassDecorator => SetMetadata(MCP_RUNTIME, true);
/**
 * @deprecated Has no effect. MCP client keys used to reach REST routes marked with this decorator directly, which
 * skipped the tool allow-list, approvals and MCP audit (audit FT-01/PS-03). Keys now reach only @McpRuntime() routes;
 * expose a wanted read as an MCP tool instead. Remove remaining usages.
 */
export const AllowMcp = (): MethodDecorator & ClassDecorator => () => undefined;

export const Tenant = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest<ResutoRequest>();
  if (!req.tenant) throw new Error('Tenant context missing: route needs :orgId');
  return req.tenant;
});

export const Principal = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest<ResutoRequest>().principal;
});
