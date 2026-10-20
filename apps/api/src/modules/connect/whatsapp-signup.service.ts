import { Inject, Injectable } from '@nestjs/common';
import type { WhatsAppEmbeddedSignup } from '@resuto/contracts';
import { META_GRAPH_VERSION, ProviderError, whatsappCloudAdapter, whatsappCloudDescriptor, type AdapterContext } from '@resuto/integrations';
import { randomInt } from 'node:crypto';
import type { TenantContext } from '../../common/auth/context';
import { SecretBox } from '../../common/crypto/secret-box';
import { DbService } from '../../common/db/db.service';
import { DomainError, conflict, invalid } from '../../common/errors/domain-error';
import { AuditService } from '../../common/platform/audit.service';
import { ENV, type Env } from '../../config/env';
import { credentialsAad, IntegrationConnectionsService, redactedError } from '../integrations/connections.service';
import { credentialsHint } from '../integrations/catalog';
import { metaPlatform, metaPlatformApp } from '../integrations/meta-platform';
import { ProviderHttp } from '../integrations/provider-http';
import { ChannelsService, type WhatsAppVerification } from './channels.service';

/**
 * WhatsApp Embedded Signup v4 with Resuto as a Meta Tech Provider (INT-13). Docs (2026-10-20):
 *   https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation
 *   https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-customers-as-a-tech-provider
 * The browser runs Meta's popup (FB.login with the configuration id) and posts the 30-second code with the WABA and
 * phone number ids; this service exchanges the code for the customer's business token, proves the number belongs to
 * the WABA, subscribes Resuto's app to the WABA's webhooks, registers the number (6-digit PIN, kept sealed) and only
 * then stores the connection and a verified channel. Any failure stores nothing.
 */
