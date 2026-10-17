import { Global, Module } from '@nestjs/common';
import { BillingController, BillingPublicController } from './billing.controller';
import { CatalogService } from './catalog.service';
import { EntitlementsViewService } from './entitlements-view.service';
import { BillingLifecycleService } from './lifecycle.service';
import { PlanLimitsService } from './plan-limits.service';
import { SubscriptionsService } from './subscriptions.service';
import { UsageService } from './usage.service';

/**
 * billing module. Owner: Agent A (docs/architecture/MODULE_CONTRACTS.md).
 * Global so the kernel (PlanLimitsService.assertCanPlaceOrder) and E1/E2
 * (UsageService.record for ai_requests / mcp_calls) can inject the exports.
 */
@Global()
@Module({
  controllers: [BillingPublicController, BillingController],
  providers: [CatalogService, UsageService, PlanLimitsService, EntitlementsViewService, SubscriptionsService, BillingLifecycleService],
  exports: [CatalogService, UsageService, PlanLimitsService, EntitlementsViewService, SubscriptionsService],
})
export class BillingModule {}
