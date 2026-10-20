import { Injectable, Logger } from '@nestjs/common';
import {
  AD_CHANNELS, ATTRIBUTION_DISCLAIMER, MESSAGE_CHANNELS, type CampaignChannel, type CampaignInput, type CampaignReport,
} from '@resuto/contracts';
import { adsAdapterFor, ProviderError, type AdsObjective } from '@resuto/integrations';
import { randomBytes } from 'node:crypto';
import { TenantContext } from '../../common/auth/context';
import { DbService, type Tx } from '../../common/db/db.service';
import { DomainError, conflict, invalid, notFound } from '../../common/errors/domain-error';
import { Scheduled } from '../../common/events/events';
import { AuditService } from '../../common/platform/audit.service';
import { OutboxService } from '../../common/platform/outbox.service';
import type { CampaignsPort } from '../kernel/ports';
import { MessagingService } from '../connect/messaging.service';
import { IntegrationConnectionsService } from '../integrations/connections.service';
import { SegmentsService } from './segments.service';

const iso = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString() : null);
const MAX_RECIPIENTS = 5000;
/** Recipients handled per transaction (PCL-11); the first chunk runs in the request, the dispatcher job does the rest. */
export const CAMPAIGN_CHUNK = 200;
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

  list(ctx: TenantContext, status?: string) {
    return this.db.scoped(ctx, async (tx) => ({
      items: (await tx.query(`select * from campaigns where org_id = $1 and ($2::campaign_status is null or status = $2) order by created_at desc limit 200`,
        [ctx.orgId, status ?? null])).map(campaignView),
      nextCursor: null,
    }));
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
   */
  async sendNow(ctx: TenantContext, id: string) {
    const actor = `${ctx.actorType}:${ctx.actorId}`;
    await this.db.withTenant(ctx.orgId, (tx) => this.startDispatch(tx, ctx, id), actor);
    await this.db.withTenant(ctx.orgId, (tx) => this.dispatchChunk(tx, ctx, id), actor);
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
    if (r.channel !== 'whatsapp') {
      throw new DomainError('channel_unavailable', r.channel === 'sms' || r.channel === 'email'
        ? `No ${r.channel.toUpperCase()} provider is integrated yet; this campaign cannot be sent` : 'Ad campaigns are launched, not sent', 409);
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
    const r = await tx.maybeOne<any>(`select id, status, content, utm_campaign from campaigns where id = $1 and org_id = $2 for update`, [id, ctx.orgId]);
    if (!r || r.status !== 'sending') return true;
    const members = await tx.query<{ customer_id: string; marketing_consent: boolean }>(
      `select m.customer_id, c.marketing_consent from campaign_recipients m join customers c on c.id = m.customer_id
        where m.campaign_id = $1 and not exists (select 1 from campaign_deliveries d where d.campaign_id = $1 and d.customer_id = m.customer_id)
        order by m.customer_id limit $2`, [id, CAMPAIGN_CHUNK]);
    const variables = Object.fromEntries((r.content?.variables ?? []).map((v: string, i: number) => [String(i + 1), v]));
    for (const m of members) {
      if (!m.marketing_consent) {
        await tx.query(`insert into campaign_deliveries(org_id, campaign_id, customer_id, status) values ($1, $2, $3, 'skipped_no_consent')`, [ctx.orgId, id, m.customer_id]);
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

  /** Delivery counts from the recorded deliveries (exact across chunks, runs and restarts). */
  private async deliverySummary(tx: Tx, id: string) {
    const c = await tx.one<any>(
      `select count(*)::int as handled,
              count(*) filter (where d.message_id is not null)::int as queued,
              count(*) filter (where d.status = 'skipped_no_consent')::int as skipped,
              count(*) filter (where d.message_id is null and d.status = 'failed')::int as failed,
              count(*) filter (where coalesce((m.payload->>'sandbox')::boolean, false) and d.message_id is not null)::int as sandbox,
              count(*) filter (where not coalesce((m.payload->>'sandbox')::boolean, false) and d.message_id is not null)::int as live,
              (select count(*)::int from campaign_recipients cr
                where cr.campaign_id = $1 and not exists (select 1 from campaign_deliveries x where x.campaign_id = $1 and x.customer_id = cr.customer_id)) as pending
         from campaign_deliveries d left join messages m on m.id = d.message_id where d.campaign_id = $1`, [id]);
    return { recipients: c.handled + c.pending, queued: c.queued, skippedNoConsent: c.skipped, failed: c.failed, sandbox: c.sandbox, live: c.live,
      pending: c.pending };
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
    if (r.channel !== 'whatsapp') throw invalid('channel_unavailable', 'Only WhatsApp campaigns can be sent through this port');
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
  // Ad campaigns
  // ---------------------------------------------------------------------------
  private async adConnection(ctx: TenantContext, channel: string) {
    const rows = await this.db.scoped(ctx, (tx) => tx.query<{ id: string; provider: string; environment: string; status: string }>(
      `select id, provider, environment, status from integration_connections where org_id = $1 and enabled and provider = any($2::text[]) and status <> 'revoked'`,
      [ctx.orgId, [channel, 'ads_sandbox']]));
    const live = rows.find((r) => r.provider === channel && r.environment === 'live' && r.status === 'connected');
    if (live) return { conn: live, sandbox: false };
    const sandbox = rows.find((r) => r.provider === 'ads_sandbox');
    if (sandbox) return { conn: sandbox, sandbox: true };
    return null;
  }

  async launch(ctx: TenantContext, id: string) {
    const c = await this.get(ctx, id);
    if (!AD_CHANNELS.includes(c.channel as CampaignChannel)) throw invalid('not_an_ad_campaign', 'Only ad campaigns are launched');
    if (c.status !== 'approved') throw new DomainError('campaign_not_approved', 'An ad campaign must be approved before launch', 409, { status: c.status });
    const found = await this.adConnection(ctx, c.channel);
    if (!found) {
      throw new DomainError('ad_account_required', `Connect a live ${c.channel.replace('_', ' ')} account (or the ads sandbox) in Integrations first`, 409);
    }
    const adapter = adsAdapterFor(found.conn.provider)!;
    const conn = await this.connections.load(ctx.orgId, { id: found.conn.id });
    let created;
    try {
      created = await adapter.createCampaign(conn.adapter, { name: c.name, objective: OBJECTIVE_TO_ADS[c.objective] ?? 'traffic', dailyBudgetMinor: c.budgetMinor, currency: c.currency ?? 'EGP' });
    } catch (e) {
      await this.db.withTenant(ctx.orgId, (tx) => this.connections.log(tx, ctx.orgId, found.conn.id, 'error', `Campaign launch failed: ${(e as Error).message}`, { campaignId: id }));
      throw new DomainError('provider_error', e instanceof ProviderError ? e.message : 'Launch failed', 502);
    }
    return this.db.scoped(ctx, async (tx) => {
      const r = await this.row(tx, ctx, id, true);
      if (r.status !== 'approved') throw conflict('campaign_changed', 'The campaign changed during launch');
      const row = await tx.one(
        `update campaigns set status = 'sent', sent_at = now(), external_campaign_id = $2, is_sandbox = $3,
            content = content || $4::jsonb where id = $1 returning *`,
        [id, created.externalId, found.sandbox, { ad: { provider: found.conn.provider, connectionId: found.conn.id, providerStatus: created.status, sandbox: found.sandbox } }]);
      await this.audit.record(tx, ctx, { action: 'marketing.ad_campaign_launched', entityType: 'campaign', entityId: id,
        metadata: { provider: found.conn.provider, sandbox: found.sandbox, externalId: created.externalId } });
      return { ...campaignView(row), note: found.sandbox ? 'Sandbox launch: recorded in Resuto only; nothing was published and no money is spent.'
        : `Created ${created.status} in ${adapter.descriptor.name}. Complete ad sets and creatives there to start delivery.` };
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

  deliveries(ctx: TenantContext, id: string) {
    return this.db.scoped(ctx, async (tx) => {
      await this.row(tx, ctx, id);
      const rows = await tx.query(`select d.id, d.customer_id, c.display_name, d.status, d.error, d.sent_at, d.message_id from campaign_deliveries d
          join customers c on c.id = d.customer_id where d.campaign_id = $1 order by d.sent_at desc nulls last limit 500`, [id]);
      return { items: rows.map((r) => ({ id: r.id, customerId: r.customer_id, name: r.display_name, status: r.status, error: r.error, sentAt: iso(r.sent_at), messageId: r.message_id })), nextCursor: null };
    });
  }
}
