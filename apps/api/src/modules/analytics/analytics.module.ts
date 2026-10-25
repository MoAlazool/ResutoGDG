import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { AnalyticsRollupJobs } from './analytics-rollups.jobs';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

/** analytics module. Owner: Agent B2 (docs/architecture/MODULE_CONTRACTS.md). Saved Insights reports: 21-INSIGHTS. */
@Module({
  imports: [InventoryModule],
  controllers: [AnalyticsController, ReportsController],
  providers: [AnalyticsService, AnalyticsRollupJobs, ReportsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
