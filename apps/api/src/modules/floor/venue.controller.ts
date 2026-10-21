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
    // The web server looks codes up for every guest (one shared IP), like the public table GET: same allowance.
    this.limiter.hit(`public-venue:${req.ip}`, 600);
    if (!TOKEN.test(token ?? '')) throw notFound('Venue');
    // Tenants migrated by an earlier version of the tool map the token to the organization: it resolves to the
    // organization's main branch (the branch the tool maps it to now) until a re-run moves the row.
    const rows = await this.db.withPlatform((tx) => tx.query<{ slug: string; code: string }>(
      `select o.slug, b.code from legacy_id_map m
         join organizations o on o.id = m.org_id and o.status not in ('closed', 'suspended')
         join branches b on b.org_id = m.org_id and b.is_active
          and b.id = case when m.new_id = m.org_id
                          then (select x.id from branches x where x.org_id = m.org_id and x.is_active order by (x.code = 'main') desc, x.created_at, x.id limit 1)
                          else m.new_id end
        where m.entity_type = 'venue_qr' and m.legacy_id = $1 limit 2`, [token]), 'guest:venue-qr');
    if (rows.length !== 1) throw notFound('Venue');
    const { slug, code } = rows[0];
    return { slug, branchCode: code, path: `/order/${encodeURIComponent(slug)}?branch=${encodeURIComponent(code)}` };
  }
}
