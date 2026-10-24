import { Module } from '@nestjs/common';
import { StudioModule } from '../studio/studio.module';
import { ChangePoliciesController, ChangesController } from './changes.controller';
import { ChangesJobs } from './changes.jobs';
import { ChangesService } from './changes.service';
import { ChangeOpRegistry } from './op-registry';

/**
 * Change sets (WS 21-CS, docs/architecture/CHANGE_SETS.md): the typed op registry, the engine (proposal, policy,
 * approval, apply once, the effects outbox) and the approvals inbox API. MenuService, PromotionsService and the
 * CHECKOUT / CAMPAIGN_SEND / MENU_AVAILABILITY ports come from global modules; StudioService from StudioModule.
 */
@Module({
  imports: [StudioModule],
  controllers: [ChangesController, ChangePoliciesController],
  providers: [ChangeOpRegistry, ChangesService, ChangesJobs],
  exports: [ChangesService],
})
export class ChangesModule {}
