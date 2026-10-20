import { Global, Module } from '@nestjs/common';
import { MESSAGING_PORT } from '../kernel/ports';
import { IntegrationsModule } from '../integrations/integrations.module';
import { ChannelsService } from './channels.service';
import { ConnectEventsService } from './connect-events.service';
import { ConnectController } from './connect.controller';
import { ConversationsService } from './conversations.service';
import { HandoffService } from './handoff.service';
import { MessagingService } from './messaging.service';
import { OrderingService } from './ordering.service';
import { PublicOrderingController } from './public-ordering.controller';
import { WhatsAppWebhookController } from './webhook.controller';
import { WhatsAppSignupService } from './whatsapp-signup.service';
import { WhatsAppWebhookService } from './whatsapp-webhook.service';

/**
 * connect module. Owner: Agent C (docs/architecture/MODULE_CONTRACTS.md).
 * Channels (sandbox + WhatsApp Cloud API), webhook ingestion, unified inbox,
 * structured ordering sessions, templates, handoff and the outbound queue.
 * Global so MESSAGING_PORT reaches every module.
 */
@Global()
@Module({
  imports: [IntegrationsModule],
  controllers: [ConnectController, PublicOrderingController, WhatsAppWebhookController],
  providers: [
    MessagingService, HandoffService, OrderingService, ConversationsService, ChannelsService, WhatsAppWebhookService, WhatsAppSignupService, ConnectEventsService,
    { provide: MESSAGING_PORT, useExisting: MessagingService },
  ],
  exports: [MESSAGING_PORT, MessagingService],
})
export class ConnectModule {}
