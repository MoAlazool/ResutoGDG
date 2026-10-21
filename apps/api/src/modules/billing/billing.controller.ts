import { Body, Controller, Get, HttpCode, Post, Query, Req } from '@nestjs/common';
import {
  cancelSubscription, changePlan, costsQuery, priceQuoteRequest, publicPlansQuery,
  type ChangePlan, type CostsView, type EntitlementsView, type PriceQuote, type PriceQuoteRequest, type PublicPlansResponse,
} from '@resuto/contracts';
import { z } from 'zod';
import type { ResutoRequest, TenantContext } from '../../common/auth/context';
import { Public, RequirePermission, Tenant } from '../../common/auth/decorators';
import { DbService } from '../../common/db/db.service';
import { RateLimiter } from '../../common/http/rate-limiter';
import { zod } from '../../common/http/zod.pipe';
import { CatalogService } from './catalog.service';
import { CostsService } from './costs.service';
import { EntitlementsViewService } from './entitlements-view.service';
import { SubscriptionsService } from './subscriptions.service';

const ip = (req: ResutoRequest) => req.ip ?? 'unknown';

/** Public pricing (landing /pricing page, Build Your Resuto calculator). Reference data only. */
@Controller('public')
export class BillingPublicController {
  constructor(private readonly db: DbService, private readonly catalog: CatalogService, private readonly limiter: RateLimiter) {}

  @Public()
  @Get('plans')
  plans(@Req() req: ResutoRequest, @Query(zod(publicPlansQuery)) q: z.infer<typeof publicPlansQuery>): Promise<PublicPlansResponse> {
    this.limiter.hit(`plans:${ip(req)}`, 120);
    return this.db.withPlatform((tx) => this.catalog.publicPlans(tx, q.country, q.interval));
  }

  @Public()
  @Post('pricing/quote')
  @HttpCode(200)
  quote(@Req() req: ResutoRequest, @Body(zod(priceQuoteRequest)) body: PriceQuoteRequest): Promise<PriceQuote> {
    this.limiter.hit(`quote:${ip(req)}`, 120);
    return this.db.withPlatform((tx) => this.catalog.quote(tx, body, { publicOnly: true }));
  }
}

@Controller('o/:orgId/billing')
export class BillingController {
  constructor(private readonly db: DbService, private readonly view: EntitlementsViewService, private readonly subs: SubscriptionsService, private readonly costs: CostsService) {}

  /** Any member: what is enabled and why, limits and current-period usage. */
  @Get('entitlements')
  entitlements(@Tenant() ctx: TenantContext): Promise<EntitlementsView> {
    return this.db.scoped(ctx, (tx) => this.view.view(tx, ctx.orgId));
  }

  @Get('subscription')
  @RequirePermission('billing:manage')
  subscription(@Tenant() ctx: TenantContext) {
    return this.db.scoped(ctx, (tx) => this.subs.view(tx, ctx.orgId));
  }

  /** FT-19: Resuto's own fees (platform invoices) next to the costs paid directly to other providers, by month. */
  @Get('costs')
  @RequirePermission('billing:manage')
  costsView(@Tenant() ctx: TenantContext, @Query(zod(costsQuery)) q: z.infer<typeof costsQuery>): Promise<CostsView> {
    return this.db.scoped(ctx, (tx) => this.costs.view(tx, ctx.orgId, q.months));
  }

  @Post('change-plan')
  @HttpCode(200)
  @RequirePermission('billing:manage')
  change(@Tenant() ctx: TenantContext, @Body(zod(changePlan)) body: ChangePlan) {
    return this.subs.changePlan(ctx, body);
  }

  @Post('cancel')
  @HttpCode(200)
  @RequirePermission('billing:manage')
  cancel(@Tenant() ctx: TenantContext, @Body(zod(cancelSubscription)) body: z.infer<typeof cancelSubscription>) {
    return this.subs.cancel(ctx, body.reason);
  }

  @Post('resume')
  @HttpCode(200)
  @RequirePermission('billing:manage')
  resume(@Tenant() ctx: TenantContext) {
    return this.subs.resume(ctx);
  }
}
