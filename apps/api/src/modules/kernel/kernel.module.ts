import { Global, Module } from '@nestjs/common';
import { OrdersKernelService } from './orders-kernel.service';
import { PaymentLedgerService } from './payment-ledger.service';
import { PricingService } from './pricing.service';

/**
 * Lead-owned shared domain kernel: pricing, order placement/lifecycle and the
 * payment ledger. Global so every module uses the same implementation.
 * Module agents call these services; they do not modify them.
 */
@Global()
@Module({
  providers: [PricingService, OrdersKernelService, PaymentLedgerService],
  exports: [PricingService, OrdersKernelService, PaymentLedgerService],
})
export class KernelModule {}
