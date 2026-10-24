import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { ModuleKey, Permission } from '@resuto/contracts';
import type { ResutoRequest } from './context';

export const IS_PUBLIC = 'resuto:public';
export const PERMISSION = 'resuto:permission';
export const MODULE = 'resuto:module';
export const PLATFORM_ROLE = 'resuto:platform';
export const MCP_RUNTIME = 'resuto:mcp-runtime';
export const POS_DEVICE = 'resuto:pos-device';
export const POS_STAFF_OPTIONAL = 'resuto:pos-staff-optional';

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
 * The POS device API (21-POSAPI): the ONLY routes a device credential (rpos_...) may reach, and routes only a paired
 * device may call (a staff token as the Authorization header is refused). The guard builds the tenant from the device
 * (org, branch, acting role), so these routes have no :orgId. A staff session may supplement the device credential
 * (contract 0.2.0, X-Resuto-Staff-Authorization): the request then acts as that employee, bounded by the acting role.
 * Class-level only; test/pos-flow.test.ts enumerates every route.
 */
export const PosDevice = (): ClassDecorator => SetMetadata(POS_DEVICE, true);
/**
 * A POS device route that a device paired with requireStaff (contract 0.2.0) may call without a staff session
 * (X-Resuto-Staff-Authorization): only GET /v1/pos/session, so the app can learn that it must sign a staff member in.
 */
export const PosStaffOptional = () => SetMetadata(POS_STAFF_OPTIONAL, true);
export const Tenant = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest<ResutoRequest>();
  if (!req.tenant) throw new Error('Tenant context missing: route needs :orgId');
  return req.tenant;
});

export const Principal = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest<ResutoRequest>().principal;
});
