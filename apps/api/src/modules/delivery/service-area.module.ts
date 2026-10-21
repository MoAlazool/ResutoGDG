import { Body, Controller, Delete, Get, Global, Module, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import { deliveryZoneInput, type DeliveryZoneInput } from '@resuto/contracts';
import { z } from 'zod';
import type { ResutoRequest, TenantContext } from '../../common/auth/context';
import { Public, RequirePermission, Tenant } from '../../common/auth/decorators';
import { notFound } from '../../common/errors/domain-error';
import { RateLimiter } from '../../common/http/rate-limiter';
import { zod } from '../../common/http/zod.pipe';
import { SERVICE_AREA_PORT } from '../kernel/ports';
import { ServiceAreaService } from './service-area.service';
import { PublicTrackingService } from './tracking.service';

const branchQuery = z.object({ branchId: z.uuid().optional() });
const publicQuery = z.object({ branchId: z.uuid() });

/** FT-09: delivery zones per branch (fee, minimum order, ETA, coverage). Not behind the driver module: web delivery needs them too. */
@Controller('o/:orgId/delivery-zones')
export class DeliveryZonesController {
  constructor(private readonly area: ServiceAreaService) {}

  @Get()
  @RequirePermission('orders:read')
  list(@Tenant() ctx: TenantContext, @Query(zod(branchQuery)) q: z.infer<typeof branchQuery>) {
    return this.area.list(ctx, q.branchId);
  }

  @Post()
  @RequirePermission('branches:manage')
  create(@Tenant() ctx: TenantContext, @Body(zod(deliveryZoneInput)) body: DeliveryZoneInput) {
    return this.area.create(ctx, body);
  }

  @Put(':zoneId')
  @RequirePermission('branches:manage')
  update(@Tenant() ctx: TenantContext, @Param('zoneId', ParseUUIDPipe) id: string, @Body(zod(deliveryZoneInput)) body: DeliveryZoneInput) {
    return this.area.update(ctx, id, body);
  }

  @Delete(':zoneId')
  @RequirePermission('branches:manage')
  remove(@Tenant() ctx: TenantContext, @Param('zoneId', ParseUUIDPipe) id: string) {
    return this.area.remove(ctx, id);
  }
}

/** Public: open now / next opening and the delivery areas a guest can choose, for the website and WhatsApp ordering pages. */
@Controller('public/order')
export class PublicServiceAreaController {
  constructor(private readonly area: ServiceAreaService, private readonly limiter: RateLimiter) {}

  @Public()
  @Get(':slug/service-area')
  view(@Param('slug') slug: string, @Query(zod(publicQuery)) q: z.infer<typeof publicQuery>, @Req() req: ResutoRequest) {
    this.limiter.hit(`service-area:${req.ip ?? 'unknown'}`, 120);
    if (!/^[a-z0-9-]{2,64}$/i.test(slug)) throw notFound('Restaurant');
    return this.area.publicView(slug, q.branchId);
  }
}

/**
 * FT-09: provides SERVICE_AREA_PORT to the kernel pricing engine (global, like LOYALTY_PORT).
 * FT-14: PublicTrackingService gives the guest tracking page its delivery view.
 */
@Global()
@Module({
  controllers: [DeliveryZonesController, PublicServiceAreaController],
  providers: [ServiceAreaService, PublicTrackingService, { provide: SERVICE_AREA_PORT, useExisting: ServiceAreaService }],
  exports: [ServiceAreaService, PublicTrackingService, SERVICE_AREA_PORT],
})
export class ServiceAreaModule {}
