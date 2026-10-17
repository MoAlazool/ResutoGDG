import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import {
  assistantMessageInput, churnQuery, forecastQuery, generateCopyInput, insightStatusInput, insightsQuery, recommendationsQuery,
  routePlanInput, segmentKey, segmentMembersQuery, type AssistantMessageInput, type GenerateCopyInput, type RoutePlanInput,
} from '@resuto/contracts';
import { z } from 'zod';
import type { TenantContext } from '../../common/auth/context';
import { AllowMcp, RequirePermission, RequiresModule, Tenant } from '../../common/auth/decorators';
import { DbService } from '../../common/db/db.service';
import { forbidden, notFound } from '../../common/errors/domain-error';
import { zod } from '../../common/http/zod.pipe';
import { AiServiceClient } from './ai-client.service';
import { AssistantService } from './assistant.service';
import { CopyService } from './copy.service';
import { InsightsService } from './insights.service';
import { IntelligenceService } from './intelligence.service';
import { ModelRegistryService } from './registry.service';

const idemKey = z.string().min(8).max(200).optional();

@Controller('o/:orgId/intelligence')
@RequiresModule('intelligence')
export class IntelligenceController {
  constructor(
    private readonly intelligence: IntelligenceService,
    private readonly insights: InsightsService,
    private readonly assistant: AssistantService,
    private readonly copy: CopyService,
    private readonly registry: ModelRegistryService,
    private readonly ai: AiServiceClient,
    private readonly db: DbService,
  ) {}

  @Get('status')
  @RequirePermission('ai:use')
  async status() {
    return {
      aiService: { configured: this.ai.configured, ...(await this.ai.health()) },
      assistant: { mode: this.assistant.mode },
      copy: { mode: this.assistant.mode === 'gemini' ? 'gemini' : 'template' },
    };
  }

  @Get('forecast')
  @AllowMcp()
  @RequirePermission('ai:use')
  forecast(@Tenant() ctx: TenantContext, @Query(zod(forecastQuery)) q: z.infer<typeof forecastQuery>) {
    return this.intelligence.forecast(ctx, q);
  }

  @Get('segments')
  @AllowMcp()
  @RequirePermission('ai:use')
  segments(@Tenant() ctx: TenantContext) {
    return this.intelligence.segments(ctx);
  }

  @Get('segments/:segment/customers')
  @RequirePermission('ai:use', 'customers:read')
  members(@Tenant() ctx: TenantContext, @Param('segment', zod(segmentKey)) segment: z.infer<typeof segmentKey>,
    @Query(zod(segmentMembersQuery)) q: z.infer<typeof segmentMembersQuery>) {
    return this.intelligence.segmentMembers(ctx, segment, q.limit, q.cursor ?? 0);
  }

  @Get('churn')
  @RequirePermission('ai:use', 'customers:read')
  churn(@Tenant() ctx: TenantContext, @Query(zod(churnQuery)) q: z.infer<typeof churnQuery>) {
    return this.intelligence.churn(ctx, q.limit, q.windowDays);
  }

  @Get('recommendations')
  @AllowMcp()
  @RequirePermission('ai:use')
  recommendations(@Tenant() ctx: TenantContext, @Query(zod(recommendationsQuery)) q: z.infer<typeof recommendationsQuery>) {
    if (q.customerId) ctx.require('customers:read');
    return this.intelligence.recommendations(ctx, q);
  }

  /** Drivers with open delivery jobs at a branch (read model over D2's tables, for the route planner). */
  @Get('routes/drivers')
  @RequirePermission('ai:use', 'delivery:dispatch')
  drivers(@Tenant() ctx: TenantContext, @Query('branchId', ParseUUIDPipe) branchId: string) {
    ctx.assertBranch(branchId);
    return this.db.scoped(ctx, async (tx) => ({
      items: (await tx.query<any>(
        `select d.id, d.display_name, d.availability, count(j.id)::int as open_jobs from drivers d
           join delivery_jobs j on j.driver_id = d.id and j.branch_id = $2 and j.status in ('assigned', 'accepted', 'picked_up', 'en_route')
          where d.org_id = $1 group by d.id order by count(j.id) desc, d.display_name limit 100`, [ctx.orgId, branchId]))
        .map((d) => ({ id: d.id, displayName: d.display_name, availability: d.availability, openJobs: d.open_jobs })),
      nextCursor: null,
    }));
  }

