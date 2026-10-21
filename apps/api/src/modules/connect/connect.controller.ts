import { Body, Controller, Delete, Get, Header, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import {
  connectSandboxInbound, createMessagingChannel, fullListQuery, inboxAssignConversation, inboxConversationFilters, inboxHandoffRequest, inboxStaffReply,
  messageTemplateInput, messageTemplateUpdate, updateMessagingChannel, whatsappEmbeddedSignup,
} from '@resuto/contracts';
import { z } from 'zod';
import type { TenantContext } from '../../common/auth/context';
import { RequiresModule, RequirePermission, Tenant } from '../../common/auth/decorators';
import { RequireMfa } from '../../common/auth/mfa.guard';
import { DbService } from '../../common/db/db.service';
import { conflict, notFound } from '../../common/errors/domain-error';
import { AuditService } from '../../common/platform/audit.service';
import { zod } from '../../common/http/zod.pipe';
import { ChannelsService } from './channels.service';
import { ConversationsService } from './conversations.service';
import { OrderingService } from './ordering.service';
import { WhatsAppSignupService } from './whatsapp-signup.service';

@Controller('o/:orgId/connect')
@RequiresModule('connect')
export class ConnectController {
  constructor(
    private readonly channels: ChannelsService,
    private readonly conversations: ConversationsService,
    private readonly ordering: OrderingService,
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly signup: WhatsAppSignupService,
  ) {}

  // Channels -----------------------------------------------------------------
  @Get('channels')
  @RequirePermission('connect:read')
  @Header('X-Resuto-List', 'full')
  listChannels(@Tenant() ctx: TenantContext, @Query(zod(fullListQuery)) q: z.infer<typeof fullListQuery>) {
    return this.channels.list(ctx, q);
  }

  @Post('channels')
  @RequirePermission('connect:manage')
  createChannel(@Tenant() ctx: TenantContext, @Body(zod(createMessagingChannel)) body: z.infer<typeof createMessagingChannel>) {
    return this.channels.create(ctx, body);
  }

  @Patch('channels/:id')
  @RequirePermission('connect:manage')
  updateChannel(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body(zod(updateMessagingChannel)) body: z.infer<typeof updateMessagingChannel>) {
    return this.channels.update(ctx, id, body);
  }

  /** INT-03: re-proves ownership through the Graph API (pre-INT-03 channels, token changes, webhook subscription retry). */
  @HttpCode(200)
  @Post('channels/:id/verify')
  @RequirePermission('connect:manage')
  verifyChannel(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.channels.verify(ctx, id);
  }

  /** INT-13: what the Embedded Signup launcher needs (app id, configuration id, SDK URL) and what is still missing. */
  @Get('whatsapp/embedded-signup')
  @RequirePermission('connect:manage')
  signupConfig() {
    return this.signup.config();
  }

  /** INT-13: completes Embedded Signup (code exchange, ownership proof, webhook subscription, registration). */
  @Post('whatsapp/embedded-signup')
  @RequireMfa()   // AUTH-02: stores (and replaces) the WhatsApp Business access token
  @RequirePermission('connect:manage')
  signupComplete(@Tenant() ctx: TenantContext, @Body(zod(whatsappEmbeddedSignup)) body: z.infer<typeof whatsappEmbeddedSignup>) {
    return this.signup.complete(ctx, body);
  }

  // Inbox --------------------------------------------------------------------
  @Get('conversations')
  @RequirePermission('connect:read')
  list(@Tenant() ctx: TenantContext, @Query(zod(inboxConversationFilters)) q: z.infer<typeof inboxConversationFilters>) {
    return this.conversations.list(ctx, q);
  }

  @Get('conversations/:id')
  @RequirePermission('connect:read')
  detail(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.conversations.detail(ctx, id);
  }

  @HttpCode(200)
  @Post('conversations/:id/read')
  @RequirePermission('connect:read')
  read(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.conversations.markRead(ctx, id);
  }

  @Post('conversations/:id/reply')
  @RequirePermission('connect:reply')
  reply(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body(zod(inboxStaffReply)) body: z.infer<typeof inboxStaffReply>) {
    return this.conversations.reply(ctx, id, body);
  }

  @Post('conversations/:id/handoff')
  @RequirePermission('connect:reply')
  handoff(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body(zod(inboxHandoffRequest)) body: z.infer<typeof inboxHandoffRequest>) {
    return this.conversations.takeOver(ctx, id, body.reason);
  }

  @HttpCode(200)
  @Post('conversations/:id/handoff/resolve')
  @RequirePermission('connect:reply')
  resolveHandoff(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.conversations.resolveHandoff(ctx, id);
  }

  /** Team members who can take a conversation (role with connect:reply). */
  @Get('assignees')
  @RequirePermission('connect:read')
  assignees(@Tenant() ctx: TenantContext) {
    return this.conversations.assignees(ctx);
  }

  /** Resend a failed outbound message (FT-12): window/template rules apply again; a non-failed message is left as is. */
  @HttpCode(200)
  @Post('messages/:id/resend')
  @RequirePermission('connect:reply')
  resend(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.conversations.resendMessage(ctx, id);
  }

  @HttpCode(200)
  @Post('conversations/:id/assign')
  @RequirePermission('connect:manage')
  assign(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body(zod(inboxAssignConversation)) body: z.infer<typeof inboxAssignConversation>) {
    return this.conversations.assign(ctx, id, body.userId);
  }

  @HttpCode(200)
  @Post('conversations/:id/close')
  @RequirePermission('connect:reply')
  close(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.conversations.setClosed(ctx, id, true);
  }

  @HttpCode(200)
  @Post('conversations/:id/reopen')
  @RequirePermission('connect:reply')
  reopen(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.conversations.setClosed(ctx, id, false);
  }

  /** Staff cancels the customer's live ordering session (e.g. on request during a handoff). */
  @HttpCode(200)
  @Post('conversations/:id/ordering/cancel')
  @RequirePermission('connect:reply')
  cancelOrdering(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.scoped(ctx, async (tx) => {
      const c = await tx.maybeOne<{ branch_id: string | null }>(`select branch_id from conversations where id = $1 and org_id = $2`, [id, ctx.orgId]);
      if (!c) throw notFound('Conversation');
      ctx.assertBranch(c.branch_id);
      const s = await tx.maybeOne<any>(`select * from ordering_sessions where conversation_id = $1 and step not in ('completed', 'cancelled', 'expired') for update`, [id]);
      if (!s) throw conflict('no_live_session', 'There is no ordering session in progress');
      await this.ordering.cancelSession(tx, ctx, s, 'staff');
      await this.audit.record(tx, ctx, { action: 'connect.ordering_cancelled', entityType: 'ordering_session', entityId: s.id, branchId: c.branch_id });
      return { sessionId: s.id, step: 'cancelled' };
    });
  }

  // Sandbox simulator ----------------------------------------------------------
  /** Injects an inbound customer message into a SANDBOX channel (testing/demo; never reaches Meta). */
  @HttpCode(200)
  @Post('sandbox/inbound')
  @RequirePermission('connect:manage')
  simulate(@Tenant() ctx: TenantContext, @Body(zod(connectSandboxInbound)) body: z.infer<typeof connectSandboxInbound>) {
    return this.conversations.simulate(ctx, body);
  }

  // Templates ------------------------------------------------------------------
  @Get('templates')
  @RequirePermission('connect:read')
  @Header('X-Resuto-List', 'full')
  templates(@Tenant() ctx: TenantContext, @Query(zod(fullListQuery)) q: z.infer<typeof fullListQuery>) {
    return this.channels.listTemplates(ctx, q);
  }

  @Post('templates')
  @RequirePermission('connect:manage')
  createTemplate(@Tenant() ctx: TenantContext, @Body(zod(messageTemplateInput)) body: z.infer<typeof messageTemplateInput>) {
    return this.channels.createTemplate(ctx, body);
  }

  @Patch('templates/:id')
  @RequirePermission('connect:manage')
  updateTemplate(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body(zod(messageTemplateUpdate)) body: z.infer<typeof messageTemplateUpdate>) {
    return this.channels.updateTemplate(ctx, id, body);
  }

  @Delete('templates/:id')
  @RequirePermission('connect:manage')
  deleteTemplate(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.channels.deleteTemplate(ctx, id);
  }

  @HttpCode(200)
  @Post('templates/:id/submit')
  @RequirePermission('connect:manage')
  submitTemplate(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.channels.submitTemplate(ctx, id);
  }
}
