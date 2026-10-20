import { Inject, Injectable } from '@nestjs/common';
import type { CreateMessagingChannel, MessageTemplateInput } from '@resuto/contracts';
import { ProviderError, whatsappCloudAdapter, type WhatsAppPhoneNumber } from '@resuto/integrations';
import { z } from 'zod';
import { TenantContext } from '../../common/auth/context';
import { DbService, type Tx } from '../../common/db/db.service';
import { DomainError, conflict, invalid, notFound } from '../../common/errors/domain-error';
import { AuditService } from '../../common/platform/audit.service';
import { messageTemplateUpdate, updateMessagingChannel } from '@resuto/contracts';
import { IntegrationConnectionsService, redactedError } from '../integrations/connections.service';
import { ENV, type Env } from '../../config/env';
import { assertConnectSandbox } from './sandbox-gate';

const iso = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString() : null);

const channelView = (r: any) => ({
  id: r.id, kind: r.kind, transport: r.transport, sandbox: r.transport === 'sandbox', displayName: r.display_name, displayPhone: r.display_phone,
  phoneNumberId: r.phone_number_id, wabaId: r.waba_id, pageId: r.page_id ?? null, externalAccountId: r.external_account_id ?? null,
  branchId: r.branch_id, connectionId: r.connection_id,
  // INT-03: provider channels receive messages only once ownership was proven through the Graph API.
  verified: r.transport === 'sandbox' ? null : !!r.verified_at, verifiedAt: iso(r.verified_at),
  webhookSubscribed: r.transport === 'sandbox' ? null : (r.verification?.subscribedApp ?? null),
  // Provider channels reflect their connection's verified state.
  status: r.status === 'disabled' ? 'disabled' : r.transport === 'sandbox' ? 'sandbox' : !r.verified_at ? 'unverified'
    : r.connection_status === 'connected' ? 'connected' : r.connection_status === 'error' ? 'error' : 'pending',
  orderingEnabled: r.ordering_enabled, createdAt: iso(r.created_at),
});

const templateView = (r: any) => ({
  id: r.id, name: r.name, language: r.language, category: r.category, body: r.body, variables: r.variables, providerStatus: r.provider_status,
  providerTemplateId: r.provider_template_id, sandbox: r.provider_status === 'sandbox', createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
});

export interface WhatsAppVerification {
  method: 'graph_waba_phone_numbers';
  wabaId: string;
  phoneNumberId: string;
  phone: WhatsAppPhoneNumber;
  subscribedApp: boolean;
  subscribeError: string | null;
  checkedAt: string;
}

@Injectable()
export class ChannelsService {
  constructor(private readonly db: DbService, private readonly audit: AuditService, private readonly connections: IntegrationConnectionsService,
    @Inject(ENV) private readonly env: Env) {}

  list(ctx: TenantContext) {
    return this.db.scoped(ctx, async (tx) => {
      const rows = await tx.query(
        `select ch.*, ic.status as connection_status from messaging_channels ch left join integration_connections ic on ic.id = ch.connection_id
          where ch.org_id = $1 order by ch.created_at`, [ctx.orgId]);
      return { items: rows.map(channelView), nextCursor: null };
    });
  }

  async create(ctx: TenantContext, input: CreateMessagingChannel) {
    ctx.assertBranch(input.branchId ?? null);
    if (input.transport === 'meta_cloud') return this.createWhatsApp(ctx, input);
    assertConnectSandbox(this.env);
    return this.db.scoped(ctx, async (tx) => {
      await this.assertBranchExists(tx, ctx, input.branchId ?? null);
      const row = await tx.one(
        `insert into messaging_channels(org_id, branch_id, kind, transport, display_name, status, ordering_enabled)
         values ($1, $2, 'whatsapp', 'sandbox', $3, 'sandbox', $4) returning *`, [ctx.orgId, input.branchId ?? null, input.displayName, input.orderingEnabled]);
      await this.audit.record(tx, ctx, { action: 'connect.channel_created', entityType: 'messaging_channel', entityId: row.id, branchId: row.branch_id,
        metadata: { transport: row.transport } });
      return channelView(row);
    });
  }

  private async assertBranchExists(tx: Tx, ctx: TenantContext, branchId: string | null) {
    if (branchId && !(await tx.maybeOne(`select 1 from branches where id = $1 and org_id = $2`, [branchId, ctx.orgId]))) throw notFound('Branch');
  }

