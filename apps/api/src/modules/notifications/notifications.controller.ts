import { Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { notificationsQuery } from '@resuto/contracts';
import type { z } from 'zod';
import type { TenantContext } from '../../common/auth/context';
import { Tenant } from '../../common/auth/decorators';
import { zod } from '../../common/http/zod.pipe';
import { NotificationsService } from './notifications.service';

/**
 * Staff notification centre. Every member can read what is addressed to them (their permissions, branches, or
 * themselves), so the routes need no extra permission; the audience filter is the authorisation.
 */
@Controller('o/:orgId/notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@Tenant() ctx: TenantContext, @Query(zod(notificationsQuery)) q: z.infer<typeof notificationsQuery>) {
    return this.notifications.list(ctx, q);
  }

  @Get('unread-count')
  unread(@Tenant() ctx: TenantContext) {
    return this.notifications.unreadCount(ctx);
  }

  @Post('read-all')
  readAll(@Tenant() ctx: TenantContext) {
    return this.notifications.markAllRead(ctx);
  }

  @Post(':notificationId/read')
  read(@Tenant() ctx: TenantContext, @Param('notificationId', ParseUUIDPipe) id: string) {
    return this.notifications.markRead(ctx, id);
  }
}
