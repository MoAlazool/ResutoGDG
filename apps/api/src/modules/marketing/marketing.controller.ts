import { Body, Controller, Delete, Get, Header, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import {
  adInsightsSync, CAMPAIGN_STATUSES, fullListQuery, listQuery, campaignInput, campaignUpdate, launchCampaign, promotionInput, promotionUpdate, rejectCampaign, resetCampaignLaunch, scheduleCampaign, segmentInput,
  metaTrackingContext, segmentPreview, segmentUpdate, trackingLinkInput,
} from '@resuto/contracts';
import type { Request } from 'express';
import { z } from 'zod';
import type { TenantContext } from '../../common/auth/context';
import { Public, RequiresModule, RequirePermission, Tenant } from '../../common/auth/decorators';
import { RateLimiter } from '../../common/http/rate-limiter';
import { zod } from '../../common/http/zod.pipe';
import { ENV, type Env } from '../../config/env';
import { CampaignsService } from './campaigns.service';
import { TrackingLinksService } from './links.service';
import { MetaTrackingService } from './meta-tracking.service';
import { PromotionsService } from './promotions.service';
import { RecommendationsService } from './recommendations.service';
import { SegmentsService } from './segments.service';

const TRACKING_SINK = z.enum(['meta_capi', 'tiktok_events', 'snap_capi']);

const campaignListQuery = fullListQuery.extend({ status: z.enum(CAMPAIGN_STATUSES).optional() });
const linkListQuery = fullListQuery.extend({ campaignId: z.uuid().optional() });

@Controller('o/:orgId/marketing')
@RequiresModule('marketing')
export class MarketingController {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly segments: SegmentsService,
    private readonly promotions: PromotionsService,
    private readonly campaigns: CampaignsService,
    private readonly links: TrackingLinksService,
    private readonly recommendations: RecommendationsService,
    private readonly tracking: MetaTrackingService,
  ) {}

  // Segments -------------------------------------------------------------------
  @Get('segments')
  @RequirePermission('marketing:read')
  @Header('X-Resuto-List', 'full')
  listSegments(@Tenant() ctx: TenantContext, @Query(zod(fullListQuery)) q: z.infer<typeof fullListQuery>) { return this.segments.list(ctx, q); }

  @HttpCode(200)
  @Post('segments/preview')
  @RequirePermission('marketing:read')
  preview(@Tenant() ctx: TenantContext, @Body(zod(segmentPreview)) body: z.infer<typeof segmentPreview>) { return this.segments.preview(ctx, body.definition); }

  @Post('segments')
  @RequirePermission('marketing:write')
  createSegment(@Tenant() ctx: TenantContext, @Body(zod(segmentInput)) body: z.infer<typeof segmentInput>) { return this.segments.createFromApi(ctx, body); }

  @Get('segments/:id')
  @RequirePermission('marketing:read')
  getSegment(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) { return this.segments.get(ctx, id); }

  @Patch('segments/:id')
  @RequirePermission('marketing:write')
  updateSegment(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body(zod(segmentUpdate)) body: z.infer<typeof segmentUpdate>) {
    return this.segments.update(ctx, id, body);
  }

  @Post('segments/:id/refresh')
  @RequirePermission('marketing:write')
  refresh(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) { return this.segments.refresh(ctx, id); }

  @Get('segments/:id/members')
  @RequirePermission('customers:read')
  members(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Query(zod(listQuery)) q: z.infer<typeof listQuery>) {
    return this.segments.members(ctx, id, q);
  }

  @Delete('segments/:id')
  @RequirePermission('marketing:write')
  deleteSegment(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) { return this.segments.remove(ctx, id); }

  // Promotions -----------------------------------------------------------------
  @Get('promotions')
  @RequirePermission('marketing:read')
  @Header('X-Resuto-List', 'full')
  listPromotions(@Tenant() ctx: TenantContext, @Query(zod(fullListQuery)) q: z.infer<typeof fullListQuery>) { return this.promotions.list(ctx, q); }

  @Post('promotions')
  @RequirePermission('marketing:write')
  createPromotion(@Tenant() ctx: TenantContext, @Body(zod(promotionInput)) body: z.infer<typeof promotionInput>) { return this.promotions.create(ctx, body); }

  @Patch('promotions/:id')
  @RequirePermission('marketing:write')
  updatePromotion(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body(zod(promotionUpdate)) body: z.infer<typeof promotionUpdate>) {
    return this.promotions.update(ctx, id, body);
  }

  @Delete('promotions/:id')
  @RequirePermission('marketing:write')
  deletePromotion(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) { return this.promotions.remove(ctx, id); }

  // Campaigns ------------------------------------------------------------------
  @Get('campaigns')
  @RequirePermission('marketing:read')
  @Header('X-Resuto-List', 'full')
  listCampaigns(@Tenant() ctx: TenantContext, @Query(zod(campaignListQuery)) q: z.infer<typeof campaignListQuery>) {
    return this.campaigns.list(ctx, q);
  }

  @Post('campaigns')
  @RequirePermission('marketing:write')
  createCampaign(@Tenant() ctx: TenantContext, @Body(zod(campaignInput)) body: z.infer<typeof campaignInput>) { return this.campaigns.create(ctx, body); }

  @Get('campaigns/:id')
  @RequirePermission('marketing:read')
  getCampaign(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) { return this.campaigns.get(ctx, id); }

  @Patch('campaigns/:id')
  @RequirePermission('marketing:write')
  updateCampaign(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body(zod(campaignUpdate)) body: z.infer<typeof campaignUpdate>) {
    return this.campaigns.update(ctx, id, body);
  }

  @Post('campaigns/:id/submit')
  @RequirePermission('marketing:write')
  submit(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) { return this.campaigns.submit(ctx, id); }

  @Post('campaigns/:id/approve')
  @RequirePermission('marketing:approve')
  approve(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) { return this.campaigns.approve(ctx, id); }

  @Post('campaigns/:id/reject')
  @RequirePermission('marketing:approve')
  reject(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body(zod(rejectCampaign)) body: z.infer<typeof rejectCampaign>) {
    return this.campaigns.reject(ctx, id, body.reason);
  }

  @Post('campaigns/:id/schedule')
  @RequirePermission('marketing:write')
  schedule(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body(zod(scheduleCampaign)) body: z.infer<typeof scheduleCampaign>) {
    return this.campaigns.schedule(ctx, id, body.scheduledAt);
  }

  @Post('campaigns/:id/send')
  @RequirePermission('marketing:write')
  send(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Headers('idempotency-key') key?: string) { return this.campaigns.sendNow(ctx, id, key); }

  @Post('campaigns/:id/cancel')
  @RequirePermission('marketing:write')
  cancel(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) { return this.campaigns.cancel(ctx, id); }

  @Post('campaigns/:id/launch')
  @RequirePermission('marketing:write')
  launch(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body(zod(launchCampaign)) body: z.infer<typeof launchCampaign>,
    @Headers('idempotency-key') key?: string) {
    return this.campaigns.launch(ctx, id, body, key);
  }

  /** PS-14: the owner checked the provider and no campaign carries the launch tag: release the stuck launch. */
  @Post('campaigns/:id/launch/reset')
  @RequirePermission('marketing:approve')
  resetLaunch(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body(zod(resetCampaignLaunch)) _body: z.infer<typeof resetCampaignLaunch>) {
    return this.campaigns.resetLaunch(ctx, id);
  }

  @Post('campaigns/:id/insights/sync')
  @RequirePermission('marketing:write')
  insights(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body(zod(adInsightsSync)) body: z.infer<typeof adInsightsSync>) {
    return this.campaigns.syncInsights(ctx, id, body);
  }

  @Get('campaigns/:id/report')
  @RequirePermission('marketing:read')
  report(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) { return this.campaigns.report(ctx, id); }

  @Get('campaigns/:id/deliveries')
  @RequirePermission('marketing:read')
  @Header('X-Resuto-List', 'full')
  deliveries(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Query(zod(fullListQuery)) q: z.infer<typeof fullListQuery>) {
    return this.campaigns.deliveries(ctx, id, q);
  }

  // Tracking links -------------------------------------------------------------
  @Get('links')
  @RequirePermission('marketing:read')
  @Header('X-Resuto-List', 'full')
  listLinks(@Tenant() ctx: TenantContext, @Query(zod(linkListQuery)) q: z.infer<typeof linkListQuery>) {
    return this.links.list(ctx, this.env.APP_ORIGIN, q);
  }

  @Post('links')
  @RequirePermission('marketing:write')
  createLink(@Tenant() ctx: TenantContext, @Body(zod(trackingLinkInput)) body: z.infer<typeof trackingLinkInput>) { return this.links.create(ctx, this.env.APP_ORIGIN, body); }

  // Recommendations ------------------------------------------------------------
  @Get('recommendations')
  @RequirePermission('marketing:read')
  listRecommendations(@Tenant() ctx: TenantContext) { return this.recommendations.list(ctx); }

  @Post('recommendations/:key/apply')
  @RequirePermission('marketing:write')
  applyRecommendation(@Tenant() ctx: TenantContext, @Param('key') key: string) {
    return this.recommendations.apply(ctx, z.string().regex(/^[a-z0-9_]{1,60}$/).parse(key));
  }

  // Meta Pixel + Conversions API (INT-20) and Custom Audience dry run (INT-22) ---------------------------------
  @Get('tracking/meta')
  @RequirePermission('marketing:read')
  metaTracking(@Tenant() ctx: TenantContext) { return this.tracking.diagnostics(ctx); }

  @Post('tracking/meta/test-event')
  @RequirePermission('marketing:write')
  metaTestEvent(@Tenant() ctx: TenantContext, @Req() req: Request) {
    return this.tracking.sendTestEvent(ctx, typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null);
  }

  // INT-23: the other ad-measurement sinks (TikTok Events API, Snap Conversions API): same diagnostics and test button.
  @Get('tracking/sinks/:provider')
  @RequirePermission('marketing:read')
  sinkTracking(@Tenant() ctx: TenantContext, @Param('provider') provider: string) { return this.tracking.diagnosticsFor(ctx, TRACKING_SINK.parse(provider)); }

  @Post('tracking/sinks/:provider/test-event')
  @RequirePermission('marketing:write')
  sinkTestEvent(@Tenant() ctx: TenantContext, @Param('provider') provider: string, @Req() req: Request) {
    return this.tracking.sendTestEvent(ctx, typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null, TRACKING_SINK.parse(provider));
  }

  @Post('segments/:id/meta-audience/dry-run')
  @RequirePermission('marketing:write')
  audienceDryRun(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) { return this.tracking.audienceDryRun(ctx, id); }
}