  /**
   * INT-03: a WhatsApp channel is created only for the phone number and WABA of its own connection, and only after the
   * connection's token proved through the Graph API that the WABA lists that number. Nothing is stored when the proof
   * fails or Meta cannot be reached.
   */
  private async createWhatsApp(ctx: TenantContext, input: Extract<CreateMessagingChannel, { transport: 'meta_cloud' }>) {
    const conn = await this.db.scoped(ctx, async (tx) => {
      await this.assertBranchExists(tx, ctx, input.branchId ?? null);
      return tx.maybeOne<{ id: string; provider: string; status: string; enabled: boolean; config: Record<string, unknown>; branch_id: string | null }>(
        `select id, provider, status, enabled, config, branch_id from integration_connections where id = $1 and org_id = $2`, [input.connectionId, ctx.orgId]);
    });
    if (!conn || conn.provider !== 'whatsapp_cloud') throw invalid('connection_required', 'Choose a WhatsApp Business (Cloud API) connection');
    ctx.assertBranch(conn.branch_id);
    if (conn.status === 'revoked' || !conn.enabled) throw conflict('connection_unavailable', 'This WhatsApp connection is revoked or switched off');
    this.assertMatchesConnection(conn.config, input);
    await this.assertNotClaimed(ctx.orgId, input.phoneNumberId);
    const verification = await this.verifyWhatsApp(ctx.orgId, conn.id, { wabaId: input.wabaId, phoneNumberId: input.phoneNumberId });
    return this.attachVerifiedWhatsApp(ctx, conn.id, { ...input, displayPhone: input.displayPhone ?? verification.phone.displayPhoneNumber }, verification);
  }

  /** The channel's ids must be the ones the connection was set up for (a channel cannot borrow another number's token). */
  private assertMatchesConnection(config: Record<string, unknown>, ids: { phoneNumberId: string; wabaId: string }) {
    if (String(config.phoneNumberId ?? '') !== ids.phoneNumberId || String(config.wabaId ?? '') !== ids.wabaId) {
      throw invalid('channel_connection_mismatch', 'The phone number id and WhatsApp Business Account id must be the ones saved on the connection',
        { connection: { phoneNumberId: config.phoneNumberId ?? null, wabaId: config.wabaId ?? null } });
    }
  }

  /** A number proven by another channel cannot be claimed again; an unverified (pre-INT-03) claim never blocks the owner. */
  private async assertNotClaimed(orgId: string, phoneNumberId: string, exceptChannelId: string | null = null) {
    const taken = await this.db.withPlatform((p) => p.maybeOne<{ id: string; org_id: string; verified_at: Date | null }>(
      `select id, org_id, verified_at from messaging_channels where phone_number_id = $1 and ($2::uuid is null or id <> $2)`, [phoneNumberId, exceptChannelId]));
    if (taken?.verified_at) {
      throw conflict(taken.org_id === orgId ? 'channel_exists' : 'phone_number_in_use',
        taken.org_id === orgId ? 'This number already has a channel' : 'This WhatsApp phone number is already registered with Resuto');
    }
  }

