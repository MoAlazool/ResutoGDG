import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { analyticsPeriodQuery, paperIndicatorQuery, roiInput, uuid } from '@resuto/contracts';
import { z } from 'zod';
import type { TenantContext } from '../../common/auth/context';
import { RequirePermission, Tenant } from '../../common/auth/decorators';
import { DbService } from '../../common/db/db.service';
import { zod } from '../../common/http/zod.pipe';
import { AnalyticsService } from './analytics.service';
import { ratingsSummary } from './ratings';

const overviewQuery = z.object({ branchId: uuid.optional() });
type Period = z.infer<typeof analyticsPeriodQuery>;

/** Read-only analytics. Every response carries `meta { method, assumptions, dataCoverage, kind }`. */
@Controller('o/:orgId/analytics')
export class AnalyticsController {
  constructor(private readonly db: DbService, private readonly analytics: AnalyticsService) {}

  @Get('overview')
  @RequirePermission('analytics:read')
  overview(@Tenant() ctx: TenantContext, @Query(zod(overviewQuery)) q: z.infer<typeof overviewQuery>) {
    return this.db.scoped(ctx, (tx) => this.analytics.overview(tx, ctx, q.branchId));
  }

  @Get('summary')
  @RequirePermission('analytics:read')
  summary(@Tenant() ctx: TenantContext, @Query(zod(analyticsPeriodQuery)) q: Period) {
    return this.db.scoped(ctx, (tx) => this.analytics.summary(tx, ctx, q));
  }

  @Get('products')
  @RequirePermission('analytics:read')
  products(@Tenant() ctx: TenantContext, @Query(zod(analyticsPeriodQuery)) q: Period) {
    return this.db.scoped(ctx, (tx) => this.analytics.products(tx, ctx, q));
  }

  @Get('customers')
  @RequirePermission('analytics:read')
  customers(@Tenant() ctx: TenantContext, @Query(zod(analyticsPeriodQuery)) q: Period) {
    return this.db.scoped(ctx, (tx) => this.analytics.customers(tx, ctx, q));
  }

  @Get('marketing')
  @RequirePermission('analytics:read')
  marketing(@Tenant() ctx: TenantContext, @Query(zod(analyticsPeriodQuery)) q: Period) {
    return this.db.scoped(ctx, (tx) => this.analytics.marketing(tx, ctx, q));
  }

  @Get('operations')
  @RequirePermission('analytics:read')
  operations(@Tenant() ctx: TenantContext, @Query(zod(analyticsPeriodQuery)) q: Period) {
    return this.db.scoped(ctx, (tx) => this.analytics.operations(tx, ctx, q));
  }

  /** Guest satisfaction: ratings left after payment (VS-27). */
  @Get('ratings')
  @RequirePermission('analytics:read')
  ratings(@Tenant() ctx: TenantContext, @Query(zod(analyticsPeriodQuery)) q: Period) {
    return this.db.scoped(ctx, (tx) => ratingsSummary(tx, ctx, q));
  }

  @Get('sustainability')
  @RequirePermission('analytics:read')
  sustainability(@Tenant() ctx: TenantContext, @Query(zod(paperIndicatorQuery)) q: z.infer<typeof paperIndicatorQuery>) {
    return this.db.scoped(ctx, (tx) => this.analytics.sustainability(tx, ctx, q));
  }

  /** Hypothetical ROI scenario from explicit assumptions. Read-only (nothing is stored). */
  @Post('roi')
  @HttpCode(200)
  @RequirePermission('analytics:read')
  roi(@Tenant() ctx: TenantContext, @Body(zod(roiInput)) body: z.infer<typeof roiInput>) {
    return this.db.scoped(ctx, (tx) => this.analytics.roi(tx, ctx, body));
  }
}
