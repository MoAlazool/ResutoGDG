import { Module } from '@nestjs/common';
import { KitchenController } from './kitchen.controller';
import { KitchenService } from './kitchen.service';

/** kitchen module. Owner: Agent B1 (docs/architecture/MODULE_CONTRACTS.md). */
@Module({
  controllers: [KitchenController],
  providers: [KitchenService],
  exports: [KitchenService],
})
export class KitchenModule {}
