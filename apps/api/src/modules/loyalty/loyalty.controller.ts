import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { loyaltyAdjustInput, loyaltyLedgerQuery, loyaltyProgramInput, loyaltyRewardInput, loyaltyRewardUpdate } from '@resuto/contracts';
import type { z } from 'zod';
import type { TenantContext } from '../../common/auth/context';
import { RequirePermission, RequiresModule, Tenant } from '../../common/auth/decorators';
import { zod } from '../../common/http/zod.pipe';
import { LoyaltyService } from './loyalty.service';

/** Loyalty (FT-03), part of Resuto Marketing. Rules and rewards: marketing:write; balances/ledger: customers:read; adjustments: marketing:approve. */
@Controller('o/:orgId/loyalty')
@RequiresModule('marketing')
export class LoyaltyController {
  constructor(private readonly loyalty: LoyaltyService) {}

  @Get('program')
  @RequirePermission('marketing:read')
  program(@Tenant() ctx: TenantContext) {
    return this.loyalty.getProgram(ctx);
  }

  @Put('program')
  @RequirePermission('marketing:write')
  saveProgram(@Tenant() ctx: TenantContext, @Body(zod(loyaltyProgramInput)) body: z.infer<typeof loyaltyProgramInput>) {
    return this.loyalty.saveProgram(ctx, body);
  }

  @Post('rewards')
  @RequirePermission('marketing:write')
  createReward(@Tenant() ctx: TenantContext, @Body(zod(loyaltyRewardInput)) body: z.infer<typeof loyaltyRewardInput>) {
    return this.loyalty.createReward(ctx, body);
  }

  @Patch('rewards/:rewardId')
  @RequirePermission('marketing:write')
  updateReward(@Tenant() ctx: TenantContext, @Param('rewardId', ParseUUIDPipe) id: string, @Body(zod(loyaltyRewardUpdate)) body: z.infer<typeof loyaltyRewardUpdate>) {
    return this.loyalty.updateReward(ctx, id, body);
  }

  @Get('ledger')
  @RequirePermission('customers:read')
  ledger(@Tenant() ctx: TenantContext, @Query(zod(loyaltyLedgerQuery)) q: z.infer<typeof loyaltyLedgerQuery>) {
    return this.loyalty.ledger(ctx, q);
  }

  @Get('customers/:customerId')
  @RequirePermission('customers:read')
  balance(@Tenant() ctx: TenantContext, @Param('customerId', ParseUUIDPipe) customerId: string) {
    return this.loyalty.balance(ctx, customerId);
  }

  /** Rewards a customer can redeem on a staff order (cashiers create orders but may not manage the programme). */
  @Get('customers/:customerId/rewards')
  @RequirePermission('orders:write')
  redeemable(@Tenant() ctx: TenantContext, @Param('customerId', ParseUUIDPipe) customerId: string) {
    return this.loyalty.redeemable(ctx, customerId);
  }

  @Post('adjustments')
  @RequirePermission('marketing:approve')
  adjust(@Tenant() ctx: TenantContext, @Body(zod(loyaltyAdjustInput)) body: z.infer<typeof loyaltyAdjustInput>, @Headers('idempotency-key') key?: string) {
    return this.loyalty.adjust(ctx, body, key);
  }
}
