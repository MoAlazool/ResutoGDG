import { Controller, Get, Param, Req } from '@nestjs/common';
import type { ResutoRequest } from '../../common/auth/context';
import { Public } from '../../common/auth/decorators';
import { DbService } from '../../common/db/db.service';
import { notFound } from '../../common/errors/domain-error';
import { RateLimiter } from '../../common/http/rate-limiter';

/** Same shape as table QR tokens (the legacy app printed both as <origin>/t/<token>). */
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * Printed legacy venue (counter) QR codes (CR-13). The legacy app printed `<origin>/t/<venueQr>` for a counter
 * restaurant; the migration tool records that token in legacy_id_map (entity venue_qr → branch). This resolves it to
 * the FT-07 venue route, the branch's public ordering page `/order/<slug>?branch=<code>`, which the web app's /t/<token>
 * page redirects to, so codes printed before the cutover keep working. Unknown, ambiguous or closed: 404.
 */
@Controller('public/venue')
export class PublicVenueController {
  constructor(private readonly db: DbService, private readonly limiter: RateLimiter) {}

  @Public()
  @Get(':token')
  async resolve(@Param('token') token: string, @Req() req: ResutoRequest) {
    this.limiter.hit(`public-venue:${req.ip}`, 120);
    if (!TOKEN.test(token ?? '')) throw notFound('Venue');
    const rows = await this.db.withPlatform((tx) => tx.query<{ slug: string; code: string }>(
      `select o.slug, b.code from legacy_id_map m
         join branches b on b.id = m.new_id and b.org_id = m.org_id and b.is_active
         join organizations o on o.id = m.org_id and o.status not in ('closed', 'suspended')
        where m.entity_type = 'venue_qr' and m.legacy_id = $1 limit 2`, [token]), 'guest:venue-qr');
    if (rows.length !== 1) throw notFound('Venue');
    const { slug, code } = rows[0];
    return { slug, branchCode: code, path: `/order/${encodeURIComponent(slug)}?branch=${encodeURIComponent(code)}` };
  }
}
