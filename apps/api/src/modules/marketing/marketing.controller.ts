import { Body, Controller, Delete, Get, Inject, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import {
  adInsightsSync, CAMPAIGN_STATUSES, campaignInput, campaignUpdate, promotionInput, promotionUpdate, rejectCampaign, scheduleCampaign, segmentInput,
  segmentPreview, segmentUpdate, trackingLinkInput,
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
import { PromotionsService } from './promotions.service';
import { RecommendationsService } from './recommendations.service';
import { SegmentsService } from './segments.service';

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
  ) {}

  // Segments -------------------------------------------------------------------
  @Get('segments')
  @RequirePermission('marketing:read')
  listSegments(@Tenant() ctx: TenantContext) { return this.segments.list(ctx); }

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
  members(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Query('limit') limit?: string) {
    return this.segments.members(ctx, id, Math.min(Math.max(Number(limit) || 50, 1), 200));
  }

  @Delete('segments/:id')
  @RequirePermission('marketing:write')
  deleteSegment(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) { return this.segments.remove(ctx, id); }

  // Promotions -----------------------------------------------------------------
  @Get('promotions')
  @RequirePermission('marketing:read')
  listPromotions(@Tenant() ctx: TenantContext) { return this.promotions.list(ctx); }

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
  listCampaigns(@Tenant() ctx: TenantContext, @Query('status') status?: string) {
    return this.campaigns.list(ctx, status ? z.enum(CAMPAIGN_STATUSES).parse(status) : undefined);
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
  send(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) { return this.campaigns.sendNow(ctx, id); }

  @Post('campaigns/:id/cancel')
  @RequirePermission('marketing:write')
  cancel(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) { return this.campaigns.cancel(ctx, id); }

  @Post('campaigns/:id/launch')
  @RequirePermission('marketing:write')
  launch(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) { return this.campaigns.launch(ctx, id); }

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
  deliveries(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) { return this.campaigns.deliveries(ctx, id); }

  // Tracking links -------------------------------------------------------------
  @Get('links')
  @RequirePermission('marketing:read')
  listLinks(@Tenant() ctx: TenantContext, @Query('campaignId') campaignId?: string) {
    return this.links.list(ctx, this.env.APP_ORIGIN, campaignId ? z.uuid().parse(campaignId) : undefined);
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
