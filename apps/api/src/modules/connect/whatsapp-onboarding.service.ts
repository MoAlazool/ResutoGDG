import { Injectable } from '@nestjs/common';
import { WHATSAPP_TEST_TEMPLATE, type WhatsAppTestTemplate } from '@resuto/contracts';
import { renderTemplateBody } from '@resuto/integrations';
import type { TenantContext } from '../../common/auth/context';
import { DbService } from '../../common/db/db.service';
import { conflict, invalid, notFound } from '../../common/errors/domain-error';
import { RateLimiter } from '../../common/http/rate-limiter';
import { AuditService } from '../../common/platform/audit.service';
import { MessagingService } from './messaging.service';

/** Test sends per restaurant per hour (each one is a business-initiated template Meta may bill). */
const TEST_SENDS_PER_HOUR = 10;

/**
 * WhatsApp official stepper, step 6 (21-INT, plan §6.9): "Send a test template to my phone" and the live inbound
 * check. The test goes through the same outbound queue as every message (sandbox channels deliver it locally through
 * the sandbox adapter; Cloud API channels through the sender job), using an approved template — on a sandbox channel
 * a sandbox template — so it proves the number, the token and the template together. The inbound check reports the
 * channel's newest inbound message, so the owner sees their reply arrive through the verified webhook.
 */
@Injectable()
export class WhatsAppOnboardingService {
  constructor(private readonly db: DbService, private readonly messaging: MessagingService, private readonly audit: AuditService, private readonly limiter: RateLimiter) {}

  async sendTestTemplate(ctx: TenantContext, channelId: string, input: WhatsAppTestTemplate) {
    await this.limiter.guard(`wa-test-template:${ctx.orgId}`, TEST_SENDS_PER_HOUR, 3_600_000);
    return this.db.scoped(ctx, async (tx) => {
      const ch = await tx.maybeOne<{ id: string; kind: string; transport: string; status: string; branch_id: string | null; verified_at: Date | null }>(
        `select id, kind, transport, status, branch_id, verified_at from messaging_channels where id = $1 and org_id = $2`, [channelId, ctx.orgId]);
      if (!ch) throw notFound('Channel');
      ctx.assertBranch(ch.branch_id);
      if (ch.kind !== 'whatsapp') throw invalid('not_whatsapp_channel', 'Test templates are sent on WhatsApp channels only');
      if (ch.status === 'disabled') throw conflict('channel_disabled', 'This channel is disabled');
      if (ch.transport === 'meta_cloud' && !ch.verified_at) throw conflict('channel_unverified', 'Verify the number first: Resuto sends only from numbers whose ownership Meta confirmed.');
      const org = await tx.one<{ name: string; name_ar: string | null; default_locale: 'en' | 'ar' }>(`select name, name_ar, default_locale from organizations where id = $1`, [ctx.orgId]);
      const language = input.language ?? org.default_locale;
      const name = input.templateName ?? WHATSAPP_TEST_TEMPLATE;
      const usable = ch.transport === 'sandbox' ? ['approved', 'sandbox'] : ['approved'];
      const t = await tx.maybeOne<{ name: string; language: string; body: string; variables: string[] }>(
        `select name, language, body, variables from message_templates where org_id = $1 and name = $2 and language = $3 and provider_status = any($4::text[])`,
        [ctx.orgId, name, language, usable]);
      if (!t) {
        throw conflict('test_template_not_approved', ch.transport === 'sandbox'
          ? 'Add the test template in step 4 first (on a sandbox channel it is usable at once).'
          : 'The test template is not approved by Meta yet. Submit it in step 4 and wait for approval.', { templateName: name, language });
      }
      const contact = input.phone.replace(/^\+/, '');
      const conv = await tx.one<{ id: string }>(
        `insert into conversations(org_id, branch_id, channel_id, external_contact, contact_name, status, last_message_at, locale)
         values ($1, $2, $3, $4, null, 'open', now(), $5)
         on conflict (channel_id, external_contact) do update set last_message_at = now()
         returning id`, [ctx.orgId, ch.branch_id, ch.id, contact, language]);
      const row = (await this.messaging.conversation(tx, conv.id))!;
      const restaurant = language === 'ar' && org.name_ar ? org.name_ar : org.name;
      const params = t.variables.map((v) => (v === 'restaurant_name' ? restaurant : ''));
      const sent = await this.messaging.enqueue(tx, row, { type: 'template', templateName: t.name, language: t.language, params, body: renderTemplateBody(t.body, params) },
        { automated: false, sentBy: ctx.userId, reason: 'system_connection_test' });
      await this.audit.record(tx, ctx, { action: 'connect.test_template_sent', entityType: 'messaging_channel', entityId: ch.id, branchId: ch.branch_id,
        metadata: { templateName: t.name, language: t.language, sandbox: sent.sandbox } });
      return { messageId: sent.messageId, conversationId: conv.id, sandbox: sent.sandbox, status: sent.sandbox ? 'delivered' : 'queued', templateName: t.name, language: t.language };
    });
  }

  /** The channel's newest inbound message (since `since`, when given), the webhook subscription and the ownership proof. */
  async inboundCheck(ctx: TenantContext, channelId: string, since: string | undefined) {
    return this.db.scoped(ctx, async (tx) => {
      const ch = await tx.maybeOne<{ id: string; kind: string; transport: string; branch_id: string | null; verified_at: Date | null; verification: { subscribedApp?: boolean } | null }>(
        `select id, kind, transport, branch_id, verified_at, verification from messaging_channels where id = $1 and org_id = $2`, [channelId, ctx.orgId]);
      if (!ch) throw notFound('Channel');
      ctx.assertBranch(ch.branch_id);
      const r = await tx.one<{ last: Date | null; n: number }>(
        `select max(m.created_at) as last, count(*) filter (where $2::timestamptz is null or m.created_at > $2::timestamptz)::int as n
           from messages m join conversations c on c.id = m.conversation_id
          where c.channel_id = $1 and m.direction = 'inbound'`, [ch.id, since ?? null]);
      return {
        channelId: ch.id, sandbox: ch.transport === 'sandbox',
        received: since ? r.n > 0 : r.last !== null, inboundSince: since ? r.n : null,
        lastInboundAt: r.last ? new Date(r.last).toISOString() : null,
        verified: ch.transport === 'sandbox' ? null : !!ch.verified_at,
        webhookSubscribed: ch.transport === 'sandbox' ? null : (ch.verification?.subscribedApp ?? null),
        checkedAt: new Date().toISOString(),
      };
    });
  }
}
