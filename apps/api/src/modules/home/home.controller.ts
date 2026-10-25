import { Body, Controller, Get, Put, Query } from '@nestjs/common';
import { attentionQuery, overviewPreferencesInput, type OverviewPreferencesInput } from '@resuto/contracts/home';
import type { z } from 'zod';
import type { TenantContext } from '../../common/auth/context';
import { Tenant } from '../../common/auth/decorators';
import { RateLimiter } from '../../common/http/rate-limiter';
import { zod } from '../../common/http/zod.pipe';
import { AttentionService } from './attention.service';
import { PreferencesService } from './preferences.service';

/** Preference saves per member per minute (the Customise sheet saves once per change; this stops scripted writes). */
export const PREFERENCES_PER_MINUTE = 30;

/** The overview command centre (21-HOME): the attention aggregator and the per-user overview layout. */
@Controller('o/:orgId')
export class HomeController {
  constructor(private readonly attention: AttentionService, private readonly prefs: PreferencesService, private readonly limiter: RateLimiter) {}

  /**
   * What needs attention now (slow orders, unpaid bills, low stock, failing integrations, expiring tokens, pending
   * approvals, negative ratings). Each kind is checked only when the caller's role may see it; the rest are listed in
   * `omitted`. Any member may call it; a role that may see none of the kinds gets an empty list with everything omitted.
   */
  @Get('attention')
  find(@Tenant() ctx: TenantContext, @Query(zod(attentionQuery)) q: z.infer<typeof attentionQuery>) {
    return this.attention.attention(ctx, { branchId: q.branchId ?? null });
  }

  /** The caller's own overview layout (the default when nothing is saved). */
  @Get('preferences/overview')
  getOverview(@Tenant() ctx: TenantContext) {
    return this.prefs.getOverview(ctx);
  }

  /** Saves the caller's own overview layout: every section once, in display order, shown or hidden. */
  @Put('preferences/overview')
  putOverview(@Tenant() ctx: TenantContext, @Body(zod(overviewPreferencesInput)) body: OverviewPreferencesInput) {
    this.limiter.hit(`prefs:${ctx.orgId}:${ctx.actorId}`, PREFERENCES_PER_MINUTE);
    return this.prefs.putOverview(ctx, body);
  }
}
