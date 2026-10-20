import { Injectable, Logger } from '@nestjs/common';
import { metaPagesEventKey, parseMetaPagesWebhook, verifyMetaSignature, type PageInbound } from '@resuto/integrations';
import { TenantContext } from '../../common/auth/context';
import { sha256 } from '../../common/crypto/hash';
import { DbService } from '../../common/db/db.service';
import { DomainError } from '../../common/errors/domain-error';
import { Scheduled } from '../../common/events/events';
import { WebhookInboxService } from '../../common/platform/webhook-inbox.service';
import { metaPlatform } from '../integrations/meta-platform';
import { ConversationsService } from './conversations.service';

const PROVIDER = 'meta_pages';

/**
 * Messenger and Instagram Direct webhooks (INT-21 / FT-05), /v1/webhooks/meta. The X-Hub-Signature-256 of the raw body
 * is checked with Resuto's platform app secret (META_APP_SECRET) BEFORE parsing; every event is kept in webhook_inbox
 * (deduplicated by message id) and reaches a conversation only when a VERIFIED channel of that kind owns entry[].id
 * (the Page id for Messenger, the Instagram professional account id for Instagram). Failed events are retried.
 */
@Injectable()
export class MetaPagesWebhookService {
  private readonly logger = new Logger('MetaPagesWebhook');

  constructor(private readonly db: DbService, private readonly inbox: WebhookInboxService, private readonly conversations: ConversationsService) {}

  verifyToken(): string | null {
    return metaPlatform().webhookVerifyToken;
  }

  async receive(rawBody: Buffer | undefined, signature: string | string[] | undefined, headers: Record<string, unknown>) {
    const secret = metaPlatform().appSecret;
    if (!secret) throw new DomainError('webhook_not_configured', 'Messenger / Instagram webhooks are not configured on this server', 503);
    if (!rawBody?.length) throw new DomainError('invalid_payload', 'Empty body', 400);
    if (!verifyMetaSignature(rawBody, signature, secret)) {
      const digest = sha256(rawBody.toString('base64'));
      await this.inbox.store({ provider: PROVIDER, eventKey: `rejected:${digest}`, signatureValid: false, payload: { rejected: true, sha256: digest, bytes: rawBody.length }, headers, orgId: null });
      throw new DomainError('invalid_signature', 'Signature verification failed', 401);
    }
    let payload: unknown;
    try { payload = JSON.parse(rawBody.toString('utf8')); } catch { throw new DomainError('invalid_payload', 'Body is not JSON', 400); }
    const events = parseMetaPagesWebhook(payload);
    let processed = 0, duplicates = 0, ignored = 0, failed = 0;
    for (const event of events) {
      const target = await this.resolve(event);
      const rec = await this.inbox.store({ provider: PROVIDER, eventKey: metaPagesEventKey(event), signatureValid: true, payload: { event }, headers, orgId: target?.orgId ?? null });
      if (rec.duplicate && rec.status !== 'failed' && rec.status !== 'received') { duplicates++; continue; }
      const outcome = await this.process(rec.id, target, event);
      if (outcome === 'processed') processed++; else if (outcome === 'ignored') ignored++; else failed++;
    }
    return { received: events.length, processed, duplicates, ignored, failed };
  }

  private resolve(event: PageInbound): Promise<{ orgId: string; channelId: string } | null> {
    return this.db.withPlatform(async (tx) => {
      const r = await tx.maybeOne<{ org_id: string; id: string }>(
        `select org_id, id from messaging_channels where transport = 'meta_page' and kind = $1 and external_account_id = $2 and verified_at is not null`,
        [event.channelKind, event.accountId]);
      return r ? { orgId: r.org_id, channelId: r.id } : null;
    });
  }

  async process(inboxId: string, target: { orgId: string; channelId: string } | null, event: PageInbound): Promise<'processed' | 'ignored' | 'failed'> {
    if (!target) { await this.inbox.markProcessed(inboxId, 'ignored', 'no verified channel for this Page / Instagram account'); return 'ignored'; }
    try {
      const ctx = new TenantContext(target.orgId, 'admin', null, null, 'system', event.channelKind, 'webhook');
      await this.db.withTenant(target.orgId, async (tx) => {
        const channel = await tx.one<{ status: string }>(`select status from messaging_channels where id = $1`, [target.channelId]);
        if (channel.status === 'disabled') return;
        await this.conversations.receiveInTx(tx, ctx, target.channelId, {
          from: event.from, contactName: null, providerMessageId: `${event.channelKind}:${event.messageId}`, raw: event.raw as Record<string, unknown>,
          type: event.type, text: event.text, replyId: event.replyId, location: null,
        });
      }, `webhook:${event.channelKind}`);
      await this.inbox.markProcessed(inboxId, 'processed', null, target.orgId);
      return 'processed';
    } catch (e) {
      this.logger.warn(`${event.channelKind} event ${inboxId} failed: ${(e as Error).message}`);
      await this.inbox.markProcessed(inboxId, 'failed', (e as Error).message, target.orgId);
      return 'failed';
    }
  }

  @Scheduled('connect.meta-webhook-retry', 60)
  async retryPending() {
    const rows = await this.inbox.pending(PROVIDER, 50);
    let ok = 0;
    for (const r of rows) {
      const event = (r.payload as { event?: PageInbound }).event;
      if (!event) { await this.inbox.markProcessed(r.id, 'ignored', 'no event'); continue; }
      if ((await this.process(r.id, await this.resolve(event), event)) === 'processed') ok++;
    }
    return { pending: rows.length, processed: ok };
  }
}
