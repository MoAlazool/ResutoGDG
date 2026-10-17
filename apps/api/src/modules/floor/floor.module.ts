import { Module } from '@nestjs/common';
import { FloorController, PublicFloorController } from './floor.controller';
import { FloorService } from './floor.service';

/** floor module. Owner: Agent B1 (docs/architecture/MODULE_CONTRACTS.md). */
@Module({
  controllers: [FloorController, PublicFloorController],
  providers: [FloorService],
  exports: [FloorService],
})
export class FloorModule {}