/** Public tracking-link resolution (web route /l/[code] redirects to `destination`). */
@Controller('public/l')
export class PublicLinksController {
  constructor(private readonly links: TrackingLinksService, private readonly limiter: RateLimiter) {}

  @Get(':code')
  @Public()
  click(@Param('code') code: string, @Req() req: Request) {
    this.limiter.hit(`link:${req.ip}`, 120);
    return this.links.click(code);
  }
}

/** Meta Pixel on the restaurant website (INT-20): config, the consented order context and the browser Purchase decision. */
@Controller('public/tracking/:slug')
export class PublicTrackingController {
  constructor(private readonly tracking: MetaTrackingService, private readonly limiter: RateLimiter) {}

  @Get()
  @Public()
  config(@Param('slug') slug: string, @Req() req: Request) {
    this.limiter.hit(`tracking:cfg:${req.ip}`, 240);
    return this.tracking.publicConfig(slug);
  }

  @Post('orders/:ref/context')
  @Public()
  @HttpCode(200)
  context(@Param('slug') slug: string, @Param('ref') ref: string, @Body(zod(metaTrackingContext)) body: z.infer<typeof metaTrackingContext>, @Req() req: Request) {
    this.limiter.hit(`tracking:ctx:${req.ip}`, 30);
    const ua = req.headers['user-agent'];
    return this.tracking.recordOrderContext(slug, ref, body, { ip: req.ip ?? null, userAgent: typeof ua === 'string' ? ua : null });
  }

  @Get('orders/:ref/purchase')
  @Public()
  purchase(@Param('slug') slug: string, @Param('ref') ref: string, @Req() req: Request) {
    this.limiter.hit(`tracking:pur:${req.ip}`, 120);
    return this.tracking.publicPurchase(slug, ref);
  }
}
