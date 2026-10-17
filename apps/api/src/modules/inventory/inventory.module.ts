import { Module } from '@nestjs/common';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { StockAlertsService } from './stock-alerts.service';

/** inventory module. Owner: Agent B2 (docs/architecture/MODULE_CONTRACTS.md). */
@Module({
  controllers: [InventoryController],
  providers: [InventoryService, StockAlertsService],
  exports: [InventoryService, StockAlertsService],
})
export class InventoryModule {}
