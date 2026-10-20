import { Module } from '@nestjs/common';
import { GuestController, WebOrderController } from './guest.controller';
import { GuestAssistantService } from './assistant.service';
import { GuestService } from './guest.service';
import { TokenGuessGuard } from './token-guess-guard';
import { GuestRatingsService } from './ratings.service';

/** guest module. Owner: Agent B1 (docs/architecture/MODULE_CONTRACTS.md). Public QR table and website ordering. */
@Module({
  controllers: [GuestController, WebOrderController],
  providers: [GuestService, GuestAssistantService, GuestRatingsService, TokenGuessGuard],
  exports: [GuestService],
})
export class GuestModule {}
