import { Global, Module } from '@nestjs/common';
import { CAMPAIGNS_PORT, SEGMENTS_PORT } from '../kernel/ports';
import { IntegrationsModule } from '../integrations/integrations.module';
import { CampaignsService } from './campaigns.service';
import { TrackingLinksService } from './links.service';
import { MarketingEventsService } from './marketing-events.service';
import { MarketingController, PublicLinksController, PublicTrackingController } from './marketing.controller';
import { MetaTrackingService } from './meta-tracking.service';
import { PromotionsService } from './promotions.service';
import { RecommendationsService } from './recommendations.service';
import { SegmentsService } from './segments.service';

/** Same identity as CAMPAIGN_SEND_PORT in the lead's kernel/ports.ts (Symbol.for registry). */
export const CAMPAIGN_SEND_PORT = Symbol.for('resuto.CAMPAIGN_SEND_PORT');

/**
 * marketing module. Owner: Agent C (docs/architecture/MODULE_CONTRACTS.md).
 * Segments (rule DSL), promotions, campaigns with approval, ads adapters,
 * tracking links and last-touch attribution. Global for SEGMENTS_PORT,
 * CAMPAIGNS_PORT and CAMPAIGN_SEND_PORT; MessagingService comes from the global Connect module.
 */
@Global()
@Module({
  imports: [IntegrationsModule],
  controllers: [MarketingController, PublicLinksController, PublicTrackingController],
  providers: [
    SegmentsService, PromotionsService, CampaignsService, TrackingLinksService, RecommendationsService, MarketingEventsService, MetaTrackingService,
    { provide: SEGMENTS_PORT, useExisting: SegmentsService },
    { provide: CAMPAIGNS_PORT, useExisting: CampaignsService },
    { provide: CAMPAIGN_SEND_PORT, useExisting: CampaignsService },
  ],
  // PromotionsService: change sets create offers in their own transaction (21-CS).
  exports: [SEGMENTS_PORT, CAMPAIGNS_PORT, CAMPAIGN_SEND_PORT, PromotionsService],
})
export class MarketingModule {}
