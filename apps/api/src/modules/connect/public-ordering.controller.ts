import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { orderingCancelInput, orderingCartInput, orderingCheckoutInput, orderingDetailsInput } from '@resuto/contracts';
import type { Request } from 'express';
import { z } from 'zod';
import { Public } from '../../common/auth/decorators';
import { sha256 } from '../../common/crypto/hash';
import { RateLimiter } from '../../common/http/rate-limiter';
import { zod } from '../../common/http/zod.pipe';
import { OrderingService } from './ordering.service';

/**
 * Hosted ordering page API (/o/:token in the web app). The token is the guest
 * bearer credential sent in a WhatsApp message; only its sha256 is stored.
 * Bodies are strict: carts carry product/option ids and quantities, never prices.
 */
@Controller('public/connect/ordering/:token')
@Public()
export class PublicOrderingController {
  constructor(private readonly ordering: OrderingService, private readonly limiter: RateLimiter) {}

  private limit(req: Request, token: string, perToken = 60) {
    this.limiter.hit(`ordering:ip:${req.ip}`, 240);
    this.limiter.hit(`ordering:t:${sha256(token).slice(0, 24)}`, perToken);
  }

  @Get()
  view(@Param('token') token: string, @Req() req: Request) {
    this.limit(req, token, 120);
    return this.ordering.view(token);
  }

  @HttpCode(200)
  @Post('cart')
  cart(@Param('token') token: string, @Req() req: Request, @Body(zod(orderingCartInput)) body: z.infer<typeof orderingCartInput>) {
    this.limit(req, token);
    return this.ordering.submitCart(token, body);
  }

  @HttpCode(200)
  @Post('details')
  details(@Param('token') token: string, @Req() req: Request, @Body(zod(orderingDetailsInput)) body: z.infer<typeof orderingDetailsInput>) {
    this.limit(req, token);
    return this.ordering.updateDetails(token, body);
  }

  @Post('checkout')
  checkout(@Param('token') token: string, @Req() req: Request, @Body(zod(orderingCheckoutInput)) body: z.infer<typeof orderingCheckoutInput>) {
    this.limit(req, token, 20);
    return this.ordering.checkout(token, body);
  }

  @HttpCode(200)
  @Post('cancel')
  cancel(@Param('token') token: string, @Req() req: Request, @Body(zod(orderingCancelInput)) body: z.infer<typeof orderingCancelInput>) {
    this.limit(req, token, 20);
    return this.ordering.cancelByToken(token, body.version);
  }
}
