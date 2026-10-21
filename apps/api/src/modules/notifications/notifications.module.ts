import { Global, Module } from '@nestjs/common';
import { EMAIL_PROVIDER, NotConfiguredEmailProvider } from './email.provider';
import { NotificationsController } from './notifications.controller';
import { NotificationsHandlers } from './notifications.handlers';
import { NotificationsService } from './notifications.service';
import { IntegrationsModule } from '../integrations/integrations.module';
import { OutboundController, OutboundPublicController } from './outbound.controller';
import { OutboundChannelsService } from './outbound.service';

/**
 * Staff notifications (FT-06): in-app notification centre fed by domain events, with email behind a provider
 * abstraction that is 'not configured' until an email provider is set up (nothing is reported as sent before).
 * Global so other modules can raise notifications in their own transactions. INT-28: email/SMS through the
 * restaurant's own provider (OutboundChannelsService) for staff email and email/SMS campaigns.
 */
@Global()
@Module({
  imports: [IntegrationsModule],
  controllers: [NotificationsController, OutboundController, OutboundPublicController],
  providers: [NotificationsService, NotificationsHandlers, OutboundChannelsService, { provide: EMAIL_PROVIDER, useClass: NotConfiguredEmailProvider }],
  exports: [NotificationsService, OutboundChannelsService],
})
export class NotificationsModule {}
