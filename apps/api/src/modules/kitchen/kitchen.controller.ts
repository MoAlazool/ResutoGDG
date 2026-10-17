import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { kitchenBumpRequest, kitchenLineRequest } from '@resuto/contracts';
import { z } from 'zod';
import type { TenantContext } from '../../common/auth/context';
import { RequirePermission, Tenant } from '../../common/auth/decorators';
import { zod } from '../../common/http/zod.pipe';
import { KitchenService } from './kitchen.service';

const uuidPipe = new ParseUUIDPipe();
const feedQuery = z.object({ station: z.string().trim().min(1).max(40).optional(), since: z.string().max(24).optional() });

@Controller('o/:orgId/kitchen')
export class KitchenController {
  constructor(private readonly kitchen: KitchenService) {}

  @Get(':branchId/prep-times')
  @RequirePermission('kitchen:operate')
  prepTimes(@Tenant() ctx: TenantContext, @Param('branchId', uuidPipe) branchId: string, @Query('days') days?: string) {
    return this.kitchen.prepTimes(ctx, branchId, z.coerce.number().int().min(1).max(90).default(7).parse(days ?? undefined));
  }

  /** KDS feed. Poll every ~2 s with `since=<cursor>`; `unchanged: true` means nothing moved. */
  @Get(':branchId')
  @RequirePermission('kitchen:operate')
  feed(@Tenant() ctx: TenantContext, @Param('branchId', uuidPipe) branchId: string, @Query(zod(feedQuery)) q: z.infer<typeof feedQuery>) {
    return this.kitchen.feed(ctx, branchId, q);
  }

  @Post('orders/:orderId/bump')
  @RequirePermission('kitchen:operate', 'orders:status')
  bump(@Tenant() ctx: TenantContext, @Param('orderId', uuidPipe) orderId: string, @Body(zod(kitchenBumpRequest)) body: z.infer<typeof kitchenBumpRequest>) {
    return this.kitchen.bump(ctx, orderId, body.to, body.version);
  }

  @Post('lines/:lineId')
  @RequirePermission('kitchen:operate')
  line(@Tenant() ctx: TenantContext, @Param('lineId', uuidPipe) lineId: string, @Body(zod(kitchenLineRequest)) body: z.infer<typeof kitchenLineRequest>) {
    return this.kitchen.line(ctx, lineId, body.status);
  }
}
