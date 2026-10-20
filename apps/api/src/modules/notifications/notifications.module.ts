import { Global, Module } from '@nestjs/common';
import { EMAIL_PROVIDER, NotConfiguredEmailProvider } from './email.provider';
import { NotificationsController } from './notifications.controller';
import { NotificationsHandlers } from './notifications.handlers';
import { NotificationsService } from './notifications.service';

/**
 * Staff notifications (FT-06): in-app notification centre fed by domain events, with email behind a provider
 * abstraction that is 'not configured' until an email provider is set up (nothing is reported as sent before).
 * Global so other modules can raise notifications in their own transactions.
 */
@Global()
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationsHandlers, { provide: EMAIL_PROVIDER, useClass: NotConfiguredEmailProvider }],
  exports: [NotificationsService],
})
export class NotificationsModule {}
