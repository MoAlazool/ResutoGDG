import { Global, Module } from '@nestjs/common';
import { MESSAGING_PORT } from '../kernel/ports';
import { IntegrationsModule } from '../integrations/integrations.module';
import { ChannelsService } from './channels.service';
import { ConnectEventsService } from './connect-events.service';
import { ConnectController } from './connect.controller';
import { ConversationsService } from './conversations.service';
import { HandoffService } from './handoff.service';
import { InboxController } from './inbox.controller';
import { InboxService } from './inbox.service';
import { MessagingService } from './messaging.service';
import { OrderingService } from './ordering.service';
import { PublicOrderingController } from './public-ordering.controller';
import { MetaPagesWebhookService } from './meta-pages-webhook.service';
import { MetaPagesWebhookController, WhatsAppWebhookController } from './webhook.controller';
import { WhatsAppOnboardingService } from './whatsapp-onboarding.service';
import { WhatsAppSignupService } from './whatsapp-signup.service';
import { WhatsAppWebhookService } from './whatsapp-webhook.service';

/**
 * connect module. Owner: Agent C (docs/architecture/MODULE_CONTRACTS.md).
 * Channels (sandbox, WhatsApp Cloud API, Messenger / Instagram Direct), webhook ingestion, unified inbox,
 * structured ordering sessions, templates, handoff and the outbound queue; internal notes, conversation tags and
 * saved replies (21-INBOX); the WhatsApp official stepper's test template and inbound check, and staff routing (21-INT).
 * Global so MESSAGING_PORT reaches every module.
 */
@Global()
@Module({
  imports: [IntegrationsModule],
  controllers: [ConnectController, InboxController, PublicOrderingController, WhatsAppWebhookController, MetaPagesWebhookController],
  providers: [
    MessagingService, HandoffService, OrderingService, ConversationsService, ChannelsService, WhatsAppWebhookService, MetaPagesWebhookService, WhatsAppSignupService, ConnectEventsService, InboxService,
    WhatsAppOnboardingService,
    { provide: MESSAGING_PORT, useExisting: MessagingService },
  ],
  exports: [MESSAGING_PORT, MessagingService],
})
export class ConnectModule {}
