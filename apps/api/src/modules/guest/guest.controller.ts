import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import {
  guestOrderRequest, guestQuoteRequest, guestVisitPollQuery, serviceRequestInput, webOrderRequest, webQuoteRequest,
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
import { GuestService } from './guest.service';

const uuidPipe = new ParseUUIDPipe();
const slugish = z.string().regex(/^[a-z0-9-]{1,60}$/);
const tokenKey = (t: string | undefined) => sha256(t ?? '').slice(0, 24);

/**
 * Reads are keyed mostly on the visit token: every phone at a table shares one token and a restaurant's guests share
 * one Wi-Fi address, so a per-IP read limit sized for one phone throttled whole dining rooms (PCL-18). A table polls
 * once every few seconds per phone (the view carries order timelines and answers `unchanged` cheaply), so 240 reads a
 * minute per table and 1,200 per address leave ample head room; requests with a missing or unknown token count
 * against a strict per-address budget instead, which keeps token guessing slow.
 */
const READ_PER_IP = 1200;
const READ_PER_TOKEN = 240;
const BAD_TOKEN_PER_IP = 60;

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

  /** Read limits plus a strict budget for requests whose token turns out to be missing or no longer valid. */
  private async read<T>(req: ResutoRequest, token: string | undefined, run: () => Promise<T>): Promise<T> {
    this.limit(req, 'read', token, READ_PER_IP, READ_PER_TOKEN);
    try {
      return await run();
    } catch (e) {
      if ((e as { status?: number }).status === 401) this.limiter.hit(`guest:bad-token:ip:${req.ip}`, BAD_TOKEN_PER_IP);
      throw e;
    }
  }

  /** Read-only QR lookup: the restaurant and table behind a QR code, with no session side effects (CR-03). */
  @Public()
  @Get('tables/:qrToken')
  table(@Param('qrToken') qrToken: string, @Req() req: ResutoRequest) {
    this.limiter.hit(`guest:table:ip:${req.ip}`, 240);
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(qrToken)) throw notFound('Table');
    return this.visits.tablePublic(qrToken);
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
  current(@Headers('x-visit-token') token: string | undefined, @Query(zod(guestVisitPollQuery)) q: z.infer<typeof guestVisitPollQuery>, @Req() req: ResutoRequest) {
    return this.read(req, token, () => this.guest.current(token, q.v));
  }

  @Public()
  @Get('visits/current/menu')
  menu(@Headers('x-visit-token') token: string | undefined, @Req() req: ResutoRequest) {
    return this.read(req, token, () => this.guest.visitMenu(token));
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
    return this.read(req, token, () => this.guest.orderStatus(token, orderId));
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
  menu(@Param('slug') slug: string, @Query('branch') branch: string | undefined, @Req() req: ResutoRequest) {
    this.limiter.hit(`web-order:read:${req.ip}`, 120);
    return this.guest.webMenu(this.slug(slug), typeof branch === 'string' ? branch.slice(0, 60) : undefined);
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
