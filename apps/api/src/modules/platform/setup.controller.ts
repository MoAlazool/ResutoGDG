import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { serviceModeRequest, type ServiceModeRequest } from '@resuto/contracts';
import { z } from 'zod';
import type { TenantContext } from '../../common/auth/context';
import { RequirePermission, Tenant } from '../../common/auth/decorators';
import { zod } from '../../common/http/zod.pipe';
import { SetupService } from './setup.service';

const branchQuery = z.object({ branchId: z.uuid().optional().or(z.literal('').transform(() => undefined)) });

/** Guided setup and the service model (legacy /manager/setup and settings "Service model"; FT-13, VS-16, VS-17, FT-07). */
@Controller('o/:orgId')
export class SetupController {
  constructor(private readonly setup: SetupService) {}

  /** Derived checklist: what is done is computed from the restaurant's data, never ticked by hand. */
  @Get('setup')
  @RequirePermission('org:manage')
  checklist(@Tenant() ctx: TenantContext, @Query(zod(branchQuery)) q: z.infer<typeof branchQuery>) {
    return this.setup.checklist(ctx, q.branchId);
  }

  @HttpCode(200)
  @Post('setup/launch')
  @RequirePermission('org:manage')
  launch(@Tenant() ctx: TenantContext) {
    return this.setup.launch(ctx);
  }

  @Put('branches/:branchId/service-mode')
  @RequirePermission('branches:manage')
  serviceMode(@Tenant() ctx: TenantContext, @Param('branchId', ParseUUIDPipe) branchId: string, @Body(zod(serviceModeRequest)) body: ServiceModeRequest) {
    return this.setup.setServiceMode(ctx, branchId, body);
  }
}
