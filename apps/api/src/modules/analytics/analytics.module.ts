import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { AnalyticsRollupJobs } from './analytics-rollups.jobs';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

/** analytics module. Owner: Agent B2 (docs/architecture/MODULE_CONTRACTS.md). */
@Module({
  imports: [InventoryModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService, AnalyticsRollupJobs],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
