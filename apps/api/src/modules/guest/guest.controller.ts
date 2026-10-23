import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import {
  assistantRequest, guestOrderRequest, guestQuoteRequest, guestRatingInput, guestVisitPollQuery, serviceRequestInput, suggestionsRequest, webOrderRequest,
  webQuoteRequest, type AssistantRequest, type GuestOrderRequest, type GuestRatingInput, type WebOrderRequest,
} from '@resuto/contracts';
import { z } from 'zod';
import type { ResutoRequest } from '../../common/auth/context';
import { sha256 } from '../../common/crypto/hash';
import { Public } from '../../common/auth/decorators';
import { notFound } from '../../common/errors/domain-error';
import { RateLimiter } from '../../common/http/rate-limiter';
import { zod } from '../../common/http/zod.pipe';
import { VisitsService } from '../orders/visits.service';
import { GuestAssistantService } from './assistant.service';
import { PUBLIC_MENU_CACHE_CONTROL, PUBLIC_MENU_NO_STORE } from '../menu/menu.service';
import { GuestService } from './guest.service';
import { GuestRatingsService } from './ratings.service';
import { TokenGuessGuard } from './token-guess-guard';

const uuidPipe = new ParseUUIDPipe();
const slugish = z.string().regex(/^[a-z0-9-]{1,60}$/);
const tokenKey = (t: string | undefined) => sha256(t ?? '').slice(0, 24);

