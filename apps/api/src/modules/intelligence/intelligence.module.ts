import { Module } from '@nestjs/common';
import { AiServiceClient } from './ai-client.service';
import { AssistantService } from './assistant.service';
import { CopyService } from './copy.service';
import { IntelligenceDataService } from './data.service';
import { GeminiClient } from './gemini.client';
import { InsightsService } from './insights.service';
import { IntelligenceController } from './intelligence.controller';
import { IntelligenceService } from './intelligence.service';
import { ModelRegistryService } from './registry.service';

/**
 * Resuto Intelligence (Agent E1, docs/architecture/MODULE_CONTRACTS.md): native forecasting,
 * customer intelligence, recommendations, route planning, insights, owner assistant and copy
 * generation. Models run in the stateless Python service (apps/ai-service); this module extracts
 * tenant data, calls it, and stores predictions/insights. Exported services are for MCP (E2).
 */
@Module({
  controllers: [IntelligenceController],
  providers: [AiServiceClient, GeminiClient, IntelligenceDataService, IntelligenceService, InsightsService, AssistantService, CopyService, ModelRegistryService],
  exports: [IntelligenceService, InsightsService, AssistantService],
})
export class IntelligenceModule {}
