import { Inject, Injectable } from '@nestjs/common';
import type { CreateMessagingChannel, MessageTemplateInput } from '@resuto/contracts';
import { ProviderError, whatsappCloudAdapter } from '@resuto/integrations';
import { z } from 'zod';
import type { TenantContext } from '../../common/auth/context';
import { DbService } from '../../common/db/db.service';
import { DomainError, conflict, invalid, notFound } from '../../common/errors/domain-error';
import { AuditService } from '../../common/platform/audit.service';
import { messageTemplateUpdate, updateMessagingChannel } from '@resuto/contracts';
import { IntegrationConnectionsService } from '../integrations/connections.service';
import { ENV, type Env } from '../../config/env';
import { assertConnectSandbox } from './sandbox-gate';

const iso = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString() : null);

const channelView = (r: any) => ({
  id: r.id, kind: r.kind, transport: r.transport, sandbox: r.transport === 'sandbox', displayName: r.display_name, displayPhone: r.display_phone,
  phoneNumberId: r.phone_number_id, wabaId: r.waba_id, branchId: r.branch_id, connectionId: r.connection_id,
  // Cloud API channels reflect their connection's verified state.
  status: r.status === 'disabled' ? 'disabled' : r.transport === 'sandbox' ? 'sandbox' : r.connection_status === 'connected' ? 'connected' : r.connection_status === 'error' ? 'error' : 'pending',
  orderingEnabled: r.ordering_enabled, createdAt: iso(r.created_at),
});

const templateView = (r: any) => ({
  id: r.id, name: r.name, language: r.language, category: r.category, body: r.body, variables: r.variables, providerStatus: r.provider_status,
  providerTemplateId: r.provider_template_id, sandbox: r.provider_status === 'sandbox', createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
});

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

  create(ctx: TenantContext, input: CreateMessagingChannel) {
    ctx.assertBranch(input.branchId ?? null);
    if (input.transport === 'sandbox') assertConnectSandbox(this.env);
    return this.db.scoped(ctx, async (tx) => {
      if (input.branchId) {
        const b = await tx.maybeOne(`select 1 from branches where id = $1 and org_id = $2`, [input.branchId, ctx.orgId]);
        if (!b) throw notFound('Branch');
      }
      let row;
      if (input.transport === 'sandbox') {
        row = await tx.one(
          `insert into messaging_channels(org_id, branch_id, kind, transport, display_name, status, ordering_enabled)
           values ($1, $2, 'whatsapp', 'sandbox', $3, 'sandbox', $4) returning *`, [ctx.orgId, input.branchId ?? null, input.displayName, input.orderingEnabled]);
      } else {
        const conn = await tx.maybeOne<{ id: string; provider: string; status: string }>(
          `select id, provider, status from integration_connections where id = $1 and org_id = $2`, [input.connectionId, ctx.orgId]);
        if (!conn || conn.provider !== 'whatsapp_cloud') throw invalid('connection_required', 'Choose a WhatsApp Business (Cloud API) connection');
        const taken = await this.db.withPlatform((p) => p.maybeOne<{ org_id: string }>(`select org_id from messaging_channels where phone_number_id = $1`, [input.phoneNumberId]));
        if (taken) throw conflict('phone_number_in_use', 'This WhatsApp phone number is already registered with Resuto');
        row = await tx.one(
          `insert into messaging_channels(org_id, branch_id, kind, transport, connection_id, display_name, display_phone, phone_number_id, waba_id, status, ordering_enabled)
           values ($1, $2, 'whatsapp', 'meta_cloud', $3, $4, $5, $6, $7, 'pending', $8) returning *`,
          [ctx.orgId, input.branchId ?? null, conn.id, input.displayName, input.displayPhone ?? null, input.phoneNumberId, input.wabaId, input.orderingEnabled]);
        row.connection_status = conn.status;
      }
      await this.audit.record(tx, ctx, { action: 'connect.channel_created', entityType: 'messaging_channel', entityId: row.id, branchId: row.branch_id,
        metadata: { transport: row.transport } });
      return channelView(row);
    });
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
