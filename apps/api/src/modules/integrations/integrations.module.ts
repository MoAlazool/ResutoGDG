import { Module } from '@nestjs/common';
import { IntegrationConnectionsService } from './connections.service';
import { IntegrationsController } from './integrations.controller';
import { IntegrationOAuthService } from './oauth.service';
import { PosWebhooksService } from './pos-webhooks.service';
import { ProviderAppsController } from './provider-apps.controller';
import { PlatformProviderAppsService } from './provider-apps.service';
import { ProviderHttp } from './provider-http';
import { IntegrationSyncService } from './sync.service';

/**
 * integrations module. Owner: Agent C (docs/architecture/MODULE_CONTRACTS.md).
 * Provider catalogue, per-tenant connections with sealed credentials, health,
 * sync runs/cursors/conflicts/logs and OAuth. Connect and Marketing import it
 * to load credentials for their adapters. 21-INT: the operator console for Resuto's own provider apps
 * (/v1/admin/providers, platform staff only), which replaces the provider app environment variables when set.
 */
@Module({
  controllers: [IntegrationsController, ProviderAppsController],
  providers: [ProviderHttp, IntegrationConnectionsService, IntegrationSyncService, IntegrationOAuthService, PosWebhooksService, PlatformProviderAppsService],
  exports: [ProviderHttp, IntegrationConnectionsService, PlatformProviderAppsService],
})
export class IntegrationsModule {}
