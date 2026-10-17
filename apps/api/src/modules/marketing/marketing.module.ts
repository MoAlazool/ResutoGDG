import { Global, Module } from '@nestjs/common';
import { CAMPAIGNS_PORT, SEGMENTS_PORT } from '../kernel/ports';
import { IntegrationsModule } from '../integrations/integrations.module';
import { CampaignsService } from './campaigns.service';
import { TrackingLinksService } from './links.service';
import { MarketingEventsService } from './marketing-events.service';
import { MarketingController, PublicLinksController } from './marketing.controller';
import { PromotionsService } from './promotions.service';
import { RecommendationsService } from './recommendations.service';
import { SegmentsService } from './segments.service';

/**
 * marketing module. Owner: Agent C (docs/architecture/MODULE_CONTRACTS.md).
 * Segments (rule DSL), promotions, campaigns with approval, ads adapters,
 * tracking links and last-touch attribution. Global for SEGMENTS_PORT and
 * CAMPAIGNS_PORT; MessagingService comes from the global Connect module.
 */
@Global()
@Module({
  imports: [IntegrationsModule],
  controllers: [MarketingController, PublicLinksController],
  providers: [
    SegmentsService, PromotionsService, CampaignsService, TrackingLinksService, RecommendationsService, MarketingEventsService,
    { provide: SEGMENTS_PORT, useExisting: SegmentsService },
    { provide: CAMPAIGNS_PORT, useExisting: CampaignsService },
  ],
  exports: [SEGMENTS_PORT, CAMPAIGNS_PORT],
})
export class MarketingModule {}
