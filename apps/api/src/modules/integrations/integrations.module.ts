import { Module } from '@nestjs/common';
import { IntegrationConnectionsService } from './connections.service';
import { IntegrationsController } from './integrations.controller';
import { IntegrationOAuthService } from './oauth.service';
import { PosWebhooksService } from './pos-webhooks.service';
import { ProviderHttp } from './provider-http';
import { IntegrationSyncService } from './sync.service';

/**
 * integrations module. Owner: Agent C (docs/architecture/MODULE_CONTRACTS.md).
 * Provider catalogue, per-tenant connections with sealed credentials, health,
 * sync runs/cursors/conflicts/logs and OAuth. Connect and Marketing import it
 * to load credentials for their adapters.
 */
@Module({
  controllers: [IntegrationsController],
  providers: [ProviderHttp, IntegrationConnectionsService, IntegrationSyncService, IntegrationOAuthService, PosWebhooksService],
  exports: [ProviderHttp, IntegrationConnectionsService],
})
export class IntegrationsModule {}