  /** Proves ownership with the connection's token and subscribes the token's app to the WABA's webhooks. */
  async verifyWhatsApp(orgId: string, connectionId: string, ids: { wabaId: string; phoneNumberId: string }): Promise<WhatsAppVerification> {
    const conn = await this.connections.load(orgId, { id: connectionId });
    const logIt = (level: 'info' | 'warn' | 'error', message: string, details: Record<string, unknown>) =>
      this.db.withTenant(orgId, (tx) => this.connections.log(tx, orgId, connectionId, level, message, details), 'connect.verify');
    let own;
    try {
      own = await whatsappCloudAdapter.verifyPhoneOwnership(conn.adapter, ids);
    } catch (e) {
      const d = redactedError(e);
      await logIt('error', `Could not verify WhatsApp number ownership: ${d.message}`, { ...ids, error: d });
      if (e instanceof ProviderError && e.status === 401) throw new DomainError('connection_token_invalid', 'Meta rejected the connection token. Reconnect WhatsApp, then try again.', 422);
      throw new DomainError('verification_unavailable', 'Meta could not be reached to verify the number. Nothing was saved; try again.', 502, { retryable: d.retryable });
    }
    if (!own.owned) {
      await logIt('warn', 'WhatsApp number ownership was not proven', { ...ids, reason: own.reason });
      throw invalid('phone_number_not_verified', own.reason === 'not_in_waba'
        ? 'This WhatsApp Business Account does not list that phone number id'
        : 'The connection token cannot access this WhatsApp Business Account', { reason: own.reason });
    }
    let subscribedApp = false;
    let subscribeError: string | null = null;
    try {
      await whatsappCloudAdapter.subscribeApp(conn.adapter, ids.wabaId);
      subscribedApp = true;
    } catch (e) {
      subscribeError = redactedError(e).message;
    }
    const verification: WhatsAppVerification = { method: 'graph_waba_phone_numbers', ...ids, phone: own.phone, subscribedApp, subscribeError, checkedAt: new Date().toISOString() };
    await logIt(subscribedApp ? 'info' : 'warn', subscribedApp ? 'WhatsApp number ownership verified; webhooks subscribed'
      : `WhatsApp number ownership verified; webhook subscription failed: ${subscribeError}`, { ...ids, subscribedApp });
    return verification;
  }

  /**
   * Stores a WhatsApp channel whose ownership was just proven (manual connection or Embedded Signup). An older,
   * unverified claim on the same number (made before INT-03) is superseded and audited in its tenant.
   */
  async attachVerifiedWhatsApp(ctx: TenantContext, connectionId: string, input: { displayName: string; displayPhone?: string | null; phoneNumberId: string; wabaId: string;
    branchId?: string | null; orderingEnabled: boolean }, verification: WhatsAppVerification) {
    await this.db.withPlatform(async (p) => {
      const stale = await p.query<{ id: string; org_id: string }>(
        `update messaging_channels set phone_number_id = null, status = 'disabled',
            verification = verification || jsonb_build_object('supersededAt', now(), 'supersededReason', 'ownership proven by another account')
          where phone_number_id = $1 and verified_at is null returning id, org_id`, [input.phoneNumberId]);
      for (const s of stale) {
        await p.query(`insert into audit_logs(org_id, actor_type, actor_id, action, entity_type, entity_id, source, metadata)
                       values ($1, 'system', 'connect.ownership', 'connect.channel_superseded', 'messaging_channel', $2, 'api', $3)`,
          [s.org_id, s.id, { reason: 'unverified claim on a WhatsApp number whose ownership another account proved' }]);
      }
    });
    return this.db.scoped(ctx, async (tx) => {
      let row;
      try {
        row = await tx.one(
          `insert into messaging_channels(org_id, branch_id, kind, transport, connection_id, display_name, display_phone, phone_number_id, waba_id, status, ordering_enabled,
              verified_at, verification)
           values ($1, $2, 'whatsapp', 'meta_cloud', $3, $4, $5, $6, $7, 'pending', $8, now(), $9) returning *`,
          [ctx.orgId, input.branchId ?? null, connectionId, input.displayName, input.displayPhone ?? null, input.phoneNumberId, input.wabaId, input.orderingEnabled, verification]);
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw conflict('phone_number_in_use', 'This WhatsApp phone number is already registered with Resuto');
        throw e;
      }
      row.connection_status = (await tx.one<{ status: string }>(`select status from integration_connections where id = $1`, [connectionId])).status;
      await this.audit.record(tx, ctx, { action: 'connect.channel_created', entityType: 'messaging_channel', entityId: row.id, branchId: row.branch_id,
        metadata: { transport: row.transport, verified: true, subscribedApp: verification.subscribedApp } });
      return channelView(row);
    });
  }

