import { Body, Controller, Get, Param, ParseUUIDPipe, Put, Req } from '@nestjs/common';
import { floorSaveInput, type FloorSaveInput } from '@resuto/contracts';
import { z } from 'zod';
import type { ResutoRequest, TenantContext } from '../../common/auth/context';
import { AllowMcp, Public, RequirePermission, Tenant } from '../../common/auth/decorators';
import { notFound } from '../../common/errors/domain-error';
import { RateLimiter } from '../../common/http/rate-limiter';
import { zod } from '../../common/http/zod.pipe';
import { FloorService } from './floor.service';

const uuidPipe = new ParseUUIDPipe();

/** Floor API (MODULE_CONTRACTS §8, consumed by Floor Studio and the live floor). */
@Controller('o/:orgId/floor')
export class FloorController {
  constructor(private readonly floor: FloorService) {}

  @Get(':branchId')
  @AllowMcp()
  @RequirePermission('floor:read')
  get(@Tenant() ctx: TenantContext, @Param('branchId', uuidPipe) branchId: string) {
    return this.floor.get(ctx, branchId);
  }

  @Put(':branchId')
  @RequirePermission('floor:write')
  save(@Tenant() ctx: TenantContext, @Param('branchId', uuidPipe) branchId: string, @Body(zod(floorSaveInput)) body: FloorSaveInput) {
    return this.floor.save(ctx, branchId, body);
  }

  @Get(':branchId/live')
  @AllowMcp()
  @RequirePermission('floor:read')
  live(@Tenant() ctx: TenantContext, @Param('branchId', uuidPipe) branchId: string) {
    return this.floor.live(ctx, branchId);
  }

  @Get(':branchId/qr')
  @RequirePermission('floor:write')
  qr(@Tenant() ctx: TenantContext, @Param('branchId', uuidPipe) branchId: string) {
    return this.floor.qrSheet(ctx, branchId);
  }
}

const slugish = z.string().regex(/^[a-z0-9-]{1,60}$/);

@Controller('public/floor')
export class PublicFloorController {
  constructor(private readonly floor: FloorService, private readonly limiter: RateLimiter) {}

  @Public()
  @Get(':slug/:branchCode')
  get(@Param('slug') slug: string, @Param('branchCode') branchCode: string, @Req() req: ResutoRequest) {
    this.limiter.hit(`public-floor:${req.ip}`, 120);
    if (!slugish.safeParse(slug).success || !slugish.safeParse(branchCode).success) throw notFound('Branch');
    return this.floor.publicFloor(slug, branchCode);
  }
}
