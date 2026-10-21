import { Global, Module } from '@nestjs/common';
import { LOYALTY_PORT } from '../kernel/ports';
import { LoyaltyController } from './loyalty.controller';
import { LoyaltyHandlers } from './loyalty.handlers';
import { LoyaltyService } from './loyalty.service';

/**
 * Loyalty (FT-03, Resuto Marketing): programme rules, rewards, the append-only points ledger, earning on paid orders,
 * reversal on refunds/cancellations and expiry. Provides LOYALTY_PORT to the kernel pricing engine (redemptions are
 * an order discount computed server-side).
 */
@Global()
@Module({
  controllers: [LoyaltyController],
  providers: [LoyaltyService, LoyaltyHandlers, { provide: LOYALTY_PORT, useExisting: LoyaltyService }],
  exports: [LoyaltyService, LOYALTY_PORT],
})
export class LoyaltyModule {}