  @Post('routes/plan')
  @RequirePermission('ai:use', 'delivery:dispatch')
  routePlan(@Tenant() ctx: TenantContext, @Body(zod(routePlanInput)) body: RoutePlanInput) {
    return this.intelligence.routePlan(ctx, body);
  }

  @Get('insights')
  @AllowMcp()
  @RequirePermission('ai:use')
  listInsights(@Tenant() ctx: TenantContext, @Query(zod(insightsQuery)) q: z.infer<typeof insightsQuery>) {
    return this.insights.list(ctx, q);
  }

  @Patch('insights/:insightId')
  @RequirePermission('ai:use')
  setInsightStatus(@Tenant() ctx: TenantContext, @Param('insightId', ParseUUIDPipe) id: string,
    @Body(zod(insightStatusInput)) body: z.infer<typeof insightStatusInput>) {
    return this.insights.setStatus(ctx, id, body.status);
  }

  /** Runs the insight rules for this restaurant now (deduplicated, safe to retry). */
  @Post('insights/refresh')
  @RequirePermission('ai:use')
  refreshInsights(@Tenant() ctx: TenantContext) {
    return this.insights.generateForOrg(ctx);
  }

  @Post('assistant')
  @RequirePermission('ai:use')
  ask(@Tenant() ctx: TenantContext, @Body(zod(assistantMessageInput)) body: AssistantMessageInput,
    @Headers('idempotency-key') key?: string) {
    return this.assistant.ask(ctx, body, idemKey.parse(key));
  }

  @Get('assistant/threads')
  @RequirePermission('ai:use')
  threads(@Tenant() ctx: TenantContext) {
    if (!ctx.userId) throw forbidden();
    return this.db.scoped(ctx, async (tx) => ({
      items: (await tx.query<any>(
        `select t.id, t.title, t.created_at, max(m.created_at) as last_message_at from assistant_threads t
           left join assistant_messages m on m.thread_id = t.id
          where t.org_id = $1 and t.user_id = $2 group by t.id order by coalesce(max(m.created_at), t.created_at) desc limit 50`,
        [ctx.orgId, ctx.userId])).map((t) => ({ id: t.id, title: t.title, createdAt: new Date(t.created_at).toISOString(),
        lastMessageAt: t.last_message_at ? new Date(t.last_message_at).toISOString() : null })),
      nextCursor: null,
    }));
  }

  @Get('assistant/threads/:threadId/messages')
  @RequirePermission('ai:use')
  messages(@Tenant() ctx: TenantContext, @Param('threadId', ParseUUIDPipe) threadId: string) {
    if (!ctx.userId) throw forbidden();
    return this.db.scoped(ctx, async (tx) => {
      const t = await tx.maybeOne('select id from assistant_threads where id = $1 and org_id = $2 and user_id = $3', [threadId, ctx.orgId, ctx.userId]);
      if (!t) throw notFound('Conversation');
      const rows = await tx.query<any>(
        `select id, role, content, tool_calls, provider, created_at from assistant_messages where thread_id = $1 order by created_at, id limit 200`, [threadId]);
      return { items: rows.map((r) => ({ id: r.id, role: r.role, content: r.content, toolCalls: r.tool_calls, provider: r.provider,
        createdAt: new Date(r.created_at).toISOString() })), nextCursor: null };
    });
  }

  @Post('generate-copy')
  @RequirePermission('ai:use')
  generateCopy(@Tenant() ctx: TenantContext, @Body(zod(generateCopyInput)) body: GenerateCopyInput) {
    return this.copy.generate(ctx, body);
  }

  @Get('research')
  @RequirePermission('ai:use')
  research(@Tenant() ctx: TenantContext) {
    return this.registry.research(ctx);
  }
}
