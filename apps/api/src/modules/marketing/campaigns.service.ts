import { Injectable, Logger } from '@nestjs/common';
import {
  AD_CHANNELS, ATTRIBUTION_DISCLAIMER, MESSAGE_CHANNELS, type CampaignChannel, type CampaignInput, type CampaignReport,
} from '@resuto/contracts';
import { adsAdapterFor, ProviderError, type AdsObjective } from '@resuto/integrations';
import { randomBytes, randomUUID } from 'node:crypto';
import { TenantContext } from '../../common/auth/context';
import { DbService, type Tx } from '../../common/db/db.service';
import { DomainError, conflict, invalid, notFound, badRequest } from '../../common/errors/domain-error';
import { Scheduled } from '../../common/events/events';
import { cursorAt, keyset, pageOf } from '../../common/http/pagination';
import { AuditService } from '../../common/platform/audit.service';
import { IdempotencyService } from '../../common/platform/idempotency.service';
import { OutboxService } from '../../common/platform/outbox.service';
import type { CampaignsPort } from '../kernel/ports';
import { MessagingService } from '../connect/messaging.service';
import { IntegrationConnectionsService } from '../integrations/connections.service';
import { CHANNEL_PROVIDER, OutboundChannelsService, type OutboundChannel } from '../notifications/outbound.service';
import { SegmentsService } from './segments.service';

const iso = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString() : null);
const MAX_RECIPIENTS = 5000;
/** Recipients handled per transaction (PCL-11); the first chunk runs in the request, the dispatcher job does the rest. */
export const CAMPAIGN_CHUNK = 200;
/** Email/SMS handed to the provider inside the send request; the outbound job sends the rest within 30 s. */
const OUTBOUND_IN_REQUEST = 20;
const isOutbound = (channel: string): channel is OutboundChannel => channel === 'sms' || channel === 'email';
/** Time the dispatcher job spends on chunks per run before leaving the rest to the next run. */
const DISPATCH_BUDGET_MS = 20_000;
const OBJECTIVE_TO_ADS: Record<string, AdsObjective> = {
  awareness: 'awareness', acquisition: 'traffic', reservations: 'traffic', retention: 'sales', reactivation: 'sales', upsell: 'sales',
};

export const campaignView = (r: any) => ({
  id: r.id, name: r.name, objective: r.objective, channel: r.channel, status: r.status, segmentId: r.segment_id, templateId: r.template_id,
  promotionId: r.promotion_id, content: r.content, utmCampaign: r.utm_campaign, budgetMinor: r.budget_minor, currency: r.currency,
  scheduledAt: iso(r.scheduled_at), approvedBy: r.approved_by, approvedAt: iso(r.approved_at), sentAt: iso(r.sent_at), isSandbox: r.is_sandbox,
  source: r.source, externalCampaignId: r.external_campaign_id, createdBy: r.created_by, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
  // PS-14: the current or last launch attempt (token = the "[rs:<token>]" tag in the provider-side campaign name).
  launch: r.launch_token ? { token: r.launch_token, startedAt: iso(r.launch_started_at), mode: r.launch_mode ?? null, error: r.launch_error ?? null,
    inProgress: r.status === 'launching' } : null,
});

const utmSlug = (name: string) => `${name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'campaign'}-${randomBytes(3).toString('hex')}`;

/**
 * Campaigns: draft → pending_approval → approved (marketing:approve) → scheduled
 * → sending → sent. Drafts never send. Messaging campaigns go only to members
 * with marketing consent (others are recorded skipped_no_consent) through
 * MessagingService, so sandbox channels never reach Meta. Ad campaigns launch
 * only when approved AND a live, connected ad account exists; the ads sandbox
 * records launches with is_sandbox=true. Spend/results are never invented.
 */
