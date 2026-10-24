import { Module } from '@nestjs/common';
import { FloorModule } from '../floor/floor.module';
import { KitchenModule } from '../kitchen/kitchen.module';
import { PosAdminController, PosDeviceController, PosPairingController } from './pos.controller';
import { PosDevicesService } from './pos-devices.service';
import { PosFeedService } from './pos-feed.service';
import { PosOrdersService } from './pos-orders.service';
import { PosPrintService } from './pos-print.service';
import { PosSyncService } from './pos-sync.service';

/**
 * pos module (21-POSAPI): the API of native POS devices (the iPad app on feature/ipad-pos). Pairing and device
 * credentials, delta sync, the per-branch event feed, idempotent orders and payments, kitchen routing and print jobs.
 * Business rules stay in the modules it reuses (kernel, orders, menu, floor, kitchen, payments ledger).
 */
@Module({
  imports: [FloorModule, KitchenModule],
  controllers: [PosAdminController, PosPairingController, PosDeviceController],
  providers: [PosDevicesService, PosFeedService, PosSyncService, PosOrdersService, PosPrintService],
})
export class PosModule {}
