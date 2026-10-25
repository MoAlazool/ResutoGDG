import { Body, Controller, Get, Put, Query } from '@nestjs/common';
import { menuQrQuery, onboardingProgressInput, slugAvailabilityQuery, socialLinksInput } from '@resuto/contracts';
import { z } from 'zod';
import type { AuthPrincipal, TenantContext } from '../../common/auth/context';
import { Principal, RequirePermission, Tenant } from '../../common/auth/decorators';
import { forbidden } from '../../common/errors/domain-error';
import { RateLimiter } from '../../common/http/rate-limiter';
import { zod } from '../../common/http/zod.pipe';
import { OnboardingService } from './onboarding.service';

/** Address checks while typing: generous for a person, too slow to enumerate every restaurant (audit PS-13). */
const SLUG_CHECKS_PER_USER_MINUTE = 60;
/** Progress saves: one per wizard step, with room for going back and forth. */
const PROGRESS_SAVES_PER_USER_MINUTE = 60;

/** Free QR-menu onboarding (21-ONB, plan §6.2): address availability, social links, the view-only menu QR. */
@Controller()
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService, private readonly limiter: RateLimiter) {}

  /**
   * Live availability for the signup form. Signed-in people only (signup creates the account first): an anonymous
   * endpoint would let anyone list every restaurant's address.
   */
  @Get('orgs/slug-availability')
  slugAvailability(@Principal() principal: AuthPrincipal, @Query(zod(slugAvailabilityQuery)) q: z.infer<typeof slugAvailabilityQuery>) {
    if (principal.kind !== 'user') throw forbidden();
    this.limiter.hit(`slug-check:user:${principal.userId}`, SLUG_CHECKS_PER_USER_MINUTE);
    return this.onboarding.slugAvailability(q.slug);
  }

  /** The signed-in person's wizard progress (resumable on any device). Personal: no restaurant in the path. */
  @Get('onboarding/progress')
  progress(@Principal() principal: AuthPrincipal) {
    if (principal.kind !== 'user') throw forbidden();
    return this.onboarding.progress(principal.userId);
  }

  @Put('onboarding/progress')
  saveProgress(@Principal() principal: AuthPrincipal, @Body(zod(onboardingProgressInput)) body: z.infer<typeof onboardingProgressInput>) {
    if (principal.kind !== 'user') throw forbidden();
    this.limiter.hit(`onboarding-progress:user:${principal.userId}`, PROGRESS_SAVES_PER_USER_MINUTE);
    return this.onboarding.saveProgress(principal.userId, body);
  }

  /** Any member may read them (they are public on the menu); changing them is a restaurant profile change. */
  @Get('o/:orgId/social-links')
  socialLinks(@Tenant() ctx: TenantContext) {
    return this.onboarding.socialLinks(ctx);
  }

  @Put('o/:orgId/social-links')
  @RequirePermission('org:manage')
  setSocialLinks(@Tenant() ctx: TenantContext, @Body(zod(socialLinksInput)) body: z.infer<typeof socialLinksInput>) {
    return this.onboarding.setSocialLinks(ctx, body);
  }

  /** The view-only menu QR (/m/<slug>): staff who can see the menu can print it. Never an ordering QR. */
  @Get('o/:orgId/menu-qr')
  @RequirePermission('menu:read')
  menuQr(@Tenant() ctx: TenantContext, @Query(zod(menuQrQuery)) q: z.infer<typeof menuQrQuery>) {
    return this.onboarding.menuQr(ctx, q.branch);
  }
}
