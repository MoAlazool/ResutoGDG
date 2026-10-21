import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { kitchenBumpRequest, kitchenLineRequest } from '@resuto/contracts';
import { z } from 'zod';
import type { TenantContext } from '../../common/auth/context';
import { RequirePermission, Tenant } from '../../common/auth/decorators';
import { zod } from '../../common/http/zod.pipe';
import { KitchenService } from './kitchen.service';

/** PS-21: validated by the pipe, so a bad value names its field (details.path "days"). */
const prepTimesQuery = z.object({ days: z.coerce.number().int().min(1).max(90).default(7) });

const uuidPipe = new ParseUUIDPipe();
const feedQuery = z.object({ station: z.string().trim().min(1).max(40).optional(), since: z.string().max(24).optional() });

@Controller('o/:orgId/kitchen')
export class KitchenController {
  constructor(private readonly kitchen: KitchenService) {}

  @Get(':branchId/prep-times')
  @RequirePermission('kitchen:operate')
  prepTimes(@Tenant() ctx: TenantContext, @Param('branchId', uuidPipe) branchId: string, @Query(zod(prepTimesQuery)) q: z.infer<typeof prepTimesQuery>) {
    return this.kitchen.prepTimes(ctx, branchId, q.days);
  }

  /** KDS feed. Poll every ~2 s with `since=<cursor>`; `unchanged: true` means nothing moved. */
  @Get(':branchId')
  @RequirePermission('kitchen:operate')
  feed(@Tenant() ctx: TenantContext, @Param('branchId', uuidPipe) branchId: string, @Query(zod(feedQuery)) q: z.infer<typeof feedQuery>) {
    return this.kitchen.feed(ctx, branchId, q);
  }

  @HttpCode(200)
  @Post('orders/:orderId/bump')
  @RequirePermission('kitchen:operate', 'orders:status')
  bump(@Tenant() ctx: TenantContext, @Param('orderId', uuidPipe) orderId: string, @Body(zod(kitchenBumpRequest)) body: z.infer<typeof kitchenBumpRequest>) {
    return this.kitchen.bump(ctx, orderId, body.to, body.version);
  }

  @HttpCode(200)
  @Post('lines/:lineId')
  @RequirePermission('kitchen:operate')
  line(@Tenant() ctx: TenantContext, @Param('lineId', uuidPipe) lineId: string, @Body(zod(kitchenLineRequest)) body: z.infer<typeof kitchenLineRequest>) {
    return this.kitchen.line(ctx, lineId, body.status);
  }
}
