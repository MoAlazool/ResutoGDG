import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  closeVisitRequest, collectPaymentRequest, orderCancelRequest, orderListQuery, orderTransitionRequest, seatVisitRequest, staffOrderRequest,
  type OrderListQuery, type StaffOrderRequest,
} from '@resuto/contracts';
import { z } from 'zod';
import type { TenantContext } from '../../common/auth/context';
import { RequirePermission, Tenant } from '../../common/auth/decorators';
import { zod } from '../../common/http/zod.pipe';
import { OrdersService } from './orders.service';
import { VisitsService } from './visits.service';

const uuidPipe = new ParseUUIDPipe();

@Controller('o/:orgId')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get('orders')
  @RequirePermission('orders:read')
  list(@Tenant() ctx: TenantContext, @Query(zod(orderListQuery)) q: OrderListQuery) {
    return this.orders.listOrders(ctx, q);
  }

  @Get('orders/:id')
  @RequirePermission('orders:read')
  get(@Tenant() ctx: TenantContext, @Param('id', uuidPipe) id: string) {
    return this.orders.detail(ctx, id);
  }

  @Post('orders')
  @RequirePermission('orders:write')
  create(@Tenant() ctx: TenantContext, @Body(zod(staffOrderRequest)) body: StaffOrderRequest, @Headers('idempotency-key') key?: string) {
    return this.orders.create(ctx, body, key);
  }

  @Post('orders/:id/transition')
  @RequirePermission('orders:status')
  transition(@Tenant() ctx: TenantContext, @Param('id', uuidPipe) id: string, @Body(zod(orderTransitionRequest)) body: z.infer<typeof orderTransitionRequest>) {
    return this.orders.transition(ctx, id, body.to, body.version);
  }

  @Post('orders/:id/cancel')
  @RequirePermission('orders:cancel')
  cancel(@Tenant() ctx: TenantContext, @Param('id', uuidPipe) id: string, @Body(zod(orderCancelRequest)) body: z.infer<typeof orderCancelRequest>) {
    return this.orders.cancel(ctx, id, body.reason, body.version);
  }

  @Post('orders/:id/collect')
  @RequirePermission('payments:collect')
  collect(@Tenant() ctx: TenantContext, @Param('id', uuidPipe) id: string, @Body(zod(collectPaymentRequest)) body: z.infer<typeof collectPaymentRequest>,
    @Headers('idempotency-key') key?: string) {
    return this.orders.collect(ctx, id, body, key);
  }

  @Get('requests')
  @RequirePermission('orders:read')
  requests(@Tenant() ctx: TenantContext, @Query('branchId') branchId?: string) {
    return this.orders.requests(ctx, z.uuid().optional().parse(branchId || undefined));
  }

  @Post('requests/:id/resolve')
  @RequirePermission('orders:read')
  resolve(@Tenant() ctx: TenantContext, @Param('id', uuidPipe) id: string, @Body(zod(z.object({ status: z.enum(['acknowledged', 'resolved']).default('resolved') }))) body: { status: 'acknowledged' | 'resolved' }) {
    return this.orders.resolveRequest(ctx, id, body.status);
  }
}

/** Visits (§8): seat / walk-in, close, undo auto-open, mark clean, counter collection. */
@Controller('o/:orgId')
export class VisitsController {
  constructor(private readonly visits: VisitsService) {}

  @Post('visits')
  @RequirePermission('floor:seat')
  seat(@Tenant() ctx: TenantContext, @Body(zod(seatVisitRequest)) body: z.infer<typeof seatVisitRequest>) {
    return this.visits.seat(ctx, body);
  }

  @Get('visits/:visitId')
  @RequirePermission('floor:read')
  get(@Tenant() ctx: TenantContext, @Param('visitId', uuidPipe) id: string) {
    return this.visits.staffDetail(ctx, id);
  }

  @Post('visits/:visitId/close')
  @RequirePermission('floor:seat')
  close(@Tenant() ctx: TenantContext, @Param('visitId', uuidPipe) id: string, @Body(zod(closeVisitRequest)) body: z.infer<typeof closeVisitRequest>) {
    return this.visits.close(ctx, id, body);
  }

  @Post('visits/:visitId/undo')
  @RequirePermission('floor:seat')
  undo(@Tenant() ctx: TenantContext, @Param('visitId', uuidPipe) id: string) {
    return this.visits.undo(ctx, id);
  }

  @Post('visits/:visitId/collect')
  @RequirePermission('payments:collect')
  collect(@Tenant() ctx: TenantContext, @Param('visitId', uuidPipe) id: string, @Body(zod(collectPaymentRequest)) body: z.infer<typeof collectPaymentRequest>,
    @Headers('idempotency-key') key?: string) {
    return this.visits.collect(ctx, id, body, key);
  }

  @Post('tables/:tableId/clean')
  @RequirePermission('floor:seat')
  clean(@Tenant() ctx: TenantContext, @Param('tableId', uuidPipe) id: string) {
    return this.visits.clean(ctx, id);
  }
}
