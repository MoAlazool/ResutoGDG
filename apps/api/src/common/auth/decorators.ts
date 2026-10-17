import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { ModuleKey, Permission } from '@resuto/contracts';
import type { ResutoRequest } from './context';

export const IS_PUBLIC = 'resuto:public';
export const PERMISSION = 'resuto:permission';
export const MODULE = 'resuto:module';
export const PLATFORM_ROLE = 'resuto:platform';
export const ALLOW_MCP = 'resuto:allow-mcp';

/** No authentication required (guest, webhook, public website endpoints). */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** Tenant route permission (route must contain :orgId). */
export const RequirePermission = (...permissions: Permission[]) => SetMetadata(PERMISSION, permissions);
/** Backend entitlement: the tenant's subscription must include this module. */
export const RequiresModule = (module: ModuleKey) => SetMetadata(MODULE, module);
/** Platform administration routes. */
export const PlatformAdmin = (...roles: Array<'superadmin' | 'support' | 'finance'>) => SetMetadata(PLATFORM_ROLE, roles.length ? roles : ['superadmin', 'support', 'finance']);
/** MCP client keys may call this route (otherwise they are rejected). */
export const AllowMcp = () => SetMetadata(ALLOW_MCP, true);

export const Tenant = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest<ResutoRequest>();
  if (!req.tenant) throw new Error('Tenant context missing: route needs :orgId');
  return req.tenant;
});

export const Principal = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest<ResutoRequest>().principal;
});