@Injectable()
export class WhatsAppSignupService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly db: DbService,
    private readonly box: SecretBox,
    private readonly audit: AuditService,
    private readonly http: ProviderHttp,
    private readonly connections: IntegrationConnectionsService,
    private readonly channels: ChannelsService,
  ) {}

  /** What the web launcher needs (no secrets), and what the owner still has to configure. */
  config() {
    const c = metaPlatform();
    const missing = [
      !c.appId && 'META_APP_ID', !c.appSecret && 'META_APP_SECRET', !c.whatsappSignupConfigId && 'WHATSAPP_ES_CONFIG_ID',
      !this.env.WHATSAPP_APP_SECRET && 'WHATSAPP_APP_SECRET', !this.env.WHATSAPP_VERIFY_TOKEN && 'WHATSAPP_VERIFY_TOKEN',
    ].filter((x): x is string => !!x);
    return {
      available: missing.length === 0, appId: c.appId, configId: c.whatsappSignupConfigId, graphVersion: META_GRAPH_VERSION,
      sdkUrl: 'https://connect.facebook.net/en_US/sdk.js', missing, activation: whatsappCloudDescriptor.activation,
      webhookUrl: `${this.env.API_ORIGIN.replace(/\/$/, '')}/v1/webhooks/whatsapp`,
    };
  }

  async complete(ctx: TenantContext, input: WhatsAppEmbeddedSignup) {
    ctx.require('integrations:manage');
    ctx.assertBranch(input.branchId ?? null);
    const cfg = this.config();
    if (!cfg.available) {
      throw new DomainError('provider_app_not_configured', 'WhatsApp Embedded Signup is not configured on this Resuto server', 503, { env: cfg.missing, activation: cfg.activation });
    }
    const app = metaPlatformApp()!;
    const fail = (code: string, message: string, e: unknown, status = 502) =>
      new DomainError(code, message, status, { provider: redactedError(e) });

    let businessToken: string;
    try {
      businessToken = (await whatsappCloudAdapter.exchangeSignupCode({ fetch: this.http.fetch }, app, input.code)).accessToken;
    } catch (e) {
      throw fail('signup_exchange_failed', 'Meta did not accept the signup code (it is valid for 30 seconds). Start the WhatsApp signup again.', e,
        e instanceof ProviderError && !e.retryable ? 422 : 502);
    }
    const adapter: AdapterContext = { environment: 'live', credentials: { accessToken: businessToken, appSecret: app.clientSecret! },
      config: { phoneNumberId: input.phoneNumberId, wabaId: input.wabaId }, fetch: this.http.fetch };

    let own;
    try { own = await whatsappCloudAdapter.verifyPhoneOwnership(adapter, { wabaId: input.wabaId, phoneNumberId: input.phoneNumberId }); }
    catch (e) { throw fail('verification_unavailable', 'Meta could not be reached to verify the number. Nothing was saved; start the signup again.', e); }
    if (!own.owned) throw invalid('phone_number_not_verified', 'The signup did not grant access to that phone number', { reason: own.reason });

    try { await whatsappCloudAdapter.subscribeApp(adapter, input.wabaId); }
    catch (e) { throw fail('webhook_subscription_failed', 'Meta did not subscribe Resuto to this WhatsApp account\'s messages. Nothing was saved; try again.', e); }

    const pin = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const coexistence = input.event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING';
    if (!coexistence) {
      try { await whatsappCloudAdapter.registerPhone(adapter, input.phoneNumberId, pin); }
      catch (e) { throw fail('phone_registration_failed', 'Meta did not register the phone number for the Cloud API. Nothing was saved; try again.', e); }
    }

    const verification: WhatsAppVerification = { method: 'graph_waba_phone_numbers', wabaId: input.wabaId, phoneNumberId: input.phoneNumberId, phone: own.phone,
      subscribedApp: true, subscribeError: null, checkedAt: new Date().toISOString() };
    const connectionId = await this.saveConnection(ctx, input, businessToken, coexistence ? null : pin, own.phone.verifiedName);

    const existing = await this.db.scoped(ctx, (tx) => tx.maybeOne<{ id: string }>(
      `select id from messaging_channels where org_id = $1 and phone_number_id = $2 and transport = 'meta_cloud'`, [ctx.orgId, input.phoneNumberId]));
    if (existing) {
      // Re-onboarding the same number (new token): re-point and re-verify the existing channel.
      await this.db.scoped(ctx, (tx) => tx.query(`update messaging_channels set connection_id = $2, waba_id = $3, verified_at = now(), verification = $4,
          status = case when status = 'disabled' then 'pending' else status end where id = $1`, [existing.id, connectionId, input.wabaId, verification]));
      return { connectionId, channel: (await this.channels.list(ctx)).items.find((c) => c.id === existing.id), registered: !coexistence };
    }
    const channel = await this.channels.attachVerifiedWhatsApp(ctx, connectionId, {
      displayName: input.displayName, displayPhone: own.phone.displayPhoneNumber, phoneNumberId: input.phoneNumberId, wabaId: input.wabaId,
      branchId: input.branchId ?? null, orderingEnabled: input.orderingEnabled,
    }, verification);
    return { connectionId, channel, registered: !coexistence };
  }

  /** Upserts the org's (or branch's) WhatsApp connection with the sealed business token, marked as a platform-app token. */
  private saveConnection(ctx: TenantContext, input: WhatsAppEmbeddedSignup, token: string, pin: string | null, verifiedName: string | null) {
    const creds: Record<string, string> = { accessToken: token, ...(pin ? { registrationPin: pin } : {}) };
    const config = { phoneNumberId: input.phoneNumberId, wabaId: input.wabaId, ...(input.businessId ? { businessId: input.businessId } : {}),
      appMode: 'platform', onboarding: 'embedded_signup', tokenSource: 'platform_app' };
    // Tenant mode: the upsert reads the sealed column (excluded.credentials_encrypted), which member sessions cannot select.
    return this.db.withTenant(ctx.orgId, async (tx) => {
      const prev = await tx.maybeOne<{ id: string; config: Record<string, unknown> }>(
        `select id, config from integration_connections where org_id = $1 and provider = 'whatsapp_cloud' and branch_id is not distinct from $2 for update`,
        [ctx.orgId, input.branchId ?? null]);
      if (prev && prev.config.phoneNumberId && prev.config.phoneNumberId !== input.phoneNumberId) {
        const used = await tx.maybeOne(`select 1 from messaging_channels where connection_id = $1 and status <> 'disabled'`, [prev.id]);
        if (used) throw conflict('connection_in_use', 'This WhatsApp connection serves another number. Connect the new number to a branch, or disable the old channel first.');
      }
      const sealed = this.box.sealJson(creds, credentialsAad(ctx.orgId, 'whatsapp_cloud'));
      const health = { ok: true, details: { ownership: 'verified', displayPhoneNumber: null, verifiedName }, checkedAt: new Date().toISOString() };
      const { id } = await tx.one<{ id: string }>(
        `insert into integration_connections(org_id, branch_id, provider, category, auth_type, environment, status, credentials_encrypted, credentials_hint, config,
            connected_by, connected_at, health, last_health_check_at, last_success_at, account_identity)
         values ($1, $2, 'whatsapp_cloud', 'messaging', 'api_key', 'live', 'connected', $3, $4, $5, $6, now(), $7, now(), now(), $8)
         on conflict (org_id, provider, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid))
         do update set credentials_encrypted = excluded.credentials_encrypted, credentials_hint = excluded.credentials_hint, config = excluded.config,
           status = 'connected', enabled = true, environment = 'live', connected_by = excluded.connected_by, connected_at = now(), last_error = null,
           health = excluded.health, last_health_check_at = now(), last_success_at = now(), account_identity = excluded.account_identity
         returning id`,
        [ctx.orgId, input.branchId ?? null, sealed, credentialsHint({ accessToken: token }), config, ctx.userId, health,
          { id: input.wabaId, ...(verifiedName ? { name: verifiedName } : {}) }]);
      await this.connections.log(tx, ctx.orgId, id, 'info', 'WhatsApp connected with Embedded Signup (ownership verified, webhooks subscribed)',
        { wabaId: input.wabaId, phoneNumberId: input.phoneNumberId, registered: !!pin });
      await this.audit.record(tx, ctx, { action: 'integration.whatsapp_embedded_signup', entityType: 'integration_connection', entityId: id, branchId: input.branchId ?? null,
        metadata: { wabaId: input.wabaId, phoneNumberId: input.phoneNumberId, coexistence: !pin } });
      return id;
    }, `${ctx.actorType}:${ctx.actorId}`);
  }
}
