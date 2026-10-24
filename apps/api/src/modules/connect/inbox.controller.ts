import { Body, Controller, Delete, Get, Header, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import {
  conversationTagInput, conversationTagUpdate, fullListQuery, internalNoteInput, internalNoteListQuery, savedReplyInput, savedReplyListQuery,
  savedReplyUpdate,
} from '@resuto/contracts';
import type { z } from 'zod';
import type { TenantContext } from '../../common/auth/context';
import { RequiresModule, RequirePermission, Tenant } from '../../common/auth/decorators';
import { zod } from '../../common/http/zod.pipe';
import { InboxService } from './inbox.service';

/**
 * 21-INBOX (plan §6.5): internal notes, conversation tags and saved replies. Same permissions as the inbox: reading
 * needs connect:read, writing a note or tagging a conversation connect:reply (whoever may answer the customer), and
 * the tag vocabulary and saved replies are managed with connect:manage (as message templates are).
 */
@Controller('o/:orgId/connect')
@RequiresModule('connect')
export class InboxController {
  constructor(private readonly inbox: InboxService) {}

  // Internal notes -------------------------------------------------------------
  /** Staff-only note on a conversation: never sent to the customer, does not touch unread state or the 24-hour window. */
  @Post('conversations/:id/notes')
  @RequirePermission('connect:reply')
  addNote(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body(zod(internalNoteInput)) body: z.infer<typeof internalNoteInput>) {
    return this.inbox.addNote(ctx, id, body);
  }

  @Get('conversations/:id/notes')
  @RequirePermission('connect:read')
  @Header('X-Resuto-List', 'full')
  notes(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Query(zod(internalNoteListQuery)) q: z.infer<typeof internalNoteListQuery>) {
    return this.inbox.listNotes(ctx, id, q);
  }

  // Tags -------------------------------------------------------------------------
  @Get('tags')
  @RequirePermission('connect:read')
  @Header('X-Resuto-List', 'full')
  tags(@Tenant() ctx: TenantContext, @Query(zod(fullListQuery)) q: z.infer<typeof fullListQuery>) {
    return this.inbox.listTags(ctx, q);
  }

  @Post('tags')
  @RequirePermission('connect:manage')
  createTag(@Tenant() ctx: TenantContext, @Body(zod(conversationTagInput)) body: z.infer<typeof conversationTagInput>) {
    return this.inbox.createTag(ctx, body);
  }

  @Patch('tags/:tagId')
  @RequirePermission('connect:manage')
  updateTag(@Tenant() ctx: TenantContext, @Param('tagId', ParseUUIDPipe) tagId: string, @Body(zod(conversationTagUpdate)) body: z.infer<typeof conversationTagUpdate>) {
    return this.inbox.updateTag(ctx, tagId, body);
  }

  @Delete('tags/:tagId')
  @RequirePermission('connect:manage')
  deleteTag(@Tenant() ctx: TenantContext, @Param('tagId', ParseUUIDPipe) tagId: string) {
    return this.inbox.deleteTag(ctx, tagId);
  }

  /** Idempotent assignment. */
  @Put('conversations/:id/tags/:tagId')
  @RequirePermission('connect:reply')
  assignTag(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Param('tagId', ParseUUIDPipe) tagId: string) {
    return this.inbox.assignTag(ctx, id, tagId);
  }

  @Delete('conversations/:id/tags/:tagId')
  @RequirePermission('connect:reply')
  removeTag(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Param('tagId', ParseUUIDPipe) tagId: string) {
    return this.inbox.removeTag(ctx, id, tagId);
  }

  // Saved replies -----------------------------------------------------------------
  @Get('saved-replies')
  @RequirePermission('connect:read')
  @Header('X-Resuto-List', 'full')
  replies(@Tenant() ctx: TenantContext, @Query(zod(savedReplyListQuery)) q: z.infer<typeof savedReplyListQuery>) {
    return this.inbox.listReplies(ctx, q);
  }

  @Post('saved-replies')
  @RequirePermission('connect:manage')
  createReply(@Tenant() ctx: TenantContext, @Body(zod(savedReplyInput)) body: z.infer<typeof savedReplyInput>) {
    return this.inbox.createReply(ctx, body);
  }

  @Patch('saved-replies/:replyId')
  @RequirePermission('connect:manage')
  updateReply(@Tenant() ctx: TenantContext, @Param('replyId', ParseUUIDPipe) replyId: string, @Body(zod(savedReplyUpdate)) body: z.infer<typeof savedReplyUpdate>) {
    return this.inbox.updateReply(ctx, replyId, body);
  }

  @Delete('saved-replies/:replyId')
  @RequirePermission('connect:manage')
  deleteReply(@Tenant() ctx: TenantContext, @Param('replyId', ParseUUIDPipe) replyId: string) {
    return this.inbox.deleteReply(ctx, replyId);
  }
}
