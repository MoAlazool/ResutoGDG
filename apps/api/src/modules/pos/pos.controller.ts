import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, Res } from '@nestjs/common';
import {
  createPosPairingRequest, posDeviceListQuery, posEventsQuery, posKitchenBumpRequest, posKitchenLineRequest, posKitchenQuery, posOrderSubmit,
  posOrdersSyncQuery, posPairRequest, posQuoteRequest, posPaymentRequest, posPrintJobComplete, posPrintJobsQuery, posReceiptRequest, posRevokeRequest,
  posSnapshotQuery, posTransitionRequest,
  type CreatePosPairingRequest, type PosEventsQuery, type PosOrderSubmit, type PosPairRequest, type PosPaymentRequest, type PosQuoteRequest,
} from '@resuto/contracts';
import type { Response } from 'express';
import { z } from 'zod';
import type { AuthPrincipal, ResutoRequest, TenantContext } from '../../common/auth/context';
import { PosDevice, PosStaffOptional, Principal, Public, RequirePermission, Tenant } from '../../common/auth/decorators';
import { RateLimiter } from '../../common/http/rate-limiter';
import { zod } from '../../common/http/zod.pipe';
import { PosDevicesService } from './pos-devices.service';
import { PosFeedService } from './pos-feed.service';
import { PosOrdersService } from './pos-orders.service';
import { PosPrintService } from './pos-print.service';
import { PosSyncService } from './pos-sync.service';

const uuidPipe = new ParseUUIDPipe();

/** Staff: pairing codes and the device list (devices:manage; branch-scoped managers see their branches only). */
@Controller('o/:orgId/pos')
export class PosAdminController {
  constructor(private readonly devices: PosDevicesService) {}

  @Post('pairings')
  @RequirePermission('devices:manage')
  createPairing(@Tenant() ctx: TenantContext, @Body(zod(createPosPairingRequest)) body: CreatePosPairingRequest) {
    return this.devices.createPairing(ctx, body);
  }

  @Get('devices')
  @RequirePermission('devices:manage')
  list(@Tenant() ctx: TenantContext, @Query(zod(posDeviceListQuery)) q: z.infer<typeof posDeviceListQuery>) {
    return this.devices.list(ctx, q);
  }

  @Get('devices/:id')
  @RequirePermission('devices:manage')
  get(@Tenant() ctx: TenantContext, @Param('id', uuidPipe) id: string) {
    return this.devices.get(ctx, id);
  }

  @HttpCode(200)
  @Post('devices/:id/revoke')
  @RequirePermission('devices:manage')
  revoke(@Tenant() ctx: TenantContext, @Param('id', uuidPipe) id: string, @Body(zod(posRevokeRequest)) body: z.infer<typeof posRevokeRequest>) {
    return this.devices.revoke(ctx, id, body.reason);
  }
}

/** Device (public): exchanges a one-time pairing code for the device credential. */
@Controller('pos')
export class PosPairingController {
  constructor(private readonly devices: PosDevicesService, private readonly limiter: RateLimiter) {}

  @Public()
  @Post('pair')
  async pair(@Req() req: ResutoRequest, @Body(zod(posPairRequest)) body: PosPairRequest) {
    // Codes carry 50 bits and expire within the hour; the limit stops guessing at scale.
    await this.limiter.guard(`pos-pair:${req.ip ?? 'unknown'}`, 30, 10 * 60_000);
    return this.devices.pair(body);
  }
}

/**
 * The POS device API (21-POSAPI, docs/api/IPAD_COMPATIBILITY.md). Only a paired device credential (rpos_...) reaches
 * these routes; the guard scopes every call to the device's org, branch and acting role.
 */
@PosDevice()
@Controller('pos')
export class PosDeviceController {
  constructor(
    private readonly devices: PosDevicesService,
    private readonly feed: PosFeedService,
    private readonly sync: PosSyncService,
    private readonly orders: PosOrdersService,
    private readonly print: PosPrintService,
  ) {}

  /** Answers without a staff session even on a requireStaff device (contract 0.2.0), so the app can show sign-in. */
  @Get('session')
  @PosStaffOptional()
  session(@Tenant() ctx: TenantContext, @Principal() principal: AuthPrincipal) {
    return this.devices.session(ctx, principal.kind === 'device' ? principal.staff : undefined);
  }

  /** Ordered per-branch events after `after`; `wait` long-polls. 409 resync_required when the cursor cannot be resumed. */
  @Get('events')
  @RequirePermission('orders:read')
  events(@Tenant() ctx: TenantContext, @Query(zod(posEventsQuery)) q: PosEventsQuery) {
    return this.feed.page(ctx, q);
  }

  @Get('sync/menu')
  @RequirePermission('menu:read')
  menu(@Tenant() ctx: TenantContext, @Query(zod(posSnapshotQuery)) q: z.infer<typeof posSnapshotQuery>) {
    return this.sync.menu(ctx, q.since);
  }

  @Get('sync/floor')
  @RequirePermission('floor:read')
  floor(@Tenant() ctx: TenantContext, @Query(zod(posSnapshotQuery)) q: z.infer<typeof posSnapshotQuery>) {
    return this.sync.floor(ctx, q.since);
  }

