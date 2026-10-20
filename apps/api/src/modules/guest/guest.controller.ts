import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import {
  guestOrderRequest, guestQuoteRequest, serviceRequestInput, webOrderRequest, webQuoteRequest,
  type GuestOrderRequest, type WebOrderRequest,
} from '@resuto/contracts';
import { z } from 'zod';
import type { ResutoRequest } from '../../common/auth/context';
import { sha256 } from '../../common/crypto/hash';
import { Public } from '../../common/auth/decorators';
import { notFound } from '../../common/errors/domain-error';
import { RateLimiter } from '../../common/http/rate-limiter';
import { zod } from '../../common/http/zod.pipe';
import { VisitsService } from '../orders/visits.service';
import { PUBLIC_MENU_CACHE_CONTROL } from '../menu/menu.service';
import { GuestService } from './guest.service';

const uuidPipe = new ParseUUIDPipe();
const slugish = z.string().regex(/^[a-z0-9-]{1,60}$/);
const tokenKey = (t: string | undefined) => sha256(t ?? '').slice(0, 24);

/**
 * QR table guest API (MODULE_CONTRACTS §8 "Guest table session"). Public:
 * the visit bearer token (X-Visit-Token) is the only credential; limits apply
 * per IP and per token.
 */
@Controller('public')
export class GuestController {
  constructor(private readonly guest: GuestService, private readonly visits: VisitsService, private readonly limiter: RateLimiter) {}

  private limit(req: ResutoRequest, scope: string, token: string | undefined, perIp: number, perToken: number) {
    this.limiter.hit(`guest:${scope}:ip:${req.ip}`, perIp);
    if (token) this.limiter.hit(`guest:${scope}:tok:${tokenKey(token)}`, perToken);
  }

  @Public()
  @Post('tables/:qrToken/session')
  @HttpCode(200)
  session(@Param('qrToken') qrToken: string, @Req() req: ResutoRequest) {
    this.limit(req, 'session', qrToken, 30, 60);
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(qrToken)) throw notFound('Table');
    return this.visits.tableSession(qrToken);
  }

  @Public()
  @Get('visits/current')
  current(@Headers('x-visit-token') token: string | undefined, @Req() req: ResutoRequest) {
    this.limit(req, 'read', token, 240, 120);
    return this.guest.current(token);
  }

  @Public()
  @Get('visits/current/menu')
  menu(@Headers('x-visit-token') token: string | undefined, @Req() req: ResutoRequest) {
    this.limit(req, 'read', token, 240, 120);
    return this.guest.visitMenu(token);
  }

  @Public()
  @Post('visits/current/quote')
  @HttpCode(200)
  quote(@Headers('x-visit-token') token: string | undefined, @Body(zod(guestQuoteRequest)) body: z.infer<typeof guestQuoteRequest>, @Req() req: ResutoRequest) {
    this.limit(req, 'quote', token, 120, 60);
    return this.guest.quote(token, body);
  }

  @Public()
  @Post('visits/current/orders')
  order(@Headers('x-visit-token') token: string | undefined, @Headers('idempotency-key') key: string | undefined,
    @Body(zod(guestOrderRequest)) body: GuestOrderRequest, @Req() req: ResutoRequest) {
    this.limit(req, 'order', token, 30, 20);
    return this.guest.placeOrder(token, body, key);
  }

  @Public()
  @Get('visits/current/orders/:orderId')
  orderStatus(@Headers('x-visit-token') token: string | undefined, @Param('orderId', uuidPipe) orderId: string, @Req() req: ResutoRequest) {
    this.limit(req, 'read', token, 240, 120);
    return this.guest.orderStatus(token, orderId);
  }

  @Public()
  @Post('visits/current/requests')
  request(@Headers('x-visit-token') token: string | undefined, @Body(zod(serviceRequestInput)) body: { kind: 'waiter' | 'bill' }, @Req() req: ResutoRequest) {
    this.limit(req, 'request', token, 30, 10);
    return this.guest.request(token, body.kind);
  }
}

/** Website pickup / delivery ordering (channel `web`). */
@Controller('public/order')
export class WebOrderController {
  constructor(private readonly guest: GuestService, private readonly limiter: RateLimiter) {}

  private slug(slug: string) {
    if (!slugish.safeParse(slug).success) throw notFound('Restaurant');
    return slug;
  }

  @Public()
  @Get(':slug')
  async menu(@Param('slug') slug: string, @Query('branch') branch: string | undefined, @Req() req: ResutoRequest,
    @Res({ passthrough: true }) res: Response) {
    this.limiter.hit(`web-order:read:${req.ip}`, 120);
    // PCL-15: versioned ETag + public caching (same policy as /public/menu); a matching If-None-Match gets a 304.
    const { etag, body } = await this.guest.cachedWebMenu(this.slug(slug), typeof branch === 'string' ? branch.slice(0, 60) : undefined);
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', PUBLIC_MENU_CACHE_CONTROL);
    return body;
  }

  @Public()
  @Post(':slug/quote')
  @HttpCode(200)
  quote(@Param('slug') slug: string, @Body(zod(webQuoteRequest)) body: z.infer<typeof webQuoteRequest>, @Req() req: ResutoRequest) {
    this.limiter.hit(`web-order:quote:${req.ip}`, 60);
    return this.guest.webQuote(this.slug(slug), body);
  }

  @Public()
  @Post(':slug/orders')
  order(@Param('slug') slug: string, @Headers('idempotency-key') key: string | undefined, @Body(zod(webOrderRequest)) body: WebOrderRequest, @Req() req: ResutoRequest) {
    this.limiter.hit(`web-order:place:${req.ip}`, 20);
    this.limiter.hit(`web-order:phone:${sha256(body.customer.phone).slice(0, 24)}`, 10);
    return this.guest.webOrder(this.slug(slug), body, key);
  }

  @Public()
  @Get(':slug/orders/:publicRef')
  status(@Param('slug') slug: string, @Param('publicRef') ref: string, @Req() req: ResutoRequest) {
    this.limiter.hit(`web-order:status:${req.ip}`, 240);
    return this.guest.webOrderStatus(this.slug(slug), ref);
  }
}
