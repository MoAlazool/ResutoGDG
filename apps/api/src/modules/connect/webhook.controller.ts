import { Controller, Get, HttpCode, Inject, Post, Query, Req, Res } from '@nestjs/common';
import { verifyWebhookSubscription } from '@resuto/integrations';
import type { Request, Response } from 'express';
import { Public } from '../../common/auth/decorators';
import { RateLimiter } from '../../common/http/rate-limiter';
import { ENV, type Env } from '../../config/env';
import { WhatsAppWebhookService } from './whatsapp-webhook.service';

@Controller('webhooks/whatsapp')
export class WhatsAppWebhookController {
  constructor(@Inject(ENV) private readonly env: Env, private readonly service: WhatsAppWebhookService, private readonly limiter: RateLimiter) {}

  /** Meta subscription handshake: echo hub.challenge when hub.verify_token matches. */
  @Get()
  @Public()
  verify(@Query() query: Record<string, unknown>, @Req() req: Request, @Res() res: Response) {
    this.limiter.hit(`wa-verify:${req.ip}`, 30);
    const challenge = verifyWebhookSubscription(query, this.env.WHATSAPP_VERIFY_TOKEN);
    if (challenge === null) {
      res.status(403).json({ error: { code: 'forbidden', message: 'Webhook verification failed' } });
      return;
    }
    res.status(200).type('text/plain').send(challenge);
  }

  @Post()
  @Public()
  @HttpCode(200)
  receive(@Req() req: Request & { rawBody?: Buffer }) {
    this.limiter.hit(`wa-webhook:${req.ip}`, 600);
    return this.service.receive(req.rawBody, req.headers['x-hub-signature-256'], req.headers as Record<string, unknown>);
  }
}
