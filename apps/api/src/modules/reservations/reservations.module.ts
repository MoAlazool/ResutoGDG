import { Module } from '@nestjs/common';
import { PublicReservationsController, ReservationsController } from './reservations.controller';
import { ReservationsService } from './reservations.service';

/** reservations module. Owner: Agent B1 (docs/architecture/MODULE_CONTRACTS.md). */
@Module({
  controllers: [ReservationsController, PublicReservationsController],
  providers: [ReservationsService],
  exports: [ReservationsService],
})
export class ReservationsModule {}
