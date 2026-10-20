import { Inject, Injectable, Logger } from '@nestjs/common';
import { parseWhatsAppWebhook, verifyWhatsAppSignature, whatsappEventKey, type WhatsAppInbound } from '@resuto/integrations';
import { TenantContext } from '../../common/auth/context';
import { sha256 } from '../../common/crypto/hash';
import { DbService } from '../../common/db/db.service';
import { DomainError } from '../../common/errors/domain-error';
import { Scheduled } from '../../common/events/events';
import { WebhookInboxService } from '../../common/platform/webhook-inbox.service';
import { ENV, type Env } from '../../config/env';
import { IntegrationConnectionsService } from '../integrations/connections.service';
import { ConversationsService } from './conversations.service';
import { MessagingService } from './messaging.service';

const PROVIDER = 'whatsapp';

/** Which app signed the webhook: Resuto's platform app, or one merchant-owned app (one connection). */
type WebhookScope = { kind: 'platform' } | { kind: 'connection'; connectionId: string; orgId: string };

/**
 * WhatsApp Cloud API webhook ingestion: verify X-Hub-Signature-256 over the raw body BEFORE parsing, store every event
 * in webhook_inbox (deduplicated by message id / status id), resolve the tenant and process idempotently. Failed
 * events are retried by a scheduled job.
 *
 * Routing (INT-03, INT-13): an event reaches a channel only when the channel's ownership was verified, its WABA equals
 * the event's entry[].id and its phone_number_id equals metadata.phone_number_id. Events signed with the platform app
 * secret are routed only to platform-app channels; events on a merchant app's own callback URL
 * (/v1/webhooks/whatsapp/c/<connection id>, signed with that app's secret) only to that connection's channels.
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
    private readonly connections: IntegrationConnectionsService,
  ) {}

  /** Platform app endpoint (/v1/webhooks/whatsapp). */
  async receive(rawBody: Buffer | undefined, signature: string | string[] | undefined, headers: Record<string, unknown>) {
    if (!this.env.WHATSAPP_APP_SECRET) throw new DomainError('webhook_not_configured', 'WhatsApp webhooks are not configured on this server', 503);
    return this.ingest(rawBody, signature, headers, this.env.WHATSAPP_APP_SECRET, { kind: 'platform' });
  }

  /** A merchant-owned app's endpoint (/v1/webhooks/whatsapp/c/<connection id>), verified with that app's secret. */
  async receiveForConnection(connectionId: string, rawBody: Buffer | undefined, signature: string | string[] | undefined, headers: Record<string, unknown>) {
    const own = await this.ownAppConnection(connectionId);
    if (!own) throw new DomainError('not_found', 'Unknown webhook', 404);
    return this.ingest(rawBody, signature, headers, own.appSecret, { kind: 'connection', connectionId, orgId: own.orgId });
  }

  /** The verify token of a merchant-owned app's callback (GET handshake), or null. */
  async verifyTokenFor(connectionId: string): Promise<string | null> {
    const row = await this.ownAppRow(connectionId);
    return row && typeof row.config?.webhookVerifyToken === 'string' ? row.config.webhookVerifyToken : null;
  }

  private ownAppRow(connectionId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(connectionId)) return Promise.resolve(null);
    return this.db.withPlatform((tx) => tx.maybeOne<{ org_id: string; config: Record<string, unknown> }>(
      `select org_id, config from integration_connections where id = $1 and provider = 'whatsapp_cloud' and enabled and status <> 'revoked'
          and config->>'appMode' = 'own_app'`, [connectionId]));
  }

  private async ownAppConnection(connectionId: string): Promise<{ orgId: string; appSecret: string } | null> {
    const row = await this.ownAppRow(connectionId);
    if (!row) return null;
    const conn = await this.connections.load(row.org_id, { id: connectionId });
    const appSecret = conn.adapter.credentials.appSecret;
    return appSecret ? { orgId: row.org_id, appSecret } : null;
  }

  private async ingest(rawBody: Buffer | undefined, signature: string | string[] | undefined, headers: Record<string, unknown>, secret: string, scope: WebhookScope) {
    if (!rawBody?.length) throw new DomainError('invalid_payload', 'Empty body', 400);
    if (!verifyWhatsAppSignature(rawBody, signature, secret)) {
      // Keep an audit trail without parsing untrusted content.
      await this.inbox.store({ provider: PROVIDER, eventKey: `rejected:${sha256(rawBody.toString('base64'))}`, signatureValid: false,
        payload: { rejected: true, sha256: sha256(rawBody.toString('base64')), bytes: rawBody.length, ...(scope.kind === 'connection' ? { connectionId: scope.connectionId } : {}) }, headers,
        orgId: scope.kind === 'connection' ? scope.orgId : null });
      throw new DomainError('invalid_signature', 'Signature verification failed', 401);
    }
    let payload: unknown;
    try { payload = JSON.parse(rawBody.toString('utf8')); } catch { throw new DomainError('invalid_payload', 'Body is not JSON', 400); }
    const events = parseWhatsAppWebhook(payload);
    let processed = 0, duplicates = 0, ignored = 0, failed = 0;
    for (const event of events) {
      const target = await this.resolve(event, scope);
      // Deduplicated per signing scope: when both the platform app and a merchant app are subscribed to one WABA, the
      // delivery the platform endpoint ignored must not swallow the one meant for the merchant app.
      const eventKey = scope.kind === 'connection' ? `c:${scope.connectionId}:${whatsappEventKey(event)}` : whatsappEventKey(event);
      const rec = await this.inbox.store({ provider: PROVIDER, eventKey, signatureValid: true,
        payload: { event, scope: scope.kind === 'connection' ? { connectionId: scope.connectionId } : 'platform' }, headers, orgId: target?.orgId ?? null });
      if (rec.duplicate && rec.status !== 'failed' && rec.status !== 'received') { duplicates++; continue; }
      const outcome = await this.process(rec.id, target, event);
      if (outcome === 'processed') processed++; else if (outcome === 'ignored') ignored++; else failed++;
    }
    return { received: events.length, processed, duplicates, ignored, failed };
  }

  /** The verified channel (and tenant) an event belongs to under this signing scope, or null. */
  private async resolve(event: WhatsAppInbound, scope: WebhookScope): Promise<{ orgId: string; channelId: string | null } | null> {
    if (!event.wabaId) return null;
    const connectionId = scope.kind === 'connection' ? scope.connectionId : null;
    return this.db.withPlatform(async (tx) => {
      const phoneNumberId = event.kind === 'template_status' ? null : event.phoneNumberId;
      const r = await tx.maybeOne<{ org_id: string; id: string }>(
        `select ch.org_id, ch.id from messaging_channels ch join integration_connections ic on ic.id = ch.connection_id
          where ch.transport = 'meta_cloud' and ch.verified_at is not null and ch.waba_id = $1
            and ($2::text is null or ch.phone_number_id = $2)
            and (case when $3::uuid is null then coalesce(ic.config->>'appMode', 'platform') <> 'own_app' else ch.connection_id = $3::uuid end)
          order by ch.created_at limit 1`, [event.wabaId, phoneNumberId, connectionId]);
      return r ? { orgId: r.org_id, channelId: event.kind === 'template_status' ? null : r.id } : null;
    });
  }

  async process(inboxId: string, target: { orgId: string; channelId: string | null } | null, event: WhatsAppInbound): Promise<'processed' | 'ignored' | 'failed'> {
    if (!target) { await this.inbox.markProcessed(inboxId, 'ignored', 'no verified channel for this number and account'); return 'ignored'; }
    const { orgId } = target;
    try {
      const ctx = new TenantContext(orgId, 'admin', null, null, 'system', 'whatsapp', 'webhook');
      await this.db.withTenant(orgId, async (tx) => {
        if (event.kind === 'message') {
          const channel = await tx.one<{ id: string; status: string }>(`select id, status from messaging_channels where id = $1`, [target.channelId]);
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

  /** Re-processes stored events that failed (e.g. transient database errors), under the scope they arrived with. */
  @Scheduled('connect.webhook-retry', 60)
  async retryPending() {
    const rows = await this.inbox.pending(PROVIDER, 50);
    let ok = 0;
    for (const r of rows) {
      const stored = r.payload as { event?: WhatsAppInbound; scope?: 'platform' | { connectionId: string } };
      const event = stored.event;
      if (!event) { await this.inbox.markProcessed(r.id, 'ignored', 'no event'); continue; }
      let scope: WebhookScope = { kind: 'platform' };
      if (stored.scope && typeof stored.scope === 'object') {
        const own = await this.ownAppRow(stored.scope.connectionId);
        if (!own) { await this.inbox.markProcessed(r.id, 'ignored', 'connection no longer uses its own app'); continue; }
        scope = { kind: 'connection', connectionId: stored.scope.connectionId, orgId: own.org_id };
      }
      if ((await this.process(r.id, await this.resolve(event, scope), event)) === 'processed') ok++;
    }
    return { pending: rows.length, processed: ok };
  }
}