@Injectable()
export class CampaignsService implements CampaignsPort {
  private readonly logger = new Logger('Campaigns');

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly messaging: MessagingService,
    private readonly segments: SegmentsService,
    private readonly connections: IntegrationConnectionsService,
    private readonly idempotency: IdempotencyService,
    private readonly outbound: OutboundChannelsService,
  ) {}

  private async row(tx: Tx, ctx: TenantContext, id: string, lock = false) {
    const r = await tx.maybeOne(`select * from campaigns where id = $1 and org_id = $2${lock ? ' for update' : ''}`, [id, ctx.orgId]);
    if (!r) throw notFound('Campaign');
    return r;
  }

  private async checkRefs(tx: Tx, ctx: TenantContext, input: { segmentId?: string | null; promotionId?: string | null }) {
    if (input.segmentId && !(await tx.maybeOne(`select 1 from segments where id = $1 and org_id = $2`, [input.segmentId, ctx.orgId]))) throw notFound('Segment');
    if (input.promotionId && !(await tx.maybeOne(`select 1 from promotions where id = $1 and org_id = $2`, [input.promotionId, ctx.orgId]))) throw notFound('Promotion');
  }

  /** CAMPAIGNS_PORT: drafts never send. */
  async createDraft(tx: Tx, ctx: TenantContext, input: { name: string; channel: string; objective?: string; segmentId?: string | null; promotionId?: string | null;
    content: Record<string, unknown>; source: 'manual' | 'ai' | 'mcp'; budgetMinor?: number | null }) {
    const channel = input.channel as CampaignChannel;
    if (![...MESSAGE_CHANNELS, ...AD_CHANNELS, 'email', 'organic'].includes(channel)) throw invalid('invalid_channel', `Unknown channel ${input.channel}`);
    await this.checkRefs(tx, ctx, input);
    const currency = (await tx.one<{ currency: string }>(`select currency from organizations where id = $1`, [ctx.orgId])).currency;
    const row = await tx.one(
      `insert into campaigns(org_id, name, objective, channel, status, segment_id, promotion_id, content, utm_campaign, budget_minor, currency, source, created_by)
       values ($1, $2, $3, $4, 'draft', $5, $6, $7, $8, $9, $10, $11, $12) returning *`,
      [ctx.orgId, input.name.trim().slice(0, 120), input.objective ?? 'retention', channel, input.segmentId ?? null, input.promotionId ?? null, input.content ?? {},
        utmSlug(input.name), input.budgetMinor ?? null, currency, input.source, ctx.userId]);
    await this.audit.record(tx, ctx, { action: 'marketing.campaign_drafted', entityType: 'campaign', entityId: row.id, metadata: { channel, source: input.source } });
    return { id: row.id as string, status: 'draft' as const };
  }

  create(ctx: TenantContext, input: CampaignInput) {
    return this.db.scoped(ctx, async (tx) => {
      const r = await this.createDraft(tx, ctx, { ...input, source: 'manual' });
      return campaignView(await tx.one(`select * from campaigns where id = $1`, [r.id]));
    });
  }

  list(ctx: TenantContext, q: { status?: string; limit: number; cursor?: string }) {
    const k = keyset(q.cursor);
    return this.db.scoped(ctx, async (tx) => pageOf(await tx.query(
      `select *, ${cursorAt('created_at')} as cursor_at from campaigns where org_id = $1 and ($2::campaign_status is null or status = $2)
         ${k.after('created_at', 'id', 3)} order by created_at desc, id desc limit ${k.fetch(q.limit)}`,
      [ctx.orgId, q.status ?? null, ...k.params]), q.limit, (r) => ({ at: r.cursor_at, id: r.id }), campaignView));
  }

  get(ctx: TenantContext, id: string) {
    return this.db.scoped(ctx, async (tx) => campaignView(await this.row(tx, ctx, id)));
  }

  update(ctx: TenantContext, id: string, input: Partial<CampaignInput>) {
    return this.db.scoped(ctx, async (tx) => {
      const r = await this.row(tx, ctx, id, true);
      if (r.status !== 'draft') throw conflict('campaign_not_editable', 'Only drafts can be edited; approved campaigns are locked');
      await this.checkRefs(tx, ctx, input);
      const row = await tx.one(
        `update campaigns set name = coalesce($2, name), objective = coalesce($3, objective), channel = coalesce($4, channel),
            segment_id = case when $5 then $6::uuid else segment_id end, promotion_id = case when $7 then $8::uuid else promotion_id end,
            content = coalesce($9, content), budget_minor = case when $10 then $11::bigint else budget_minor end
          where id = $1 returning *`,
        [id, input.name ?? null, input.objective ?? null, input.channel ?? null, input.segmentId !== undefined, input.segmentId ?? null,
          input.promotionId !== undefined, input.promotionId ?? null, input.content ?? null, input.budgetMinor !== undefined, input.budgetMinor ?? null]);
      await this.audit.record(tx, ctx, { action: 'marketing.campaign_updated', entityType: 'campaign', entityId: id });
      return campaignView(row);
    });
  }

  private transitionTo(ctx: TenantContext, id: string, from: string[], to: string, extra: (tx: Tx, r: any) => Promise<void> = async () => {}, action = `marketing.campaign_${to}`) {
    return this.db.scoped(ctx, async (tx) => {
      const r = await this.row(tx, ctx, id, true);
      if (!from.includes(r.status)) throw new DomainError('invalid_campaign_transition', `Cannot move a ${r.status} campaign to ${to}`, 409, { status: r.status });
      await extra(tx, r);
      const row = await tx.one(`update campaigns set status = $2::campaign_status where id = $1 returning *`, [id, to]);
      await this.audit.record(tx, ctx, { action, entityType: 'campaign', entityId: id, metadata: { from: r.status, to } });
      return campaignView(await tx.one(`select * from campaigns where id = $1`, [row.id]));
    });
  }

  submit(ctx: TenantContext, id: string) {
    return this.transitionTo(ctx, id, ['draft'], 'pending_approval', async (_tx, r) => {
      if (MESSAGE_CHANNELS.includes(r.channel)) {
        if (!r.segment_id) throw invalid('segment_required', 'Choose a segment before submitting');
        if (!r.content?.text && !r.content?.templateName) throw invalid('content_required', 'Add a message or an approved template');
      }
    }, 'marketing.campaign_submitted');
  }

  approve(ctx: TenantContext, id: string) {
    return this.transitionTo(ctx, id, ['pending_approval'], 'approved', async (tx) => {
      await tx.query(`update campaigns set approved_by = $2, approved_at = now() where id = $1`, [id, ctx.userId]);
      await this.outbox.publish(tx, ctx.orgId, { type: 'campaign.approved', aggregateType: 'campaign', aggregateId: id, payload: { approvedBy: ctx.userId } });
    }, 'marketing.campaign_approved');
  }

  reject(ctx: TenantContext, id: string, reason?: string | null) {
    return this.transitionTo(ctx, id, ['pending_approval'], 'draft', async (tx) => {
      await this.audit.record(tx, ctx, { action: 'marketing.campaign_rejected', entityType: 'campaign', entityId: id, metadata: { reason: reason ?? null } });
    }, 'marketing.campaign_returned_to_draft');
  }

  schedule(ctx: TenantContext, id: string, scheduledAt: string) {
    if (new Date(scheduledAt).getTime() < Date.now() - 60_000) throw invalid('schedule_in_past', 'Choose a time in the future');
    return this.transitionTo(ctx, id, ['approved', 'scheduled'], 'scheduled', async (tx, r) => {
      if (!MESSAGE_CHANNELS.includes(r.channel)) throw invalid('not_schedulable', 'Only messaging campaigns are scheduled; launch ad campaigns instead');
      await tx.query(`update campaigns set scheduled_at = $2 where id = $1`, [id, scheduledAt]);
      await this.outbox.publish(tx, ctx.orgId, { type: 'campaign.scheduled', aggregateType: 'campaign', aggregateId: id, payload: { scheduledAt } });
    });
  }

  cancel(ctx: TenantContext, id: string) {
    return this.transitionTo(ctx, id, ['draft', 'pending_approval', 'approved', 'scheduled'], 'cancelled');
  }

  /**
   * Sends an approved messaging campaign. The campaign is marked `sending` and its segment computed in one short
   * transaction; recipients are then processed in chunks of CAMPAIGN_CHUNK, each in its own transaction (PCL-11).
   * The first chunk runs in this request, so small campaigns are `sent` when it returns; larger ones stay `sending`
   * and the dispatcher job continues them within seconds. Deliveries are unique per (campaign, customer), and each
   * chunk locks the campaign row, so a resumed or concurrent run never messages anyone twice.
   *
   * PS-14: with an Idempotency-Key the start of the send is recorded under the key in the same transaction, so a
   * retry with the same key replays it (no 409) and only continues the same dispatch; nobody is messaged twice.
   */
  async sendNow(ctx: TenantContext, id: string, idempotencyKey?: string | null) {
    if (idempotencyKey !== undefined && idempotencyKey !== null && !/^[\x21-\x7e]{8,200}$/.test(idempotencyKey)) {
      throw badRequest('invalid_idempotency_key', 'Idempotency-Key must be 8-200 printable characters');
    }
    const actor = `${ctx.actorType}:${ctx.actorId}`;
    await this.db.withTenant(ctx.orgId, async (tx) => {
      if (!idempotencyKey) return this.startDispatch(tx, ctx, id);
      await this.idempotency.run(tx, ctx.orgId, `marketing.send:${id}`, idempotencyKey, { id }, async () => { await this.startDispatch(tx, ctx, id); return { started: true }; });
    }, actor);
    await this.db.withTenant(ctx.orgId, (tx) => this.dispatchChunk(tx, ctx, id), actor);
    // After commit (provider calls never run inside a transaction).
    await this.outbound.send({ orgId: ctx.orgId, limit: OUTBOUND_IN_REQUEST });
    const delivery = await this.db.withTenant(ctx.orgId, (tx) => this.deliverySummary(tx, id), actor);
    return { ...(await this.get(ctx, id)), delivery };
  }

  /**
   * Validates, marks the campaign `sending`, computes its segment and snapshots the audience into campaign_recipients
   * (no messages yet). Every chunk reads only that snapshot, so a segment recomputed while the campaign is sending
   * cannot change its audience or take it past MAX_RECIPIENTS. With `resume` a campaign that another run already
   * started is left as it is (the scheduler, racing another run on the same due campaign).
   */
  private async startDispatch(tx: Tx, ctx: TenantContext, id: string, opts: { resume?: boolean } = {}) {
    const r = await this.row(tx, ctx, id, true);
    if (opts.resume && r.status === 'sending') return;
    if (!['approved', 'scheduled'].includes(r.status)) {
      throw new DomainError('campaign_not_approved', 'A campaign must be approved before it can be sent', 409, { status: r.status });
    }
    if (isOutbound(r.channel)) {
      // INT-28: SMS / email go through the restaurant's own connected Twilio / Resend account; without one nothing is sent.
      if (!(await this.outbound.activeConnection(tx, ctx.orgId, r.channel))) {
        throw new DomainError('channel_unavailable', r.channel === 'email'
          ? 'Connect an email provider (Resend) in Integrations and pass its health check before sending this campaign'
          : 'Connect an SMS provider (Twilio) in Integrations and pass its health check before sending this campaign', 409, { provider: CHANNEL_PROVIDER[r.channel as OutboundChannel] });
      }
      if (!r.content?.text) throw invalid('content_required', 'Add the message text');
    } else if (r.channel !== 'whatsapp') {
      throw new DomainError('channel_unavailable', 'Ad campaigns are launched, not sent', 409);
    }
    if (!r.segment_id) throw invalid('segment_required', 'Choose a segment');
    await tx.query(`update campaigns set status = 'sending' where id = $1`, [id]);
    await this.segments.compute(tx, ctx.orgId, r.segment_id);
    const n = await tx.one<{ n: number }>(`select count(*)::int as n from (select 1 from segment_members where segment_id = $1 limit $2) s`,
      [r.segment_id, MAX_RECIPIENTS + 1]);
    if (n.n > MAX_RECIPIENTS) throw invalid('segment_too_large', `Campaigns are limited to ${MAX_RECIPIENTS} recipients`);
    await tx.query(
      `insert into campaign_recipients(org_id, campaign_id, customer_id)
       select $1, $2, customer_id from segment_members where segment_id = $3 on conflict do nothing`, [ctx.orgId, id, r.segment_id]);
  }

  /**
   * Up to CAMPAIGN_CHUNK recipients of the snapshot without a delivery yet. Holds the campaign row lock for the chunk, so chunks of
   * one campaign never run concurrently. Marks the campaign `sent` when no recipient is left; returns true then.
   */
  private async dispatchChunk(tx: Tx, ctx: TenantContext, id: string): Promise<boolean> {
    const r = await tx.maybeOne<any>(`select id, name, channel, status, content, utm_campaign from campaigns where id = $1 and org_id = $2 for update`, [id, ctx.orgId]);
    if (!r || r.status !== 'sending') return true;
    const members = await tx.query<{ customer_id: string; marketing_consent: boolean; email: string | null; phone_e164: string | null }>(
      `select m.customer_id, c.marketing_consent, c.email::text as email, c.phone_e164 from campaign_recipients m join customers c on c.id = m.customer_id
        where m.campaign_id = $1 and not exists (select 1 from campaign_deliveries d where d.campaign_id = $1 and d.customer_id = m.customer_id)
        order by m.customer_id limit $2`, [id, CAMPAIGN_CHUNK]);
    const variables = Object.fromEntries((r.content?.variables ?? []).map((v: string, i: number) => [String(i + 1), v]));
    const outboundConn = isOutbound(r.channel) ? await this.outbound.activeConnection(tx, ctx.orgId, r.channel) : null;
    for (const m of members) {
      if (!m.marketing_consent) {
        await tx.query(`insert into campaign_deliveries(org_id, campaign_id, customer_id, status) values ($1, $2, $3, 'skipped_no_consent')`, [ctx.orgId, id, m.customer_id]);
        continue;
      }
      if (isOutbound(r.channel)) {
        await this.queueOutbound(tx, ctx, r, m, outboundConn);
        continue;
      }
      await tx.query('savepoint campaign_member');
      try {
        const res = await this.messaging.enqueueToCustomer(tx, ctx, { customerId: m.customer_id, text: r.content?.text ?? null, templateName: r.content?.templateName ?? null,
          variables, reason: `campaign:${id}` });
        await tx.query('release savepoint campaign_member');
        if (!res.messageId) {
          await tx.query(`insert into campaign_deliveries(org_id, campaign_id, customer_id, status, error) values ($1, $2, $3, $4, $5)`,
            [ctx.orgId, id, m.customer_id, res.skipped === 'no_consent' ? 'skipped_no_consent' : 'failed', res.skipped ?? 'not_sent']);
          continue;
        }
        const msg = await tx.one<{ status: string; sandbox: boolean }>(`select status, coalesce((payload->>'sandbox')::boolean, false) as sandbox from messages where id = $1`, [res.messageId]);
        await tx.query(`insert into campaign_deliveries(org_id, campaign_id, customer_id, message_id, status, sent_at) values ($1, $2, $3, $4, $5, case when $5 <> 'queued' then now() end)`,
          [ctx.orgId, id, m.customer_id, res.messageId, msg.status]);
        await tx.query(`insert into attribution_events(org_id, kind, campaign_id, customer_id, utm) values ($1, 'message_sent', $2, $3, $4)`,
          [ctx.orgId, id, m.customer_id, { utm_source: 'whatsapp', utm_medium: 'campaign', utm_campaign: r.utm_campaign, sandbox: msg.sandbox }]);
      } catch (e) {
        await tx.query('rollback to savepoint campaign_member');
        if (!(e instanceof DomainError)) throw e;
        await tx.query(`insert into campaign_deliveries(org_id, campaign_id, customer_id, status, error) values ($1, $2, $3, 'failed', $4)`, [ctx.orgId, id, m.customer_id, e.code]);
      }
    }
    if (members.length === CAMPAIGN_CHUNK) return false;
    const counts = await this.deliverySummary(tx, id);
    // A campaign is "sandbox" unless at least one message went through a live channel.
    await tx.query(`update campaigns set status = 'sent', sent_at = now(), is_sandbox = $2 where id = $1`, [id, counts.live === 0]);
    await this.audit.record(tx, ctx, { action: 'marketing.campaign_sent', entityType: 'campaign', entityId: id, metadata: counts });
    return true;
  }

  /**
   * INT-28: one email/SMS queue row per consenting recipient (opt-outs, missing or invalid addresses recorded as such).
   * Quiet hours and the provider call are the outbound service's job; the delivery follows the row's status.
   */
  private async queueOutbound(tx: Tx, ctx: TenantContext, r: any, m: { customer_id: string; email: string | null; phone_e164: string | null },
    conn: Awaited<ReturnType<OutboundChannelsService['activeConnection']>>) {
    const fail = (error: string) => tx.query(`insert into campaign_deliveries(org_id, campaign_id, customer_id, status, error) values ($1, $2, $3, 'failed', $4)`,
      [ctx.orgId, r.id, m.customer_id, error]);
    if (!conn) return fail('channel_unavailable');
    const to = r.channel === 'email' ? m.email : m.phone_e164;
    if (!to) return fail('no_address');
    const q = await this.outbound.enqueue(tx, ctx.orgId, { channel: r.channel, purpose: 'marketing', connection: conn, to, customerId: m.customer_id, campaignId: r.id,
      subject: r.channel === 'email' ? (r.content?.subject ?? r.name) : null, text: r.content.text, idempotencyKey: `campaign:${r.id}:${m.customer_id}` });
    if ('skipped' in q) {
      if (q.skipped === 'unsubscribed') {
        await tx.query(`insert into campaign_deliveries(org_id, campaign_id, customer_id, status) values ($1, $2, $3, 'skipped_unsubscribed')`, [ctx.orgId, r.id, m.customer_id]);
        return;
      }
      return fail(q.skipped);
    }
    await tx.query(`insert into campaign_deliveries(org_id, campaign_id, customer_id, outbound_id, status) values ($1, $2, $3, $4, 'queued')`,
      [ctx.orgId, r.id, m.customer_id, q.id]);
    await tx.query(`insert into attribution_events(org_id, kind, campaign_id, customer_id, utm) values ($1, 'message_sent', $2, $3, $4)`,
      [ctx.orgId, r.id, m.customer_id, { utm_source: r.channel, utm_medium: 'campaign', utm_campaign: r.utm_campaign, sandbox: conn.environment === 'sandbox' }]);
  }

  /** Delivery counts from the recorded deliveries (exact across chunks, runs and restarts). */
  private async deliverySummary(tx: Tx, id: string) {
    const c = await tx.one<any>(
      `select count(*)::int as handled,
              count(*) filter (where d.message_id is not null or d.outbound_id is not null)::int as queued,
              count(*) filter (where d.status = 'skipped_no_consent')::int as skipped,
              count(*) filter (where d.status = 'skipped_unsubscribed')::int as unsubscribed,
              count(*) filter (where d.status = 'failed' and d.message_id is null and d.outbound_id is null)::int as failed,
              count(*) filter (where d.status = 'failed' and d.outbound_id is not null)::int as provider_failed,
              count(*) filter (where d.status = 'delivered')::int as delivered,
              count(*) filter (where (coalesce((m.payload->>'sandbox')::boolean, false) and d.message_id is not null) or o.sandbox)::int as sandbox,
              count(*) filter (where (not coalesce((m.payload->>'sandbox')::boolean, false) and d.message_id is not null) or o.sandbox = false)::int as live,
              (select count(*)::int from campaign_recipients cr
                where cr.campaign_id = $1 and not exists (select 1 from campaign_deliveries x where x.campaign_id = $1 and x.customer_id = cr.customer_id)) as pending
         from campaign_deliveries d left join messages m on m.id = d.message_id left join outbound_messages o on o.id = d.outbound_id
        where d.campaign_id = $1`, [id]);
    return { recipients: c.handled + c.pending, queued: c.queued, skippedNoConsent: c.skipped, skippedUnsubscribed: c.unsubscribed, failed: c.failed,
      providerFailed: c.provider_failed, delivered: c.delivered, sandbox: c.sandbox, live: c.live, pending: c.pending };
  }

  /**
   * CAMPAIGN_SEND_PORT (used by ResutoMCP after a human approved the MCP request).
   * Same rules as the dashboard: org-owned draft/approved messaging campaign, the
   * acting context must hold marketing:approve, consent is filtered at send time and
   * sandbox channels are labelled. With scheduledAt → 'scheduled' (sent by the
   * dispatcher job); without → dispatched immediately (sending → 'sent').
   */
  async requestSend(tx: Tx, ctx: TenantContext, input: { campaignId: string; scheduledAt?: string | null; approvedBy: string | null; source: 'mcp' }) {
    ctx.require('marketing:approve');
    const r = await this.row(tx, ctx, input.campaignId, true);
    if (!['draft', 'pending_approval', 'approved'].includes(r.status)) {
      throw new DomainError('invalid_campaign_transition', `Cannot send a ${r.status} campaign`, 409, { status: r.status });
    }
    if (!['whatsapp', 'sms', 'email'].includes(r.channel)) throw invalid('channel_unavailable', 'Only messaging campaigns (WhatsApp, SMS, email) can be sent through this port');
    if (!r.segment_id) throw invalid('segment_required', 'Choose a segment before sending');
    if (!r.content?.text && !r.content?.templateName) throw invalid('content_required', 'Add a message or an approved template');
    if (input.scheduledAt && new Date(input.scheduledAt).getTime() < Date.now() - 60_000) throw invalid('schedule_in_past', 'Choose a time in the future');
    if (r.status !== 'approved') {
      await tx.query(`update campaigns set status = 'approved', approved_by = $2, approved_at = now() where id = $1`, [r.id, input.approvedBy]);
      await this.outbox.publish(tx, ctx.orgId, { type: 'campaign.approved', aggregateType: 'campaign', aggregateId: r.id, payload: { approvedBy: input.approvedBy, source: input.source } });
    }
    await this.audit.record(tx, ctx, { action: 'marketing.campaign_send_requested', entityType: 'campaign', entityId: r.id,
      metadata: { source: input.source, approvedBy: input.approvedBy, scheduledAt: input.scheduledAt ?? null } });
    if (input.scheduledAt) {
      await tx.query(`update campaigns set status = 'scheduled', scheduled_at = $2 where id = $1`, [r.id, input.scheduledAt]);
      await this.outbox.publish(tx, ctx.orgId, { type: 'campaign.scheduled', aggregateType: 'campaign', aggregateId: r.id, payload: { scheduledAt: input.scheduledAt, source: input.source } });
    } else {
      // In the caller's transaction: start and the first chunk; a larger campaign stays `sending` for the job.
      await this.startDispatch(tx, ctx, r.id);
      await this.dispatchChunk(tx, ctx, r.id);
    }
    const after = await tx.one<{ status: string; scheduled_at: Date | null }>(`select status, scheduled_at from campaigns where id = $1`, [r.id]);
    return { campaignId: r.id as string, status: after.status, scheduledAt: iso(after.scheduled_at) };
  }

  /**
   * Starts scheduled campaigns that are due and continues campaigns left `sending` (large ones, or a run interrupted
   * by a restart), one chunk per transaction, for up to DISPATCH_BUDGET_MS per run.
   */
  @Scheduled('marketing.campaign-dispatch', 30, { timeoutMs: 120_000 })
  async dispatchDue(budgetMs = DISPATCH_BUDGET_MS) {
    const started = Date.now();
    const due = await this.db.withPlatform((tx) => tx.query<{ id: string; org_id: string; status: string }>(
      `select id, org_id, status from campaigns
        where (status = 'scheduled' and scheduled_at <= now()) or status = 'sending'
        order by (status = 'sending') desc, scheduled_at nulls first limit 20`));
    let sent = 0;
    for (const c of due) {
      const ctx = TenantContext.system(c.org_id, 'marketing.scheduler');
      try {
        if (c.status === 'scheduled') await this.db.withTenant(c.org_id, (tx) => this.startDispatch(tx, ctx, c.id, { resume: true }), 'marketing.scheduler');
        let done = false;
        while (!done && Date.now() - started < budgetMs) {
          done = await this.db.withTenant(c.org_id, (tx) => this.dispatchChunk(tx, ctx, c.id), 'marketing.scheduler');
        }
        if (done) sent++;
      } catch (e) {
        this.logger.warn(`campaign ${c.id}: ${(e as Error).message}`);
        await this.db.withTenant(c.org_id, (tx) => tx.query(`update campaigns set status = 'failed' where id = $1 and status in ('scheduled', 'sending')`, [c.id]), 'marketing.scheduler');
      }
      if (Date.now() - started >= budgetMs) break;
    }
    return { due: due.length, sent };
  }

  // ---------------------------------------------------------------------------
  // Ad campaigns (INT-14 / PS-14)
  // ---------------------------------------------------------------------------
  /**
   * The connection a launch uses. 'live' needs the campaign channel's live connection to be connected: one that
   * exists but is unhealthy is reported (409 with its health), never swapped for the sandbox. 'sandbox' is an
   * explicit rehearsal on the ads sandbox connection.
   */
  private async adConnection(ctx: TenantContext, channel: string, mode: 'live' | 'sandbox') {
    const rows = await this.db.scoped(ctx, (tx) => tx.query<{ id: string; provider: string; environment: string; status: string; enabled: boolean; last_error: string | null;
      health: Record<string, unknown> }>(
      `select id, provider, environment, status, enabled, last_error, health from integration_connections
        where org_id = $1 and provider = any($2::text[]) and status <> 'revoked'`, [ctx.orgId, [channel, 'ads_sandbox']]));
    if (mode === 'sandbox') {
      const sandbox = rows.find((r) => r.provider === 'ads_sandbox' && r.enabled);
      if (!sandbox) throw new DomainError('ads_sandbox_required', 'Add the ads sandbox in Integrations to rehearse a launch', 409);
      return { conn: sandbox, sandbox: true };
    }
    const live = rows.find((r) => r.provider === channel && r.environment === 'live');
    if (!live) {
      throw new DomainError('ad_account_required', `Connect a live ${channel.replace('_', ' ')} account in Integrations first (or launch explicitly in the ads sandbox to rehearse)`, 409,
        { sandboxAvailable: rows.some((r) => r.provider === 'ads_sandbox' && r.enabled) });
    }
    if (live.status !== 'connected' || !live.enabled) {
      throw new DomainError('ad_account_unhealthy', `The ${channel.replace('_', ' ')} account is ${live.enabled ? live.status : 'switched off'}; reconnect or check it in Integrations. Nothing was launched.`, 409,
        { connectionId: live.id, status: live.status, enabled: live.enabled, lastError: live.last_error, health: live.health, reconnect: '/integrations' });
    }
    return { conn: live, sandbox: false };
  }

  /**
   * Two-phase launch (PS-14): (1) under the row lock, claim the campaign ('launching' with a launch attempt: id,
   * token, connection, Idempotency-Key) and commit; (2) call the provider once, with the token in the campaign name;
   * (3) apply the result only to that attempt. A concurrent launch sees 'launching' and is refused; a retry with the
   * same Idempotency-Key gets the attempt's current state; an outcome the provider left unknown (timeout, 5xx) keeps
   * the claim, and the recovery job resolves it by the token.
   */
  async launch(ctx: TenantContext, id: string, input: { mode: 'live' | 'sandbox' } = { mode: 'live' }, idempotencyKey?: string | null) {
    if (idempotencyKey !== undefined && idempotencyKey !== null && !/^[\x21-\x7e]{8,200}$/.test(idempotencyKey)) {
      throw badRequest('invalid_idempotency_key', 'Idempotency-Key must be 8-200 printable characters');
    }
    const r0 = await this.db.scoped(ctx, (tx) => this.row(tx, ctx, id));
    if (!AD_CHANNELS.includes(r0.channel as CampaignChannel)) throw invalid('not_an_ad_campaign', 'Only ad campaigns are launched');
    if (idempotencyKey && r0.launch_idempotency_key === idempotencyKey && ['launching', 'sent'].includes(r0.status)) {
      return { ...campaignView(r0), replayed: true };
    }
    const c0 = campaignView(r0);
    if (c0.status !== 'approved') {
      if (c0.status === 'launching') throw conflict('launch_in_progress', 'This campaign is being launched; check again in a moment');
      throw new DomainError('campaign_not_approved', 'An ad campaign must be approved before launch', 409, { status: c0.status });
    }
    const found = await this.adConnection(ctx, c0.channel, input.mode);
    // Phase 1: claim under the row lock (a concurrent launch waits here, then sees 'launching').
    const claim = await this.db.scoped(ctx, async (tx) => {
      const r = await this.row(tx, ctx, id, true);
      if (idempotencyKey && r.launch_idempotency_key === idempotencyKey && ['launching', 'sent'].includes(r.status)) return null;
      if (r.status === 'launching') throw conflict('launch_in_progress', 'This campaign is being launched; check again in a moment');
      if (r.status !== 'approved') throw new DomainError('campaign_not_approved', 'An ad campaign must be approved before launch', 409, { status: r.status });
      const attempt = { id: randomUUID(), token: randomBytes(5).toString('hex') };
      await tx.query(
        `update campaigns set status = 'launching', launch_attempt_id = $2, launch_token = $3, launch_started_at = now(), launch_connection_id = $4,
            launch_mode = $5, launch_idempotency_key = $6, launch_error = null where id = $1`,
        [id, attempt.id, attempt.token, found.conn.id, found.sandbox ? 'sandbox' : 'live', idempotencyKey ?? null]);
      await this.audit.record(tx, ctx, { action: 'marketing.ad_campaign_launching', entityType: 'campaign', entityId: id,
        metadata: { provider: found.conn.provider, sandbox: found.sandbox, attempt: attempt.id } });
      return attempt;
    });
    if (!claim) return { ...(await this.get(ctx, id)), replayed: true };

    // Phase 2: one provider call.
    const adapter = adsAdapterFor(found.conn.provider)!;
    let created: { externalId: string; status: string } | null = null;
    let failure: unknown = null;
    try {
      const conn = await this.connections.loadFresh(ctx.orgId, { id: found.conn.id });
      created = await adapter.createCampaign(conn.adapter, { name: c0.name, objective: OBJECTIVE_TO_ADS[c0.objective] ?? 'traffic', dailyBudgetMinor: c0.budgetMinor,
        currency: c0.currency ?? 'EGP', idempotencyToken: claim.token });
    } catch (e) {
      failure = e;
    }
    // Phase 3: apply the outcome to this attempt only.
    if (created) return this.finishLaunch(ctx, id, claim.id, found, created);
    const definite = failure instanceof ProviderError && !failure.retryable && failure.status !== undefined && failure.status < 500;
    const message = (failure as Error)?.message ?? 'launch failed';
    await this.db.withTenant(ctx.orgId, async (tx) => {
      await this.connections.log(tx, ctx.orgId, found.conn.id, 'error', `Campaign launch failed: ${message}`, { campaignId: id, attempt: claim.id, definite });
      // A definite refusal releases the claim (nothing was created); an unknown outcome keeps it for the recovery job.
      await tx.query(
        `update campaigns set status = case when $3 then 'approved'::campaign_status else status end, launch_error = $4,
            launch_attempt_id = case when $3 then null else launch_attempt_id end
          where id = $1 and launch_attempt_id = $2`, [id, claim.id, definite, message.slice(0, 500)]);
    }, `${ctx.actorType}:${ctx.actorId}`);
    if (definite) throw new DomainError('provider_error', message, 502);
    throw new DomainError('launch_outcome_unknown', `${adapter.descriptor.name} did not answer clearly. Resuto will look for the campaign tagged [rs:${claim.token}] and finish the launch; do not create it again by hand.`, 502,
      { token: claim.token });
  }

  private async finishLaunch(ctx: TenantContext, id: string, attemptId: string, found: { conn: { id: string; provider: string }; sandbox: boolean },
    created: { externalId: string; status: string }, actor = `${ctx.actorType}:${ctx.actorId}`) {
    const adapter = adsAdapterFor(found.conn.provider)!;
    return this.db.withTenant(ctx.orgId, async (tx) => {
      const row = await tx.maybeOne(
        `update campaigns set status = 'sent', sent_at = now(), external_campaign_id = $3, is_sandbox = $4, launch_error = null,
            content = content || $5::jsonb where id = $1 and launch_attempt_id = $2 and status = 'launching' returning *`,
        [id, attemptId, created.externalId, found.sandbox, { ad: { provider: found.conn.provider, connectionId: found.conn.id, providerStatus: created.status, sandbox: found.sandbox } }]);
      if (!row) throw conflict('campaign_changed', 'The launch attempt was superseded');
      await this.audit.record(tx, ctx, { action: 'marketing.ad_campaign_launched', entityType: 'campaign', entityId: id,
        metadata: { provider: found.conn.provider, sandbox: found.sandbox, externalId: created.externalId } });
      return { ...campaignView(row), note: found.sandbox ? 'Sandbox launch: recorded in Resuto only; nothing was published and no money is spent.'
        : `Created ${created.status} in ${adapter.descriptor.name}. Complete ad sets and creatives there to start delivery.` };
    }, actor);
  }

  /**
   * Resolves launches whose provider outcome was unknown (PS-14): looks the campaign up by its launch token where the
   * provider supports it (Meta) and finishes the launch; otherwise leaves it 'launching' with a note for the owner.
   */
  @Scheduled('marketing.launch-recovery', 300)
  async recoverLaunches(now = new Date(), scope: { orgId?: string } = {}) {
    const rows = await this.db.withPlatform((tx) => tx.query<{ id: string; org_id: string; launch_attempt_id: string; launch_token: string; launch_connection_id: string | null;
      launch_mode: string }>(
      `select id, org_id, launch_attempt_id, launch_token, launch_connection_id, launch_mode from campaigns
        where status = 'launching' and launch_started_at < $1::timestamptz - interval '2 minutes' and ($2::uuid is null or org_id = $2::uuid)
        order by launch_started_at limit 20`, [now, scope.orgId ?? null]));
    let recovered = 0, unresolved = 0;
    for (const r of rows) {
      const ctx = TenantContext.system(r.org_id, 'marketing.launch-recovery');
      try {
        if (!r.launch_connection_id) { unresolved++; continue; }
        const conn = await this.connections.loadFresh(r.org_id, { id: r.launch_connection_id });
        const adapter = adsAdapterFor(conn.provider);
        const hit = adapter?.findCampaignByToken ? await adapter.findCampaignByToken(conn.adapter, r.launch_token) : null;
        if (hit) {
          await this.finishLaunch(ctx, r.id, r.launch_attempt_id, { conn: { id: conn.id, provider: conn.provider }, sandbox: r.launch_mode === 'sandbox' }, hit, 'marketing.launch-recovery');
          recovered++;
        } else {
          await this.db.withTenant(r.org_id, (tx) => tx.query(`update campaigns set launch_error = $2 where id = $1 and launch_attempt_id = $3`,
            [r.id, `Outcome unknown: check ${adapter?.descriptor.name ?? conn.provider} for a campaign tagged [rs:${r.launch_token}]. If there is none, clear the launch and try again.`, r.launch_attempt_id]),
          'marketing.launch-recovery');
          unresolved++;
        }
      } catch (e) {
        this.logger.warn(`launch recovery ${r.id}: ${(e as Error).message}`);
        unresolved++;
      }
    }
    return { checked: rows.length, recovered, unresolved };
  }

  /** The owner confirmed no campaign tagged with the launch token exists at the provider: release the claim. */
  resetLaunch(ctx: TenantContext, id: string) {
    return this.db.scoped(ctx, async (tx) => {
      const r = await this.row(tx, ctx, id, true);
      if (r.status !== 'launching') throw conflict('not_launching', 'This campaign is not being launched');
      if (Date.now() - new Date(r.launch_started_at).getTime() < 2 * 60_000) throw conflict('launch_in_progress', 'This launch is still running; wait a few minutes');
      const row = await tx.one(`update campaigns set status = 'approved', launch_attempt_id = null, launch_error = null where id = $1 returning *`, [id]);
      await this.audit.record(tx, ctx, { action: 'marketing.ad_campaign_launch_reset', entityType: 'campaign', entityId: id, metadata: { token: r.launch_token } });
      return campaignView(row);
    });
  }
  /** Imports provider reporting into ad_campaign_reports (sandbox rows are flagged and excluded from cost). */
  async syncInsights(ctx: TenantContext, id: string, range: { since: string; until: string }) {
    const c = await this.get(ctx, id);
    const ad = (c.content as any)?.ad;
    if (!c.externalCampaignId || !ad?.connectionId) throw conflict('not_launched', 'Launch the campaign before importing results');
    const adapter = adsAdapterFor(ad.provider)!;
    const conn = await this.connections.load(ctx.orgId, { id: ad.connectionId });
    let rows;
    try {
      rows = await adapter.fetchInsights(conn.adapter, { externalCampaignId: c.externalCampaignId, since: range.since, until: range.until, currency: c.currency ?? 'EGP' });
    } catch (e) {
      throw new DomainError('provider_error', e instanceof ProviderError ? e.message : 'Insights import failed', 502);
    }
    const sandbox = adapter.descriptor.readiness === 'simulated';
    return this.db.scoped(ctx, async (tx) => {
      for (const r of rows) {
        await tx.query(
          `insert into ad_campaign_reports(org_id, connection_id, campaign_id, provider, external_campaign_id, report_date, impressions, clicks, spend_minor, currency, conversions, is_sandbox)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           on conflict (provider, external_campaign_id, report_date) do update set impressions = excluded.impressions, clicks = excluded.clicks,
             spend_minor = excluded.spend_minor, conversions = excluded.conversions, imported_at = now()`,
          [ctx.orgId, ad.connectionId, id, c.channel, r.externalCampaignId, r.date, r.impressions, r.clicks, r.spendMinor, r.currency, r.conversions, sandbox]);
      }
      await this.audit.record(tx, ctx, { action: 'marketing.ad_insights_imported', entityType: 'campaign', entityId: id, metadata: { rows: rows.length, sandbox } });
      return { imported: rows.length, sandbox };
    });
  }

  // ---------------------------------------------------------------------------
  // Attribution report (last touch)
  // ---------------------------------------------------------------------------
  report(ctx: TenantContext, id: string): Promise<CampaignReport & { orderValueMinor: number; adReports: unknown[] }> {
    return this.db.scoped(ctx, async (tx) => {
      const c = await this.row(tx, ctx, id);
      const clicks = await tx.one<{ n: number }>(`select count(*)::int as n from attribution_events where campaign_id = $1 and kind = 'link_click'`, [id]);
      const d = await tx.one<any>(
        `select count(*) filter (where status in ('sent', 'delivered', 'read'))::int as sent, count(*) filter (where status in ('delivered', 'read'))::int as delivered,
                count(*) filter (where status = 'read')::int as read, count(*) filter (where status = 'failed')::int as failed,
                count(*) filter (where status = 'skipped_no_consent')::int as skipped from campaign_deliveries where campaign_id = $1`, [id]);
      const o = await tx.one<any>(
        `select count(*)::int as orders, coalesce(sum(paid_minor - refunded_minor), 0)::bigint as revenue, coalesce(sum(total_minor), 0)::bigint as value
           from orders where org_id = $1 and campaign_id = $2 and status <> 'cancelled'`, [ctx.orgId, id]);
      const cost = await tx.one<any>(
        `select coalesce(sum(spend_minor) filter (where not is_sandbox), 0)::bigint as cost, count(*) filter (where is_sandbox)::int as sandbox_rows
           from ad_campaign_reports where campaign_id = $1`, [id]);
      const adReports = await tx.query(`select report_date, provider, impressions, clicks, spend_minor, currency, conversions, is_sandbox from ad_campaign_reports
          where campaign_id = $1 order by report_date`, [id]);
      const revenue = Number(o.revenue), costMinor = Number(cost.cost);
      return {
        campaignId: id, model: 'last_touch', disclaimer: ATTRIBUTION_DISCLAIMER, currency: c.currency,
        clicks: clicks.n, messages: { sent: d.sent, delivered: d.delivered, read: d.read, failed: d.failed, skippedNoConsent: d.skipped },
        orders: o.orders, revenueMinor: revenue, orderValueMinor: Number(o.value), costMinor, sandboxRowsExcluded: cost.sandbox_rows,
        roas: costMinor > 0 ? Math.round((revenue / costMinor) * 100) / 100 : null, isSandbox: c.is_sandbox,
        adReports: adReports.map((r) => ({ date: r.report_date, provider: r.provider, impressions: Number(r.impressions), clicks: Number(r.clicks),
          spendMinor: Number(r.spend_minor), currency: r.currency, conversions: r.conversions, isSandbox: r.is_sandbox })),
      };
    });
  }

  deliveries(ctx: TenantContext, id: string, q: { limit: number; cursor?: string }) {
    // Latest sends first; not yet sent (null) last, as before; ties on the delivery id.
    const sent = `coalesce(d.sent_at, 'epoch'::timestamptz)`;
    const k = keyset(q.cursor);
    return this.db.scoped(ctx, async (tx) => {
      await this.row(tx, ctx, id);
      const rows = await tx.query(`select d.id, d.customer_id, c.display_name, d.status, d.error, d.sent_at, d.message_id, ${cursorAt(sent)} as cursor_at
           from campaign_deliveries d join customers c on c.id = d.customer_id
          where d.campaign_id = $1 ${k.after(sent, 'd.id', 2)} order by ${sent} desc, d.id desc limit ${k.fetch(q.limit)}`, [id, ...k.params]);
      return pageOf(rows, q.limit, (r) => ({ at: r.cursor_at, id: r.id }), (r) => ({ id: r.id, customerId: r.customer_id, name: r.display_name,
        status: r.status, error: r.error, sentAt: iso(r.sent_at), messageId: r.message_id }));
    });
  }
}
