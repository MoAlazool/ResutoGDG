import { Module } from '@nestjs/common';
import { GuestController, WebOrderController } from './guest.controller';
import { GuestService } from './guest.service';

/** guest module. Owner: Agent B1 (docs/architecture/MODULE_CONTRACTS.md). Public QR table and website ordering. */
@Module({
  controllers: [GuestController, WebOrderController],
  providers: [GuestService],
  exports: [GuestService],
})
export class GuestModule {}
