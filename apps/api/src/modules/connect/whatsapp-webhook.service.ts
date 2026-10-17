import { Inject, Injectable, Logger } from '@nestjs/common';
import { parseWhatsAppWebhook, verifyWhatsAppSignature, whatsappEventKey, type WhatsAppInbound } from '@resuto/integrations';
import { TenantContext } from '../../common/auth/context';
import { sha256 } from '../../common/crypto/hash';
import { DbService } from '../../common/db/db.service';
import { DomainError } from '../../common/errors/domain-error';
import { Scheduled } from '../../common/events/events';
import { WebhookInboxService } from '../../common/platform/webhook-inbox.service';
import { ENV, type Env } from '../../config/env';
import { ConversationsService } from './conversations.service';
import { MessagingService } from './messaging.service';

const PROVIDER = 'whatsapp';

/**
 * WhatsApp Cloud API webhook ingestion: verify X-Hub-Signature-256 over the raw
 * body BEFORE parsing, store every event in webhook_inbox (deduplicated by
 * message id / status id), resolve the tenant from phone_number_id and process
 * idempotently. Failed events are retried by a scheduled job.
 */
@Injectable()
export class WhatsAppWebhookService {
  private readonly logger = new Logger('WhatsAppWebhook');

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly db: DbService,
    private readonly inbox: WebhookInboxService,
    private readonly conversations: ConversationsService,
    private readonly messaging: MessagingService,
  ) {}

  async receive(rawBody: Buffer | undefined, signature: string | string[] | undefined, headers: Record<string, unknown>) {
    if (!this.env.WHATSAPP_APP_SECRET) throw new DomainError('webhook_not_configured', 'WhatsApp webhooks are not configured on this server', 503);
    if (!rawBody?.length) throw new DomainError('invalid_payload', 'Empty body', 400);
    if (!verifyWhatsAppSignature(rawBody, signature, this.env.WHATSAPP_APP_SECRET)) {
      // Keep an audit trail without parsing untrusted content.
      await this.inbox.store({ provider: PROVIDER, eventKey: `rejected:${sha256(rawBody.toString('base64'))}`, signatureValid: false,
        payload: { rejected: true, sha256: sha256(rawBody.toString('base64')), bytes: rawBody.length }, headers });
      throw new DomainError('invalid_signature', 'Signature verification failed', 401);
    }
    let payload: unknown;
    try { payload = JSON.parse(rawBody.toString('utf8')); } catch { throw new DomainError('invalid_payload', 'Body is not JSON', 400); }
    const events = parseWhatsAppWebhook(payload);
    let processed = 0, duplicates = 0, ignored = 0, failed = 0;
    for (const event of events) {
      const orgId = await this.resolveOrg(event);
      const rec = await this.inbox.store({ provider: PROVIDER, eventKey: whatsappEventKey(event), signatureValid: true, payload: { event }, headers, orgId });
      if (rec.duplicate && rec.status !== 'failed' && rec.status !== 'received') { duplicates++; continue; }
      const outcome = await this.process(rec.id, orgId, event);
      if (outcome === 'processed') processed++; else if (outcome === 'ignored') ignored++; else failed++;
    }
    return { received: events.length, processed, duplicates, ignored, failed };
  }

  private async resolveOrg(event: WhatsAppInbound): Promise<string | null> {
    return this.db.withPlatform(async (tx) => {
      const r = event.kind === 'template_status'
        ? await tx.maybeOne<{ org_id: string }>(`select org_id from messaging_channels where waba_id = $1 and transport = 'meta_cloud' limit 1`, [event.wabaId])
        : await tx.maybeOne<{ org_id: string }>(`select org_id from messaging_channels where phone_number_id = $1 and transport = 'meta_cloud'`, [event.phoneNumberId]);
      return r?.org_id ?? null;
    });
  }

  async process(inboxId: string, orgId: string | null, event: WhatsAppInbound): Promise<'processed' | 'ignored' | 'failed'> {
    if (!orgId) { await this.inbox.markProcessed(inboxId, 'ignored', 'no channel for this phone number'); return 'ignored'; }
    try {
      const ctx = new TenantContext(orgId, 'admin', null, null, 'system', 'whatsapp', 'webhook');
      await this.db.withTenant(orgId, async (tx) => {
        if (event.kind === 'message') {
          const channel = await tx.one<{ id: string; status: string }>(`select id, status from messaging_channels where phone_number_id = $1`, [event.phoneNumberId]);
          if (channel.status === 'disabled') return;
          await this.conversations.receiveInTx(tx, ctx, channel.id, {
            from: event.from, contactName: event.contactName, providerMessageId: event.messageId, raw: event.raw,
            type: event.type, text: event.text, replyId: event.replyId, location: event.location,
          });
        } else if (event.kind === 'status') {
          await this.messaging.applyStatus(tx, event.messageId, event.status, event.error);
        } else {
          const status = { APPROVED: 'approved', REJECTED: 'rejected', PAUSED: 'paused', DISABLED: 'paused', PENDING: 'submitted' }[event.event] ?? null;
          if (status) await tx.query(`update message_templates set provider_status = $2 where org_id = $1 and provider_template_id = $3`, [orgId, status, event.templateId]);
        }
      }, 'webhook:whatsapp');
      await this.inbox.markProcessed(inboxId, 'processed', null, orgId);
      return 'processed';
    } catch (e) {
      this.logger.warn(`whatsapp event ${inboxId} failed: ${(e as Error).message}`);
      await this.inbox.markProcessed(inboxId, 'failed', (e as Error).message, orgId);
      return 'failed';
    }
  }

  /** Re-processes stored events that failed (e.g. transient database errors). */
  @Scheduled('connect.webhook-retry', 60)
  async retryPending() {
    const rows = await this.inbox.pending(PROVIDER, 50);
    let ok = 0;
    for (const r of rows) {
      const event = (r.payload as { event?: WhatsAppInbound }).event;
      if (!event) { await this.inbox.markProcessed(r.id, 'ignored', 'no event'); continue; }
      if ((await this.process(r.id, r.org_id ?? (await this.resolveOrg(event)), event)) === 'processed') ok++;
    }
    return { pending: rows.length, processed: ok };
  }
}
