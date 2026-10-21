import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  assignJob, availabilityInput, cancelJob, declineJob, deliverJob, deliveryJobQuery, deviceRegistration, driverAction, driverUpdate,
  failJob, locationBatch, settlementInput,
} from '@resuto/contracts';
import { z } from 'zod';
import type { TenantContext } from '../../common/auth/context';
import { RequirePermission, RequiresModule, Tenant } from '../../common/auth/decorators';
import { zod } from '../../common/http/zod.pipe';
import { DeliveryService } from './delivery.service';
import { DriverAppService } from './driver-app.service';
import { DriverPushService } from './driver-push.service';

type Upload = { buffer: Buffer; mimetype: string; size: number; originalname: string } | undefined;
const uploadLimits = FileInterceptor('file', { limits: { fileSize: 15 * 1024 * 1024, files: 1 } });
const historyQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(30), cursor: z.string().max(200).optional() });
const optionalBody = <T extends z.ZodTypeAny>(s: T) => z.preprocess((v) => v ?? {}, s);
const deviceIdSchema = z.string().trim().min(8).max(200);
const driversQuery = z.object({ includeSuspended: z.enum(['true', 'false']).optional() });
const pushConfigQuery = z.object({ deviceId: deviceIdSchema.optional().or(z.literal('')) });
const pushSubscribe = z.object({ deviceId: deviceIdSchema, subscription: z.unknown(), appVersion: z.string().trim().max(40).optional().nullable() });

/** Dispatch board and driver management (managers: delivery:dispatch). */
@Controller('o/:orgId/delivery')
@RequiresModule('driver')
export class DispatchController {
  constructor(private readonly delivery: DeliveryService) {}

  @Get('board')
  @RequirePermission('delivery:dispatch')
  board(@Tenant() ctx: TenantContext, @Query('branchId', new ParseUUIDPipe({ optional: true })) branchId?: string) {
    return this.delivery.board(ctx, branchId);
  }

  @Get('jobs')
  @RequirePermission('delivery:dispatch')
  jobs(@Tenant() ctx: TenantContext, @Query(zod(deliveryJobQuery)) q: z.infer<typeof deliveryJobQuery>) {
    return this.delivery.listJobs(ctx, q);
  }

  @Get('jobs/:jobId')
  @RequirePermission('delivery:dispatch')
  job(@Tenant() ctx: TenantContext, @Param('jobId', ParseUUIDPipe) jobId: string) {
    return this.delivery.jobDetail(ctx, jobId);
  }

  @Post('jobs/:jobId/assign')
  @HttpCode(200)
  @RequirePermission('delivery:dispatch')
  assign(@Tenant() ctx: TenantContext, @Param('jobId', ParseUUIDPipe) jobId: string, @Body(zod(assignJob)) body: z.infer<typeof assignJob>, @Headers('idempotency-key') key?: string) {
    return this.delivery.assign(ctx, jobId, body, key);
  }

  @Post('jobs/:jobId/unassign')
  @HttpCode(200)
  @RequirePermission('delivery:dispatch')
  unassign(@Tenant() ctx: TenantContext, @Param('jobId', ParseUUIDPipe) jobId: string) {
    return this.delivery.unassign(ctx, jobId);
  }

  @Post('jobs/:jobId/cancel')
  @HttpCode(200)
  @RequirePermission('delivery:dispatch')
  cancel(@Tenant() ctx: TenantContext, @Param('jobId', ParseUUIDPipe) jobId: string, @Body(zod(cancelJob)) body: z.infer<typeof cancelJob>) {
    return this.delivery.cancel(ctx, jobId, body.reason);
  }

  @Post('jobs/:jobId/otp')
  @HttpCode(200)
  @RequirePermission('delivery:dispatch')
  otp(@Tenant() ctx: TenantContext, @Param('jobId', ParseUUIDPipe) jobId: string) {
    return this.delivery.issueOtp(ctx, jobId);
  }

