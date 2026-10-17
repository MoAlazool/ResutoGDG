import { Module } from '@nestjs/common';
import { DispatchController, DriverController } from './delivery.controllers';
import { DeliveryHandlers } from './delivery.handlers';
import { DeliveryService } from './delivery.service';
import { DriverAppService } from './driver-app.service';

/**
 * delivery module (ResutoDriver). Owner: Agent D2 (docs/architecture/MODULE_CONTRACTS.md).
 * Exports DeliveryService (createJobForOrder) for other modules.
 */
@Module({
  controllers: [DispatchController, DriverController],
  providers: [DeliveryService, DriverAppService, DeliveryHandlers],
  exports: [DeliveryService],
})
export class DeliveryModule {}
