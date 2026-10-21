import { Module } from '@nestjs/common';
import { FloorController, PublicFloorController } from './floor.controller';
import { FloorService } from './floor.service';
import { PublicVenueController } from './venue.controller';

/** floor module. Owner: Agent B1 (docs/architecture/MODULE_CONTRACTS.md). */
@Module({
  controllers: [FloorController, PublicFloorController, PublicVenueController],
  providers: [FloorService],
  exports: [FloorService],
})
export class FloorModule {}