  @Get('sync/orders')
  @RequirePermission('orders:read')
  syncOrders(@Tenant() ctx: TenantContext, @Query(zod(posOrdersSyncQuery)) q: z.infer<typeof posOrdersSyncQuery>) {
    return this.sync.orders(ctx, q.cursor);
  }

  /** Server pricing of a cart; creates nothing. */
  @HttpCode(200)
  @Post('orders/quote')
  @RequirePermission('orders:write')
  quote(@Tenant() ctx: TenantContext, @Body(zod(posQuoteRequest)) body: PosQuoteRequest) {
    return this.orders.quote(ctx, body);
  }

  /** Idempotent by clientOrderId: a replay answers the first response with Idempotent-Replayed: true. */
  @Post('orders')
  @RequirePermission('orders:write')
  async submit(@Tenant() ctx: TenantContext, @Body(zod(posOrderSubmit)) body: PosOrderSubmit, @Res({ passthrough: true }) res: Response) {
    const out = await this.orders.submit(ctx, body);
    if (out.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return out.result;
  }

  /**
   * Durable reconciliation (contract 0.2.0): accepted (with the original submit response), processing, or 404 when
   * never accepted (resubmit with the same clientOrderId).
   */
  @Get('orders/by-client-id/:clientOrderId')
  @RequirePermission('orders:read')
  byClientId(@Tenant() ctx: TenantContext, @Param('clientOrderId', uuidPipe) clientOrderId: string) {
    return this.orders.byClientId(ctx, clientOrderId);
  }

  @Get('orders/:id')
  @RequirePermission('orders:read')
  order(@Tenant() ctx: TenantContext, @Param('id', uuidPipe) id: string) {
    return this.orders.get(ctx, id);
  }

  @HttpCode(200)
  @Post('orders/:id/transition')
  @RequirePermission('orders:status')
  transition(@Tenant() ctx: TenantContext, @Param('id', uuidPipe) id: string, @Body(zod(posTransitionRequest)) body: z.infer<typeof posTransitionRequest>) {
    return this.orders.transition(ctx, id, body.to, body.version);
  }

  /** Records a payment taken on the device; idempotent by clientPaymentId. */
  @Post('orders/:id/payments')
  @RequirePermission('payments:collect')
  payment(@Tenant() ctx: TenantContext, @Param('id', uuidPipe) id: string, @Body(zod(posPaymentRequest)) body: PosPaymentRequest) {
    return this.orders.payment(ctx, id, body);
  }

  /** Creates a receipt print job (announced on the feed as print_job.created); idempotent by clientRequestId. */
  @Post('orders/:id/receipt')
  @RequirePermission('orders:read')
  receipt(@Tenant() ctx: TenantContext, @Param('id', uuidPipe) id: string, @Body(zod(posReceiptRequest)) body: z.infer<typeof posReceiptRequest>) {
    return this.print.receipt(ctx, id, body.clientRequestId);
  }

  @Get('kitchen/routing')
  @RequirePermission('menu:read')
  routing(@Tenant() ctx: TenantContext) {
    return this.orders.routing(ctx);
  }

  /** KDS tickets of the device's branch (KitchenService feed; poll with since=<cursor>). */
  @Get('kitchen/tickets')
  @RequirePermission('kitchen:operate')
  tickets(@Tenant() ctx: TenantContext, @Query(zod(posKitchenQuery)) q: z.infer<typeof posKitchenQuery>) {
    return this.orders.tickets(ctx, q);
  }

  @HttpCode(200)
  @Post('kitchen/orders/:id/bump')
  @RequirePermission('kitchen:operate', 'orders:status')
  bump(@Tenant() ctx: TenantContext, @Param('id', uuidPipe) id: string, @Body(zod(posKitchenBumpRequest)) body: z.infer<typeof posKitchenBumpRequest>) {
    return this.orders.bump(ctx, id, body.to, body.version);
  }

  @HttpCode(200)
  @Post('kitchen/lines/:lineId')
  @RequirePermission('kitchen:operate')
  line(@Tenant() ctx: TenantContext, @Param('lineId', uuidPipe) lineId: string, @Body(zod(posKitchenLineRequest)) body: z.infer<typeof posKitchenLineRequest>) {
    return this.orders.line(ctx, lineId, body.status);
  }

  @Get('print-jobs')
  @RequirePermission('orders:read')
  printJobs(@Tenant() ctx: TenantContext, @Query(zod(posPrintJobsQuery)) q: z.infer<typeof posPrintJobsQuery>) {
    return this.print.list(ctx, q);
  }

  @Get('print-jobs/:id')
  @RequirePermission('orders:read')
  printJob(@Tenant() ctx: TenantContext, @Param('id', uuidPipe) id: string) {
    return this.print.get(ctx, id);
  }

  @HttpCode(200)
  @Post('print-jobs/:id/claim')
  @RequirePermission('orders:read')
  claim(@Tenant() ctx: TenantContext, @Param('id', uuidPipe) id: string) {
    return this.print.claim(ctx, id);
  }

  @HttpCode(200)
  @Post('print-jobs/:id/complete')
  @RequirePermission('orders:read')
  complete(@Tenant() ctx: TenantContext, @Param('id', uuidPipe) id: string, @Body(zod(posPrintJobComplete)) body: z.infer<typeof posPrintJobComplete>) {
    return this.print.complete(ctx, id, body.status, body.error);
  }
}
