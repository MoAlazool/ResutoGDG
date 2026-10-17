import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { createSplit, reservationCheckout, sandboxComplete, shareCheckout, startCheckout, visitCheckout } from '@resuto/contracts';
import { z } from 'zod';
import type { ResutoRequest } from '../../common/auth/context';
import { Public } from '../../common/auth/decorators';
import { zod } from '../../common/http/zod.pipe';
import { RateLimiter } from '../../common/http/rate-limiter';
import { BillsService } from './bills.service';
import { CheckoutService } from './checkout.service';
import { PaymentWebhooksService } from './webhooks.service';

/**
 * Guest-facing ResutoPay endpoints. Every route is authorised only by a bearer
 * link token (checkout, share, reservation) or the X-Visit-Token table session
 * header, and is rate-limited per IP and per token.
 */
@Controller()
@Public()
export class PaymentsPublicController {
  constructor(
    private readonly checkout: CheckoutService,
    private readonly bills: BillsService,
    private readonly limiter: RateLimiter,
  ) {}

  private limit(req: ResutoRequest, token: string | undefined, perToken = 60) {
    this.limiter.hit(`pay:ip:${req.ip ?? 'unknown'}`, 300);
    if (token) this.limiter.hit(`pay:tok:${token.slice(0, 64)}`, perToken);
  }

  // --- hosted checkout --------------------------------------------------------
  @Get('public/pay/:token')
  view(@Req() req: ResutoRequest, @Param('token') token: string) {
    this.limit(req, token);
    return this.checkout.view(token);
  }

  @Post('public/pay/:token/start')
  @HttpCode(200)
  start(@Req() req: ResutoRequest, @Param('token') token: string, @Body(zod(startCheckout)) body: z.infer<typeof startCheckout>) {
    this.limit(req, token, 20);
    return this.checkout.start(token, body);
  }

  /** Return URL / polling: re-checks with the provider server-side; query parameters are ignored. */
  @Post('public/pay/:token/refresh')
  @HttpCode(200)
  refresh(@Req() req: ResutoRequest, @Param('token') token: string) {
    this.limit(req, token, 40);
    return this.checkout.refresh(token);
  }

  @Get('public/pay/:token/receipt')
  receipt(@Req() req: ResutoRequest, @Param('token') token: string) {
    this.limit(req, token);
    return this.checkout.receipt(token);
  }

  @Get('public/pay/:token/sandbox')
  sandboxView(@Req() req: ResutoRequest, @Param('token') token: string, @Query('session') session?: string) {
    this.limit(req, token);
    return this.checkout.sandboxView(token, session);
  }

  @Post('public/pay/:token/sandbox/complete')
  @HttpCode(200)
  sandboxComplete(@Req() req: ResutoRequest, @Param('token') token: string, @Body(zod(sandboxComplete)) body: z.infer<typeof sandboxComplete>) {
    this.limit(req, token, 20);
    return this.checkout.sandboxComplete(token, body.outcome);
  }

  // --- table bill (X-Visit-Token) ---------------------------------------------
  @Get('public/payments/visit/bill')
  bill(@Req() req: ResutoRequest, @Headers('x-visit-token') visitToken?: string) {
    this.limit(req, visitToken);
    return this.bills.bill(visitToken);
  }

  @Post('public/payments/visit/checkout')
  @HttpCode(200)
  billCheckout(@Req() req: ResutoRequest, @Body(zod(visitCheckout)) body: z.infer<typeof visitCheckout>, @Headers('x-visit-token') visitToken?: string) {
    this.limit(req, visitToken, 20);
    return this.bills.checkoutBill(visitToken, body);
  }

  @Post('public/payments/visit/split')
  @HttpCode(200)
  split(@Req() req: ResutoRequest, @Body(zod(createSplit)) body: z.infer<typeof createSplit>, @Headers('x-visit-token') visitToken?: string) {
    this.limit(req, visitToken, 20);
    return this.bills.createSplit(visitToken, body);
  }

  @Post('public/payments/visit/split/cancel')
  @HttpCode(200)
  cancelSplit(@Req() req: ResutoRequest, @Headers('x-visit-token') visitToken?: string) {
    this.limit(req, visitToken, 20);
    return this.bills.cancelSplit(visitToken);
  }

  @Get('public/payments/visit/receipts/:paymentId')
  visitReceipt(@Req() req: ResutoRequest, @Param('paymentId', ParseUUIDPipe) paymentId: string, @Headers('x-visit-token') visitToken?: string) {
    this.limit(req, visitToken);
    return this.bills.visitReceipt(visitToken, paymentId);
  }

  // --- bill shares (/s/<token>) -------------------------------------------------
  @Get('public/payments/shares/:token')
  share(@Req() req: ResutoRequest, @Param('token') token: string) {
    this.limit(req, token);
    return this.bills.shareView(token);
  }

  @Post('public/payments/shares/:token/checkout')
  @HttpCode(200)
  shareCheckout(@Req() req: ResutoRequest, @Param('token') token: string, @Body(zod(shareCheckout)) body: z.infer<typeof shareCheckout>) {
    this.limit(req, token, 20);
    return this.bills.shareCheckout(token, body);
  }

  @Get('public/payments/shares/:token/receipt')
  shareReceipt(@Req() req: ResutoRequest, @Param('token') token: string) {
    this.limit(req, token);
    return this.bills.shareReceipt(token);
  }

  // --- reservation deposits ------------------------------------------------------
  @Post('public/payments/reservations/:code/checkout')
  @HttpCode(200)
  reservationDeposit(@Req() req: ResutoRequest, @Param('code') code: string, @Body(zod(reservationCheckout)) body: z.infer<typeof reservationCheckout>) {
    this.limit(req, body.token, 20);
    return this.bills.reservationCheckout(code, body.token);
  }
}

/** Provider webhooks: raw body verified before parsing (see PaymentWebhooksService). */
@Controller('webhooks/payments')
@Public()
export class PaymentWebhooksController {
  constructor(private readonly webhooks: PaymentWebhooksService, private readonly limiter: RateLimiter) {}

  @Post(':provider')
  @HttpCode(200)
  receive(@Req() req: ResutoRequest & { query: Record<string, string> }, @Param('provider') provider: string) {
    this.limiter.hit(`pay:webhook:${req.ip ?? 'unknown'}`, 1200);
    const query = Object.fromEntries(Object.entries(req.query ?? {}).map(([k, v]) => [k, Array.isArray(v) ? String(v[0]) : String(v)]));
    return this.webhooks.handle(provider.toLowerCase(), req.rawBody, req.headers, query);
  }
}