  @Get('drivers')
  @RequirePermission('delivery:dispatch')
  drivers(@Tenant() ctx: TenantContext, @Query(zod(driversQuery)) q: z.infer<typeof driversQuery>) {
    return this.delivery.listDrivers(ctx, { includeSuspended: q.includeSuspended === 'true' });
  }

  @Get('drivers/:driverId')
  @RequirePermission('delivery:dispatch')
  driver(@Tenant() ctx: TenantContext, @Param('driverId', ParseUUIDPipe) driverId: string) {
    return this.delivery.driverProfile(ctx, driverId);
  }

  @Patch('drivers/:driverId')
  @RequirePermission('delivery:dispatch')
  updateDriver(@Tenant() ctx: TenantContext, @Param('driverId', ParseUUIDPipe) driverId: string, @Body(zod(driverUpdate)) body: z.infer<typeof driverUpdate>) {
    return this.delivery.updateDriver(ctx, driverId, body);
  }

  @Get('settlements')
  @RequirePermission('delivery:dispatch')
  settlements(@Tenant() ctx: TenantContext, @Query('driverId', new ParseUUIDPipe({ optional: true })) driverId?: string) {
    return this.delivery.listSettlements(ctx, driverId);
  }

  @Post('settlements')
  @RequirePermission('delivery:dispatch')
  settle(@Tenant() ctx: TenantContext, @Body(zod(settlementInput)) body: z.infer<typeof settlementInput>, @Headers('idempotency-key') key?: string) {
    return this.delivery.settle(ctx, body, key);
  }
}

/** Driver app API (role driver: delivery:drive). Platform-independent: bearer JWT, no cookies. */
@Controller('o/:orgId/driver')
@RequiresModule('driver')
export class DriverController {
  constructor(private readonly app: DriverAppService, private readonly push: DriverPushService) {}

  /** FT-22: whether Web Push is available (VAPID public key) and this device is subscribed. */
  @Get('me/push')
  @RequirePermission('delivery:drive')
  pushConfig(@Tenant() ctx: TenantContext, @Query(zod(pushConfigQuery)) q: z.infer<typeof pushConfigQuery>) {
    return this.push.config(ctx, q.deviceId || null);
  }

  @Post('me/push')
  @RequirePermission('delivery:drive')
  pushSubscribe(@Tenant() ctx: TenantContext, @Body(zod(pushSubscribe)) body: z.infer<typeof pushSubscribe>) {
    return this.push.subscribe(ctx, body);
  }

  @Delete('me/push/:deviceId')
  @RequirePermission('delivery:drive')
  pushUnsubscribe(@Tenant() ctx: TenantContext, @Param('deviceId') deviceId: string) {
    return this.push.unsubscribe(ctx, deviceIdSchema.parse(deviceId));
  }

  @Post('me/push/:deviceId/test')
  @RequirePermission('delivery:drive')
  pushTest(@Tenant() ctx: TenantContext, @Param('deviceId') deviceId: string) {
    return this.push.test(ctx, deviceIdSchema.parse(deviceId));
  }

  @Get('me')
  @RequirePermission('delivery:drive')
  me(@Tenant() ctx: TenantContext) {
    return this.app.profile(ctx);
  }

  @Patch('me/availability')
  @RequirePermission('delivery:drive')
  availability(@Tenant() ctx: TenantContext, @Body(zod(availabilityInput)) body: z.infer<typeof availabilityInput>) {
    return this.app.setAvailability(ctx, body.availability);
  }

  @Post('me/devices')
  @RequirePermission('delivery:drive')
  registerDevice(@Tenant() ctx: TenantContext, @Body(zod(deviceRegistration)) body: z.infer<typeof deviceRegistration>) {
    return this.app.registerDevice(ctx, body);
  }

  @Delete('me/devices/:deviceId')
  @RequirePermission('delivery:drive')
  removeDevice(@Tenant() ctx: TenantContext, @Param('deviceId') deviceId: string) {
    return this.app.removeDevice(ctx, z.string().min(8).max(200).parse(deviceId));
  }

