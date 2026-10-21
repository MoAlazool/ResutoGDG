import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  closeVisitRequest, collectPaymentRequest, orderCancelRequest, orderListQuery, orderTransitionRequest, seatVisitRequest, staffOrderRequest, visitListQuery,
  type OrderListQuery, type StaffOrderRequest,
} from '@resuto/contracts';
import { z } from 'zod';
import type { TenantContext } from '../../common/auth/context';
import { RequirePermission, Tenant } from '../../common/auth/decorators';
import { zod } from '../../common/http/zod.pipe';
import { OrdersService } from './orders.service';
import { VisitsService } from './visits.service';

const uuidPipe = new ParseUUIDPipe();
const branchQuery = z.object({ branchId: z.uuid().optional().or(z.literal('').transform(() => undefined)) });

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

  @HttpCode(200)
  @Post('orders/:id/transition')
  @RequirePermission('orders:status')
  transition(@Tenant() ctx: TenantContext, @Param('id', uuidPipe) id: string, @Body(zod(orderTransitionRequest)) body: z.infer<typeof orderTransitionRequest>) {
    return this.orders.transition(ctx, id, body.to, body.version);
  }

  @HttpCode(200)
  @Post('orders/:id/cancel')
  @RequirePermission('orders:cancel')
  cancel(@Tenant() ctx: TenantContext, @Param('id', uuidPipe) id: string, @Body(zod(orderCancelRequest)) body: z.infer<typeof orderCancelRequest>) {
    return this.orders.cancel(ctx, id, body.reason, body.version);
  }

  @HttpCode(200)
  @Post('orders/:id/collect')
  @RequirePermission('payments:collect')
  collect(@Tenant() ctx: TenantContext, @Param('id', uuidPipe) id: string, @Body(zod(collectPaymentRequest)) body: z.infer<typeof collectPaymentRequest>,
    @Headers('idempotency-key') key?: string) {
    return this.orders.collect(ctx, id, body, key);
  }

  @Get('requests')
  @RequirePermission('orders:read')
  requests(@Tenant() ctx: TenantContext, @Query(zod(branchQuery)) q: z.infer<typeof branchQuery>) {
    return this.orders.requests(ctx, q.branchId);
  }

  @HttpCode(200)
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

  /** Open visits with their bills (legacy "Active visits"). */
  @Get('visits')
  @RequirePermission('floor:read')
  list(@Tenant() ctx: TenantContext, @Query(zod(visitListQuery)) q: z.infer<typeof visitListQuery>) {
    return this.visits.listOpen(ctx, q.branchId);
  }

  @Get('visits/:visitId')
  @RequirePermission('floor:read')
  get(@Tenant() ctx: TenantContext, @Param('visitId', uuidPipe) id: string) {
    return this.visits.staffDetail(ctx, id);
  }

  @HttpCode(200)
  @Post('visits/:visitId/close')
  @RequirePermission('floor:seat')
  close(@Tenant() ctx: TenantContext, @Param('visitId', uuidPipe) id: string, @Body(zod(closeVisitRequest)) body: z.infer<typeof closeVisitRequest>) {
    return this.visits.close(ctx, id, body);
  }

  @HttpCode(200)
  @Post('visits/:visitId/undo')
  @RequirePermission('floor:seat')
  undo(@Tenant() ctx: TenantContext, @Param('visitId', uuidPipe) id: string) {
    return this.visits.undo(ctx, id);
  }

  @HttpCode(200)
  @Post('visits/:visitId/collect')
  @RequirePermission('payments:collect')
  collect(@Tenant() ctx: TenantContext, @Param('visitId', uuidPipe) id: string, @Body(zod(collectPaymentRequest)) body: z.infer<typeof collectPaymentRequest>,
    @Headers('idempotency-key') key?: string) {
    return this.visits.collect(ctx, id, body, key);
  }

  @HttpCode(200)
  @Post('tables/:tableId/clean')
  @RequirePermission('floor:seat')
  clean(@Tenant() ctx: TenantContext, @Param('tableId', uuidPipe) id: string) {
    return this.visits.clean(ctx, id);
  }
}
