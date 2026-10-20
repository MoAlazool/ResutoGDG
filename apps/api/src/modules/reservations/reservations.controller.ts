import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import {
  availabilityQuery, reservationCancelRequest, reservationConfirmRequest, reservationDayQuery, reservationHoldRequest, reservationSlotsQuery, staffReservationInput,
  staffReservationUpdate, type AvailabilityQuery, type ReservationHoldRequest,
} from '@resuto/contracts';
import { z } from 'zod';
import type { ResutoRequest, TenantContext } from '../../common/auth/context';
import { sha256 } from '../../common/crypto/hash';
import { Public, RequirePermission, Tenant } from '../../common/auth/decorators';
import { notFound } from '../../common/errors/domain-error';
import { RateLimiter } from '../../common/http/rate-limiter';
import { zod } from '../../common/http/zod.pipe';
import { ReservationsService } from './reservations.service';

const uuidPipe = new ParseUUIDPipe();
const slugish = z.string().regex(/^[a-z0-9-]{1,60}$/);
const checkInBody = z.object({ tableId: z.uuid().optional(), partySize: z.number().int().min(1).max(100).optional() });

@Controller('o/:orgId/reservations')
export class ReservationsController {
  constructor(private readonly reservations: ReservationsService) {}

  @Get()
  @RequirePermission('reservations:read')
  day(@Tenant() ctx: TenantContext, @Query(zod(reservationDayQuery)) q: z.infer<typeof reservationDayQuery>) {
    return this.reservations.day(ctx, q);
  }

  @Get('availability')
  @RequirePermission('reservations:read')
  availability(@Tenant() ctx: TenantContext, @Query(zod(availabilityQuery)) q: AvailabilityQuery) {
    return this.reservations.staffAvailability(ctx, q);
  }

  @Get(':id')
  @RequirePermission('reservations:read')
  get(@Tenant() ctx: TenantContext, @Param('id', uuidPipe) id: string) {
    return this.reservations.get(ctx, id);
  }

  @Post()
  @RequirePermission('reservations:write')
  create(@Tenant() ctx: TenantContext, @Body(zod(staffReservationInput)) body: z.infer<typeof staffReservationInput>, @Headers('idempotency-key') key?: string) {
    return this.reservations.create(ctx, body, key);
  }

  @Patch(':id')
  @RequirePermission('reservations:write')
  update(@Tenant() ctx: TenantContext, @Param('id', uuidPipe) id: string, @Body(zod(staffReservationUpdate)) body: z.infer<typeof staffReservationUpdate>) {
    return this.reservations.update(ctx, id, body);
  }

  @Post(':id/cancel')
  @RequirePermission('reservations:write')
  cancel(@Tenant() ctx: TenantContext, @Param('id', uuidPipe) id: string, @Body(zod(reservationCancelRequest)) body: { reason?: string | null }) {
    return this.reservations.staffCancel(ctx, id, body.reason);
  }

  @Post(':id/no-show')
  @RequirePermission('reservations:write')
  noShow(@Tenant() ctx: TenantContext, @Param('id', uuidPipe) id: string) {
    return this.reservations.noShow(ctx, id);
  }

  @Post(':id/check-in')
  @RequirePermission('reservations:write', 'floor:seat')
  checkIn(@Tenant() ctx: TenantContext, @Param('id', uuidPipe) id: string, @Body(zod(checkInBody)) body: z.infer<typeof checkInBody>) {
    return this.reservations.checkIn(ctx, id, body);
  }
}

/** Public booking: availability, 5-minute holds, confirm/deposit and the guest manage link. */
@Controller('public/reservations')
export class PublicReservationsController {
  constructor(private readonly reservations: ReservationsService, private readonly limiter: RateLimiter) {}

  private tokenLimit(req: ResutoRequest, token: string | undefined, scope: string, perIp: number, perToken: number) {
    this.limiter.hit(`reservations:${scope}:ip:${req.ip}`, perIp);
    if (token) this.limiter.hit(`reservations:${scope}:tok:${sha256(token).slice(0, 24)}`, perToken);
  }

  @Public()
  @Get('manage')
  manage(@Headers('x-reservation-token') token: string | undefined, @Req() req: ResutoRequest) {
    this.tokenLimit(req, token, 'manage', 60, 60);
    return this.reservations.manageView(token);
  }

  @Public()
  @Post('manage/confirm')
  @HttpCode(200)
  confirm(@Headers('x-reservation-token') token: string | undefined, @Body(zod(reservationConfirmRequest)) body: { key: string; returnUrl?: string }, @Req() req: ResutoRequest) {
    this.tokenLimit(req, token, 'confirm', 30, 10);
    return this.reservations.confirm(token, body);
  }

  @Public()
  @Post('manage/cancel')
  @HttpCode(200)
  cancel(@Headers('x-reservation-token') token: string | undefined, @Body(zod(reservationCancelRequest)) body: { reason?: string | null }, @Req() req: ResutoRequest) {
    this.tokenLimit(req, token, 'cancel', 30, 10);
    return this.reservations.guestCancel(token, body.reason);
  }

  @Public()
  @Get(':slug/availability')
  availability(@Param('slug') slug: string, @Query(zod(availabilityQuery)) q: AvailabilityQuery, @Req() req: ResutoRequest) {
    this.limiter.hit(`reservations:availability:${req.ip}`, 120);
    if (!slugish.safeParse(slug).success) throw notFound('Restaurant');
    return this.reservations.publicAvailability(slug, q);
  }

  /** Sittings of a service with free-table counts, in the branch time zone (VP-08, VP-11). */
  @Public()
  @Get(':slug/slots')
  slots(@Param('slug') slug: string, @Query(zod(reservationSlotsQuery)) q: z.infer<typeof reservationSlotsQuery>, @Req() req: ResutoRequest) {
    this.limiter.hit(`reservations:availability:${req.ip}`, 120);
    if (!slugish.safeParse(slug).success) throw notFound('Restaurant');
    return this.reservations.publicSlots(slug, q);
  }

  @Public()
  @Post(':slug/holds')
  hold(@Param('slug') slug: string, @Body(zod(reservationHoldRequest)) body: ReservationHoldRequest, @Req() req: ResutoRequest) {
    this.limiter.hit(`reservations:hold:${req.ip}`, 20);
    if (!slugish.safeParse(slug).success) throw notFound('Restaurant');
    // Per number, not per spelling: 010…, 10…, 20…, +20… and 0020… of one phone share a budget (CR-06).
    return this.reservations.hold(slug, body, (e164) => this.limiter.hit(`reservations:hold:phone:${sha256(e164).slice(0, 24)}`, 10));
  }
}