  @Post('me/locations')
  @HttpCode(202)
  @RequirePermission('delivery:drive')
  locations(@Tenant() ctx: TenantContext, @Body(zod(locationBatch)) body: z.infer<typeof locationBatch>) {
    return this.app.ingestLocations(ctx, body);
  }

  @Get('me/cash')
  @RequirePermission('delivery:drive')
  cash(@Tenant() ctx: TenantContext) {
    return this.app.cashSummary(ctx);
  }

  @Get('jobs')
  @RequirePermission('delivery:drive')
  jobs(@Tenant() ctx: TenantContext) {
    return this.app.myJobs(ctx);
  }

  @Get('history')
  @RequirePermission('delivery:drive')
  history(@Tenant() ctx: TenantContext, @Query(zod(historyQuery)) q: z.infer<typeof historyQuery>) {
    return this.app.history(ctx, q);
  }

  @Get('jobs/:jobId')
  @RequirePermission('delivery:drive')
  job(@Tenant() ctx: TenantContext, @Param('jobId', ParseUUIDPipe) jobId: string) {
    return this.app.job(ctx, jobId);
  }

  @Post('jobs/:jobId/accept')
  @HttpCode(200)
  @RequirePermission('delivery:drive')
  accept(@Tenant() ctx: TenantContext, @Param('jobId', ParseUUIDPipe) jobId: string, @Body(zod(optionalBody(driverAction))) body: z.infer<typeof driverAction>) {
    return this.app.accept(ctx, jobId, body);
  }

  @Post('jobs/:jobId/decline')
  @HttpCode(200)
  @RequirePermission('delivery:drive')
  decline(@Tenant() ctx: TenantContext, @Param('jobId', ParseUUIDPipe) jobId: string, @Body(zod(optionalBody(declineJob))) body: z.infer<typeof declineJob>) {
    return this.app.decline(ctx, jobId, body.reason, body);
  }

  @Post('jobs/:jobId/pickup')
  @HttpCode(200)
  @RequirePermission('delivery:drive')
  pickup(@Tenant() ctx: TenantContext, @Param('jobId', ParseUUIDPipe) jobId: string, @Body(zod(optionalBody(driverAction))) body: z.infer<typeof driverAction>) {
    return this.app.pickup(ctx, jobId, body);
  }

  @Post('jobs/:jobId/en-route')
  @HttpCode(200)
  @RequirePermission('delivery:drive')
  enRoute(@Tenant() ctx: TenantContext, @Param('jobId', ParseUUIDPipe) jobId: string, @Body(zod(optionalBody(driverAction))) body: z.infer<typeof driverAction>) {
    return this.app.enRoute(ctx, jobId, body);
  }

  @Post('jobs/:jobId/proof-photo')
  @RequirePermission('delivery:drive')
  @UseInterceptors(uploadLimits)
  proof(@Tenant() ctx: TenantContext, @Param('jobId', ParseUUIDPipe) jobId: string, @UploadedFile() file: Upload) {
    return this.app.uploadProof(ctx, jobId, file);
  }

  @Post('jobs/:jobId/deliver')
  @HttpCode(200)
  @RequirePermission('delivery:drive')
  deliver(@Tenant() ctx: TenantContext, @Param('jobId', ParseUUIDPipe) jobId: string, @Body(zod(deliverJob)) body: z.infer<typeof deliverJob>, @Headers('idempotency-key') key?: string) {
    return this.app.deliver(ctx, jobId, body, key);
  }

  @Post('jobs/:jobId/fail')
  @HttpCode(200)
  @RequirePermission('delivery:drive')
  fail(@Tenant() ctx: TenantContext, @Param('jobId', ParseUUIDPipe) jobId: string, @Body(zod(failJob)) body: z.infer<typeof failJob>) {
    return this.app.fail(ctx, jobId, body);
  }
}