/**
 * Reads are keyed mostly on the visit token: every phone at a table shares one token and a restaurant's guests share
 * one Wi-Fi address, so a per-IP read limit sized for one phone throttled whole dining rooms (PCL-18). A table polls
 * once every few seconds per phone (the view carries order timelines and answers `unchanged` cheaply), so 240 reads a
 * minute per table and 1,200 per address leave ample head room. Requests with a missing or unknown token count
 * against a strict per-address budget; once it is spent the address gets 429 before any lookup, except for tokens
 * seen working recently (TokenGuessGuard), so a correct guess is refused too and guessing costs no database work.
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
  constructor(private readonly guest: GuestService, private readonly visits: VisitsService, private readonly limiter: RateLimiter,
    private readonly assistant: GuestAssistantService, private readonly ratings: GuestRatingsService,
    private readonly guessing: TokenGuessGuard) {}

  private limit(req: ResutoRequest, scope: string, token: string | undefined, perIp: number, perToken: number) {
    this.limiter.hit(`guest:${scope}:ip:${req.ip}`, perIp);
    if (token) this.limiter.hit(`guest:${scope}:tok:${tokenKey(token)}`, perToken);
  }

  /**
   * Read limits plus a strict budget for requests whose token turns out to be missing or no longer valid. The budget is
   * checked before the token is looked up, so once it is spent a guess is refused whether or not it would be right.
   */
  private async read<T>(req: ResutoRequest, token: string | undefined, run: () => Promise<T>): Promise<T> {
    this.limit(req, 'read', token, READ_PER_IP, READ_PER_TOKEN);
    const ip = req.ip ?? 'unknown';
    const key = token ? tokenKey(token) : null;
    this.guessing.check(ip, key, BAD_TOKEN_PER_IP);
    try {
      const result = await run();
      if (key) this.guessing.worked(key);
      return result;
    } catch (e) {
      if ((e as { status?: number }).status === 401) this.guessing.failed(ip);
      throw e;
    }
  }

  /** Read-only QR lookup: the restaurant and table behind a QR code, with no session side effects (CR-03). */
  @Public()
  @Get('tables/:qrToken')
  table(@Param('qrToken') qrToken: string, @Req() req: ResutoRequest) {
    // The web app reads this while rendering the QR page (cached 15 s per code), so one address serves many guests.
    this.limiter.hit(`guest:table:ip:${req.ip}`, 600);
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(qrToken)) throw notFound('Table');
    return this.visits.tablePublic(qrToken);
  }

  @Public()
  @Post('tables/:qrToken/session')
  @HttpCode(200)
  session(@Param('qrToken') qrToken: string, @Req() req: ResutoRequest) {
    this.limit(req, 'session', qrToken, 30, 60);
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(qrToken)) throw notFound('Table');
    // A phone that just scanned in polls at once; its fresh token is known good even if someone here was guessing.
    return this.visits.tableSession(qrToken).then((s) => { this.guessing.worked(tokenKey(s.token)); return s; });
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

  /** FT-03: rewards the identified visit customer can redeem (empty when the visit has no linked customer). */
  @Public()
  @Get('visits/current/rewards')
  rewards(@Headers('x-visit-token') token: string | undefined, @Req() req: ResutoRequest) {
    this.limit(req, 'rewards', token, 60, 60);
    return this.guest.visitRewards(token);
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

  /** "Help me choose": a meal for the party and budget from the live menu (rules, no generative model). */
  @Public()
  @Post('visits/current/assistant')
  @HttpCode(200)
  visitAssistant(@Headers('x-visit-token') token: string | undefined, @Body(zod(assistantRequest)) body: AssistantRequest, @Req() req: ResutoRequest) {
    this.limit(req, 'assistant', token, 120, 30);
    return this.assistant.forVisit(token, body);
  }

  /** Something to go with the cart: dishes ordered together here, else a drink or a dessert. */
  @Public()
  @Post('visits/current/suggestions')
  @HttpCode(200)
  visitSuggestions(@Headers('x-visit-token') token: string | undefined, @Body(zod(suggestionsRequest)) body: z.infer<typeof suggestionsRequest>, @Req() req: ResutoRequest) {
    this.limit(req, 'suggest', token, 240, 60);
    return this.assistant.suggestForVisit(token, body.productIds);
  }

  /** Rate the visit once the bill is settled (one rating per table visit). */
  @Public()
  @Post('visits/current/rating')
  @HttpCode(200)
  rateVisit(@Headers('x-visit-token') token: string | undefined, @Body(zod(guestRatingInput)) body: GuestRatingInput, @Req() req: ResutoRequest) {
    this.limit(req, 'rating', token, 30, 10);
    return this.ratings.rateVisit(token, body);
  }

  /** Rate from a paid split share (the share link is its own credential). */
  @Public()
  @Post('shares/:token/rating')
  @HttpCode(200)
  rateShare(@Param('token') shareToken: string, @Body(zod(guestRatingInput)) body: GuestRatingInput, @Req() req: ResutoRequest) {
    this.limit(req, 'rating', shareToken, 30, 10);
    return this.ratings.rateShare(shareToken, body);
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
  constructor(private readonly guest: GuestService, private readonly limiter: RateLimiter,
    private readonly assistant: GuestAssistantService, private readonly ratings: GuestRatingsService) {}

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
    if (etag) res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', etag ? PUBLIC_MENU_CACHE_CONTROL : PUBLIC_MENU_NO_STORE);
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
  async order(@Param('slug') slug: string, @Headers('idempotency-key') key: string | undefined, @Body(zod(webOrderRequest)) body: WebOrderRequest, @Req() req: ResutoRequest) {
    await this.limiter.guard(`web-order:place:${req.ip}`, 20);
    // Per number, not per spelling: 010…, 10…, 20…, +20… and 0020… of one phone share a budget (CR-06).
    // Shared (database-backed) budget across instances, checked before the tenant transaction (REM-A10).
    return this.guest.webOrder(this.slug(slug), body, key, (e164) => this.limiter.guard(`web-order:phone:${sha256(e164).slice(0, 24)}`, 10));
  }

  @Public()
  @Post(':slug/assistant')
  @HttpCode(200)
  assist(@Param('slug') slug: string, @Body(zod(assistantRequest)) body: AssistantRequest, @Req() req: ResutoRequest) {
    this.limiter.hit(`web-order:assistant:${req.ip}`, 60);
    return this.assistant.forWeb(this.slug(slug), body);
  }

  @Public()
  @Post(':slug/suggestions')
  @HttpCode(200)
  suggestions(@Param('slug') slug: string, @Body(zod(suggestionsRequest)) body: z.infer<typeof suggestionsRequest>, @Req() req: ResutoRequest) {
    this.limiter.hit(`web-order:suggest:${req.ip}`, 120);
    return this.assistant.suggestForWeb(this.slug(slug), body.branch, body.productIds);
  }

  /** Rate a web order once it is paid online or handed over (the unguessable reference is the credential). */
  @Public()
  @Post(':slug/orders/:publicRef/rating')
  @HttpCode(200)
  async rate(@Param('slug') slug: string, @Param('publicRef') ref: string, @Body(zod(guestRatingInput)) body: GuestRatingInput, @Req() req: ResutoRequest) {
    await this.limiter.guard(`web-order:rating:${req.ip}`, 30);
    return this.ratings.rateWebOrder(this.slug(slug), ref, body);
  }

  @Public()
  @Get(':slug/orders/:publicRef')
  status(@Param('slug') slug: string, @Param('publicRef') ref: string, @Req() req: ResutoRequest) {
    this.limiter.hit(`web-order:status:${req.ip}`, 240);
    return this.guest.webOrderStatus(this.slug(slug), ref);
  }
}
