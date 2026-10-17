import { Controller, Get, Param, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { ResutoRequest } from '../../common/auth/context';
import { Public } from '../../common/auth/decorators';
import { RateLimiter } from '../../common/http/rate-limiter';
import { PublicSitesService } from './public-sites.service';

/**
 * Published restaurant websites (guest-facing, no authentication). Only the
 * latest published revision is served; the response contains no costs, stock,
 * QR tokens, internal notes or staff data.
 */
@Controller('public/sites')
export class PublicSitesController {
  constructor(private readonly sites: PublicSitesService, private readonly limiter: RateLimiter) {}

  @Public()
  @Get('by-host/:host')
  async byHost(@Param('host') host: string, @Req() req: ResutoRequest, @Res({ passthrough: true }) res: Response) {
    this.limiter.hit(`site:ip:${req.ip ?? 'unknown'}`, 240);
    res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=120');
    return this.sites.byHost(String(host).slice(0, 260));
  }

  @Public()
  @Get(':slug')
  async bySlug(@Param('slug') slug: string, @Req() req: ResutoRequest, @Res({ passthrough: true }) res: Response) {
    this.limiter.hit(`site:ip:${req.ip ?? 'unknown'}`, 240);
    res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=120');
    return this.sites.bySlug(String(slug).toLowerCase().slice(0, 60));
  }
}
