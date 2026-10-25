import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { AnalyticsRollupJobs } from './analytics-rollups.jobs';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { FunnelBeaconBodyMiddleware, FunnelBeaconService, PublicFunnelController } from './funnel-beacon';
import { FunnelsService } from './funnels.service';

/** analytics module. Owner: Agent B2 (docs/architecture/MODULE_CONTRACTS.md). 21-CRM adds the funnel reports and beacons. */
@Module({
  imports: [InventoryModule],
  controllers: [AnalyticsController, PublicFunnelController],
  providers: [AnalyticsService, AnalyticsRollupJobs, FunnelsService, FunnelBeaconService],
  exports: [AnalyticsService],
})
export class AnalyticsModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(FunnelBeaconBodyMiddleware).forRoutes(PublicFunnelController);
  }
}