  /**
   * Re-proves a provider channel (channels created before INT-03, after a token change, or to retry the webhook
   * subscription). A failed proof un-verifies the channel, so it stops receiving webhooks; Meta being unreachable
   * changes nothing.
   */
  async verify(ctx: TenantContext, id: string) {
    const ch = await this.db.scoped(ctx, (tx) => tx.maybeOne<any>(`select * from messaging_channels where id = $1 and org_id = $2`, [id, ctx.orgId]));
    if (!ch) throw notFound('Channel');
    ctx.assertBranch(ch.branch_id);
    if (ch.transport !== 'meta_cloud') throw conflict('not_verifiable', 'Only WhatsApp Cloud API channels are verified here');
    if (!ch.connection_id || !ch.phone_number_id || !ch.waba_id) throw conflict('channel_incomplete', 'This channel has no WhatsApp connection or number');
    const conn = await this.db.scoped(ctx, (tx) => tx.one<{ config: Record<string, unknown>; status: string; enabled: boolean }>(
      `select config, status, enabled from integration_connections where id = $1`, [ch.connection_id]));
    if (conn.status === 'revoked' || !conn.enabled) throw conflict('connection_unavailable', 'This WhatsApp connection is revoked or switched off');
    let verification: WhatsAppVerification | null = null;
    let failure: DomainError | null = null;
    try {
      this.assertMatchesConnection(conn.config, { phoneNumberId: ch.phone_number_id, wabaId: ch.waba_id });
      await this.assertNotClaimed(ctx.orgId, ch.phone_number_id, ch.id);
      verification = await this.verifyWhatsApp(ctx.orgId, ch.connection_id, { wabaId: ch.waba_id, phoneNumberId: ch.phone_number_id });
    } catch (e) {
      if (!(e instanceof DomainError) || e.status >= 500) throw e;
      failure = e;
    }
    const view = await this.db.scoped(ctx, async (tx) => {
      const row = verification
        ? await tx.one(`update messaging_channels set verified_at = now(), verification = $2 where id = $1 returning *`, [id, verification])
        : await tx.one(`update messaging_channels set verified_at = null, verification = verification || $2 where id = $1 returning *`,
          [id, { failedAt: new Date().toISOString(), failure: failure!.code }]);
      await this.audit.record(tx, ctx, { action: verification ? 'connect.channel_verified' : 'connect.channel_verification_failed', entityType: 'messaging_channel',
        entityId: id, branchId: row.branch_id, metadata: verification ? { subscribedApp: verification.subscribedApp } : { code: failure!.code } });
      row.connection_status = conn.status;
      return channelView(row);
    });
    if (failure) throw new DomainError(failure.code, failure.message, failure.status, { ...(failure.details as object ?? {}), channel: view });
    return view;
  }

  update(ctx: TenantContext, id: string, input: z.infer<typeof updateMessagingChannel>) {
    return this.db.scoped(ctx, async (tx) => {
      const r = await tx.maybeOne(`select * from messaging_channels where id = $1 and org_id = $2`, [id, ctx.orgId]);
      if (!r) throw notFound('Channel');
      ctx.assertBranch(r.branch_id);
      if (input.branchId !== undefined) ctx.assertBranch(input.branchId);
      const status = input.disabled === undefined ? r.status : input.disabled ? 'disabled' : r.transport === 'sandbox' ? 'sandbox' : 'pending';
      const row = await tx.one(
        `update messaging_channels set display_name = coalesce($2, display_name), ordering_enabled = coalesce($3, ordering_enabled), status = $4,
            branch_id = case when $5 then $6::uuid else branch_id end
          where id = $1 returning *`,
        [id, input.displayName ?? null, input.orderingEnabled ?? null, status, input.branchId !== undefined, input.branchId ?? null]);
      const conn = row.connection_id ? await tx.maybeOne(`select status from integration_connections where id = $1`, [row.connection_id]) : null;
      await this.audit.record(tx, ctx, { action: 'connect.channel_updated', entityType: 'messaging_channel', entityId: id, branchId: row.branch_id, metadata: input });
      return channelView({ ...row, connection_status: conn?.status });
    });
  }

  // ---------------------------------------------------------------------------
  // Templates
  // ---------------------------------------------------------------------------
  listTemplates(ctx: TenantContext) {
    return this.db.scoped(ctx, async (tx) => ({
      items: (await tx.query(`select * from message_templates where org_id = $1 order by name, language`, [ctx.orgId])).map(templateView), nextCursor: null,
    }));
  }

  createTemplate(ctx: TenantContext, input: MessageTemplateInput) {
    return this.db.scoped(ctx, async (tx) => {
      const row = await tx.one(
        `insert into message_templates(org_id, name, language, category, body, variables) values ($1, $2, $3, $4, $5, $6) returning *`,
        [ctx.orgId, input.name, input.language, input.category, input.body, input.variables]);
      await this.audit.record(tx, ctx, { action: 'connect.template_created', entityType: 'message_template', entityId: row.id, metadata: { name: input.name } });
      return templateView(row);
    });
  }

