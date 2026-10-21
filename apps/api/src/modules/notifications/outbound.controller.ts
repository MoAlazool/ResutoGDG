import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { TenantContext } from '../../common/auth/context';
import { Public, RequirePermission, Tenant } from '../../common/auth/decorators';
import { DbService } from '../../common/db/db.service';
import { DomainError, notFound } from '../../common/errors/domain-error';
import { cursorAt, keyset, pageOf } from '../../common/http/pagination';
import { RateLimiter } from '../../common/http/rate-limiter';
import { zod } from '../../common/http/zod.pipe';
import { OutboundChannelsService } from './outbound.service';

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const policyBody = z.object({ quietHoursStart: HHMM.nullable(), quietHoursEnd: HHMM.nullable() })
  .refine((p) => (p.quietHoursStart === null) === (p.quietHoursEnd === null), { message: 'Set both times, or neither' });
const listQuery = z.object({ campaignId: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().min(1).max(500).optional() });

/** Staff: quiet hours for marketing and the delivery log (masked recipients only). */
@Controller('o/:orgId/messaging')
export class OutboundController {
  constructor(private readonly outbound: OutboundChannelsService, private readonly db: DbService) {}

  @Get('policy')
  @RequirePermission('marketing:read')
  policy(@Tenant() ctx: TenantContext) { return this.outbound.policy(ctx.orgId); }

  @Put('policy')
  @RequirePermission('marketing:write')
  async setPolicy(@Tenant() ctx: TenantContext, @Body(zod(policyBody)) body: z.infer<typeof policyBody>) {
    await this.db.scoped(ctx, (tx) => this.outbound.setPolicy(tx, ctx.orgId, body));
    return this.outbound.policy(ctx.orgId);
  }

  @Get('outbound')
  @RequirePermission('marketing:read')
  list(@Tenant() ctx: TenantContext, @Query(zod(listQuery)) q: z.infer<typeof listQuery>) {
    const k = keyset(q.cursor);
    return this.db.scoped(ctx, async (tx) => pageOf(await tx.query<any>(
        `select id, channel, purpose, provider, sandbox, recipient_hint, status, attempts, last_error, defer_reason, next_attempt_at, accepted_at, delivered_at, created_at, campaign_id,
                ${cursorAt('created_at')} as cursor_at
           from outbound_messages where org_id = $1 and ($2::uuid is null or campaign_id = $2) ${k.after('created_at', 'id', 3)}
          order by created_at desc, id desc limit ${k.fetch(q.limit)}`,
        [ctx.orgId, q.campaignId ?? null, ...k.params]), q.limit, (r) => ({ at: r.cursor_at, id: r.id }), (r) => ({
        id: r.id, channel: r.channel, purpose: r.purpose, provider: r.provider, sandbox: r.sandbox, recipientHint: r.recipient_hint, status: r.status,
        attempts: r.attempts, lastError: r.last_error, deferReason: r.defer_reason, nextAttemptAt: new Date(r.next_attempt_at).toISOString(),
        acceptedAt: r.accepted_at ? new Date(r.accepted_at).toISOString() : null, deliveredAt: r.delivered_at ? new Date(r.delivered_at).toISOString() : null,
        createdAt: new Date(r.created_at).toISOString(), campaignId: r.campaign_id,
      })));
  }
}

/**
 * Public routes: unsubscribe (link in every marketing message; RFC 8058 one-click POST for email clients) and the
 * providers' signed status webhooks. Unknown or unsigned requests get 401/404 and change nothing.
 */
@Controller()
export class OutboundPublicController {
  constructor(private readonly outbound: OutboundChannelsService, private readonly limiter: RateLimiter) {}

  @Get('public/unsubscribe/:token')
  @Public()
  async status(@Param('token') token: string, @Req() req: Request, @Res() res: Response) {
    this.limiter.hit(`unsub:${req.ip}`, 60);
    // A person who opens the List-Unsubscribe URL in a browser lands on the confirmation page.
    if ((req.headers.accept ?? '').includes('text/html')) {
      return res.redirect(302, this.outbound.pageForToken(token));
    }
    const s = await this.outbound.unsubscribeStatus(token);
    if (!s) throw notFound('Link');
    return res.status(200).json(s);
  }

  /** Confirmation page button, or an email client's one-click POST (body "List-Unsubscribe=One-Click"). */
  @Post('public/unsubscribe/:token')
  @Public()
  @HttpCode(200)
  async unsubscribe(@Param('token') token: string, @Body() body: unknown, @Req() req: Request) {
    this.limiter.hit(`unsub:${req.ip}`, 60);
    const oneClick = !!body && typeof body === 'object' && (body as Record<string, unknown>)['List-Unsubscribe'] === 'One-Click';
    const r = await this.outbound.unsubscribe(token, oneClick ? 'one_click' : 'link');
    if (!r) throw notFound('Link');
    return r;
  }

  @Post('webhooks/resend/:connectionId')
  @HttpCode(200)
  @Public()
  async resend(@Param('connectionId') connectionId: string, @Req() req: Request & { rawBody?: Buffer }, @Res() res: Response) {
    this.limiter.hit(`resend-webhook:${req.ip}`, 600);
    const r = await this.outbound.resendWebhook(connectionId, req.rawBody, req.headers as Record<string, string | string[] | undefined>);
    answerWebhook(res, r);
  }

  @Post('webhooks/twilio/status/:connectionId')
  @HttpCode(200)
  @Public()
  async twilio(@Param('connectionId') connectionId: string, @Body() body: unknown, @Req() req: Request, @Res() res: Response) {
    this.limiter.hit(`twilio-webhook:${req.ip}`, 600);
    const params = Object.fromEntries(Object.entries(body && typeof body === 'object' ? body as Record<string, unknown> : {})
      .filter(([, v]) => typeof v === 'string')) as Record<string, string>;
    const sig = req.headers['x-twilio-signature'];
    const r = await this.outbound.twilioWebhook(connectionId, params, Array.isArray(sig) ? sig[0] : sig);
    answerWebhook(res, r);
  }
}

/** A provider callback's outcome: success bodies as before; refusals in the standard error envelope (PS-20). */
function answerWebhook(res: Response, r: { status: number; body: unknown }) {
  if (r.status < 400) { res.status(r.status).json(r.body); return; }
  if (r.status === 404) throw new DomainError('not_found', 'Unknown webhook endpoint', 404);
  throw new DomainError('webhook_signature_invalid', 'Webhook verification failed', r.status);
}
