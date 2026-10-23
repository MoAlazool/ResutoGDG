import { Controller, Get, Param, Req } from '@nestjs/common';
import type { ResutoRequest } from '../../common/auth/context';
import { Public } from '../../common/auth/decorators';
import { notFound } from '../../common/errors/domain-error';
import { RateLimiter } from '../../common/http/rate-limiter';
import { CounterService, VENUE_TOKEN } from '../orders/counter.service';

/**
 * Printed venue (counter) QR codes. The legacy app printed `<origin>/t/<venueQr>` for a counter restaurant; the
 * migration tool records that token in legacy_id_map (entity venue_qr → branch, CR-13), and Resuto prints
 * `<origin>/v/<token>` (the branch's venue credential, FT-07). This resolves either to where the guest belongs: the
 * counter page `/v/<token>` when the branch serves at a counter (every scan opens that guest's own counter order),
 * else the branch's public ordering page `/order/<slug>?branch=<code>`. The web app's /t/<token> page redirects
 * there, so codes printed before the cutover keep working. Unknown, ambiguous or closed: 404.
 */
@Controller('public/venue')
export class PublicVenueController {
  constructor(private readonly counter: CounterService, private readonly limiter: RateLimiter) {}

  @Public()
  @Get(':token')
  resolve(@Param('token') token: string, @Req() req: ResutoRequest) {
    // The web server looks codes up for every guest (one shared IP), like the public table GET: same allowance.
    this.limiter.hit(`public-venue:${req.ip}`, 600);
    if (!VENUE_TOKEN.test(token ?? '')) throw notFound('Venue');
    return this.counter.route(token);
  }
}
