import { Global, Module } from '@nestjs/common';
import { ORDERS_QUERY_PORT } from '../kernel/ports';
import { OrdersController, VisitsController } from './orders.controller';
import { CounterService } from './counter.service';
import { OrdersService } from './orders.service';
import { VisitsService } from './visits.service';

/**
 * orders module. Owner: Agent B1 (docs/architecture/MODULE_CONTRACTS.md).
 * Staff orders, visits (table sessions and FT-07 counter sessions) and the ORDERS_QUERY_PORT binding.
 * Global so guest, kitchen and reservations (and other agents via the port) can use it.
 */
@Global()
@Module({
  controllers: [OrdersController, VisitsController],
  providers: [OrdersService, VisitsService, CounterService, { provide: ORDERS_QUERY_PORT, useExisting: OrdersService }],
  exports: [OrdersService, VisitsService, CounterService, ORDERS_QUERY_PORT],
})
export class OrdersModule {}
