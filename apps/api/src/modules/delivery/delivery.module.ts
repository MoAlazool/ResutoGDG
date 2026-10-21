import { Module } from '@nestjs/common';
import { DispatchController, DriverController } from './delivery.controllers';
import { DeliveryHandlers } from './delivery.handlers';
import { DeliveryService } from './delivery.service';
import { DriverAppService } from './driver-app.service';
import { DriverPushService } from './driver-push.service';
import { IntegrationsModule } from '../integrations/integrations.module';
import { RoutingService } from './routing.service';

/**
 * delivery module (ResutoDriver). Owner: Agent D2 (docs/architecture/MODULE_CONTRACTS.md).
 * Exports DeliveryService (createJobForOrder) for other modules.
 */
@Module({
  imports: [IntegrationsModule],
  controllers: [DispatchController, DriverController],
  providers: [DeliveryService, DriverAppService, DeliveryHandlers, RoutingService, DriverPushService],
  exports: [DeliveryService],
})
export class DeliveryModule {}
