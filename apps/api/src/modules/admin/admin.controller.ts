import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  adminStatusChange, adminTenantsQuery, countryCode, grantOverride, newModulePrice, newPlanPrice, revokeOverride,
  type AdminTenantsQuery, type GrantOverride, type NewModulePrice, type NewPlanPrice,
} from '@resuto/contracts';
import type { AuthPrincipal } from '../../common/auth/context';
import { PlatformAdmin, Principal } from '../../common/auth/decorators';
import { RequireMfa } from '../../common/auth/mfa.guard';
import { zod } from '../../common/http/zod.pipe';
import { AdminService } from './admin.service';

/**
 * `/v1/admin/...` — Resuto platform staff only (AccessGuard checks
 * platform_admins and the roles listed on each route). Support is read-only,
 * finance additionally reads billing and prices, superadmins mutate.
 */
@Controller('admin')
@RequireMfa()
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('me')
  @PlatformAdmin()
  async me(@Principal() p: AuthPrincipal) {
    const actor = await this.admin.actor(p);
    return { userId: actor.userId, role: actor.role };
  }

  @Get('tenants')
  @PlatformAdmin()
  tenants(@Query(zod(adminTenantsQuery)) q: AdminTenantsQuery) {
    return this.admin.listTenants(q);
  }

  @Get('tenants/:orgId')
  @PlatformAdmin()
  async tenant(@Principal() p: AuthPrincipal, @Param('orgId') orgId: string) {
    return this.admin.tenant(await this.admin.actor(p), orgId);
  }

  @Post('tenants/:orgId/suspend')
  @HttpCode(200)
  @PlatformAdmin('superadmin')
  async suspend(@Principal() p: AuthPrincipal, @Param('orgId') orgId: string, @Body(zod(adminStatusChange)) body: { reason: string }) {
    return this.admin.setStatus(await this.admin.actor(p), orgId, 'suspended', body.reason);
  }

  @Post('tenants/:orgId/reactivate')
  @HttpCode(200)
  @PlatformAdmin('superadmin')
  async reactivate(@Principal() p: AuthPrincipal, @Param('orgId') orgId: string, @Body(zod(adminStatusChange)) body: { reason: string }) {
    return this.admin.setStatus(await this.admin.actor(p), orgId, 'active', body.reason);
  }

  @Post('tenants/:orgId/overrides')
  @PlatformAdmin('superadmin')
  async grant(@Principal() p: AuthPrincipal, @Param('orgId') orgId: string, @Body(zod(grantOverride)) body: GrantOverride) {
    return this.admin.grantOverride(await this.admin.actor(p), orgId, body);
  }

  @Post('tenants/:orgId/overrides/:overrideId/revoke')
  @HttpCode(200)
  @PlatformAdmin('superadmin')
  async revoke(@Principal() p: AuthPrincipal, @Param('orgId') orgId: string, @Param('overrideId') overrideId: string, @Body(zod(revokeOverride)) body: { reason: string }) {
    return this.admin.revokeOverride(await this.admin.actor(p), orgId, overrideId, body.reason);
  }

  @Get('prices')
  @PlatformAdmin('superadmin', 'finance')
  prices(@Query('country') country?: string) {
    return this.admin.prices(country ? countryCode.parse(country) : undefined);
  }

  @Post('prices/plans')
  @PlatformAdmin('superadmin')
  async addPlanPrice(@Principal() p: AuthPrincipal, @Body(zod(newPlanPrice)) body: NewPlanPrice) {
    return this.admin.addPlanPrice(await this.admin.actor(p), body);
  }

  @Post('prices/modules')
  @PlatformAdmin('superadmin')
  async addModulePrice(@Principal() p: AuthPrincipal, @Body(zod(newModulePrice)) body: NewModulePrice) {
    return this.admin.addModulePrice(await this.admin.actor(p), body);
  }

  @Get('operations')
  @PlatformAdmin()
  operations() {
    return this.admin.operations();
  }

  /** Dead-letter replay: re-queues one handler run of an outbox event (superadmins; audited). */
  @Post('operations/handlings/:eventId/:handler/replay')
  @HttpCode(200)
  @PlatformAdmin('superadmin')
  async replay(@Principal() p: AuthPrincipal, @Param('eventId') eventId: string, @Param('handler') handler: string,
    @Body(zod(adminStatusChange)) body: { reason: string }) {
    return this.admin.replayHandling(await this.admin.actor(p), eventId, handler, body.reason);
  }
}