  updateTemplate(ctx: TenantContext, id: string, input: z.infer<typeof messageTemplateUpdate>) {
    return this.db.scoped(ctx, async (tx) => {
      const r = await tx.maybeOne(`select * from message_templates where id = $1 and org_id = $2 for update`, [id, ctx.orgId]);
      if (!r) throw notFound('Template');
      if (!['draft', 'rejected', 'sandbox'].includes(r.provider_status)) throw conflict('template_locked', 'Submitted or approved templates cannot be edited; create a new one');
      const body = input.body ?? r.body;
      const variables = input.variables ?? r.variables;
      const max = Math.max(0, ...[...body.matchAll(/\{\{(\d+)\}\}/g)].map((m: RegExpMatchArray) => Number(m[1])));
      if (max !== variables.length) throw invalid('template_variables', `Name each of the ${max} placeholder(s)`);
      const row = await tx.one(`update message_templates set body = $2, variables = $3, category = coalesce($4, category), provider_status = 'draft' where id = $1 returning *`,
        [id, body, variables, input.category ?? null]);
      await this.audit.record(tx, ctx, { action: 'connect.template_updated', entityType: 'message_template', entityId: id });
      return templateView(row);
    });
  }

  deleteTemplate(ctx: TenantContext, id: string) {
    return this.db.scoped(ctx, async (tx) => {
      const r = await tx.maybeOne(`delete from message_templates where id = $1 and org_id = $2 returning id, name`, [id, ctx.orgId]);
      if (!r) throw notFound('Template');
      await this.audit.record(tx, ctx, { action: 'connect.template_deleted', entityType: 'message_template', entityId: id, metadata: { name: r.name } });
      return { id, deleted: true };
    });
  }

  /**
   * Submits a template for Meta review through the live WhatsApp connection
   * (implemented_unverified). Without one it becomes a "sandbox" template that
   * only sandbox channels can use — it is never presented as Meta-approved.
   */
  async submitTemplate(ctx: TenantContext, id: string) {
    const t = await this.db.scoped(ctx, (tx) => tx.maybeOne(`select * from message_templates where id = $1 and org_id = $2`, [id, ctx.orgId]));
    if (!t) throw notFound('Template');
    if (['submitted', 'approved'].includes(t.provider_status)) throw conflict('template_submitted', `Template is already ${t.provider_status}`);
    const conns = await this.db.scoped(ctx, (tx) => tx.query<{ id: string; environment: string; status: string; enabled: boolean }>(
      `select id, environment, status, enabled from integration_connections where org_id = $1 and provider = 'whatsapp_cloud' and enabled and status <> 'revoked'`, [ctx.orgId]));
    const live = conns.find((c) => c.environment === 'live');
    let update: { status: string; providerId: string | null; note: string };
    if (live) {
      const conn = await this.connections.load(ctx.orgId, { id: live.id });
      try {
        const res = await whatsappCloudAdapter.submitTemplate(conn.adapter, { name: t.name, language: t.language, category: t.category, body: t.body,
          examples: t.variables.map((v: string) => `<${v}>`) });
        update = { status: res.status === 'APPROVED' ? 'approved' : res.status === 'REJECTED' ? 'rejected' : 'submitted', providerId: res.templateId, note: 'Submitted to Meta for review' };
      } catch (e) {
        throw new DomainError('provider_error', e instanceof ProviderError ? e.message : 'Template submission failed', 502);
      }
    } else {
      update = { status: 'sandbox', providerId: null, note: 'No live WhatsApp connection: marked as a sandbox template (usable on sandbox channels only, not reviewed by Meta).' };
    }
    return this.db.scoped(ctx, async (tx) => {
      const row = await tx.one(`update message_templates set provider_status = $2, provider_template_id = coalesce($3, provider_template_id) where id = $1 returning *`,
        [id, update.status, update.providerId]);
      await this.audit.record(tx, ctx, { action: 'connect.template_submitted', entityType: 'message_template', entityId: id, metadata: { status: update.status } });
      return { ...templateView(row), note: update.note };
    });
  }
}
