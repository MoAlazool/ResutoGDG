import { Inject, Injectable, Logger } from '@nestjs/common';
import { ROLE_PERMISSIONS, type NotificationKind, type NotificationsPage, type Permission, type StaffNotification } from '@resuto/contracts';
import type { TenantContext } from '../../common/auth/context';
import { DbService, type Tx } from '../../common/db/db.service';
import { notFound } from '../../common/errors/domain-error';
import { EMAIL_PROVIDER, maskEmail, type EmailProvider } from './email.provider';

export interface RaiseNotification {
  branchId?: string | null;
  /** Everyone holding this permission (within branchId when set)… */
  audiencePermission?: Permission;
  /** …or exactly one user. */
  audienceUserId?: string;
  kind: NotificationKind;
  severity: 'info' | 'warning' | 'critical';
  templateKey: string;
  params: Record<string, unknown>;
  entityType?: string;
  entityId?: string;
  link?: string | null;
  /** One notification per source fact; redelivered events are no-ops. */
  dedupeKey: string;
}

/**
 * Staff notification centre (FT-06). Notifications are created by the worker from domain events and scheduled
 * checks (notifications.handlers.ts) and read by staff in the bell and the notifications page. Email is attempted
 * through the EmailProvider abstraction and every attempt is recorded with its true outcome.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger('Notifications');

  constructor(private readonly db: DbService, @Inject(EMAIL_PROVIDER) private email: EmailProvider) {}

  /** Inserts the notification (idempotent on dedupeKey). Returns its id and whether it was new. Runs in the caller's tenant tx. */
  async raise(tx: Tx, orgId: string, n: RaiseNotification): Promise<{ id: string; created: boolean }> {
    const row = await tx.maybeOne<{ id: string }>(
      `insert into notifications(org_id, branch_id, audience_permission, audience_user_id, kind, severity, template_key, params, entity_type, entity_id, link, dedupe_key)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       on conflict (org_id, dedupe_key) do nothing returning id`,
      [orgId, n.branchId ?? null, n.audiencePermission ?? null, n.audienceUserId ?? null, n.kind, n.severity, n.templateKey, n.params,
        n.entityType ?? null, n.entityId ?? null, n.link ?? null, n.dedupeKey]);
    if (row) return { id: row.id, created: true };
    const existing = await tx.one<{ id: string }>('select id from notifications where org_id = $1 and dedupe_key = $2', [orgId, n.dedupeKey]);
    return { id: existing.id, created: false };
  }

  /**
   * Emails the notification to the members it addresses. Called outside any transaction (provider I/O).
   * Without a configured provider one 'not_configured' delivery is recorded; with one, 'sent' is recorded only
   * after the provider accepted the message, otherwise 'failed' with the error. Returns the recorded status.
   */
  async deliverEmail(orgId: string, notificationId: string, message: { subject: string; text: string }): Promise<'not_configured' | 'sent' | 'failed' | 'skipped'> {
    const already = await this.db.withTenant(orgId, (tx) => tx.maybeOne<{ status: string }>(
      `select status from notification_deliveries where notification_id = $1 and channel = 'email'`, [notificationId]), 'system:notifications');
    if (already) return already.status as any;
    if (!this.email.configured) {
      await this.recordDelivery(orgId, notificationId, { status: 'not_configured', provider: this.email.name, recipientHint: null });
      return 'not_configured';
    }
    const recipients = await this.recipientEmails(orgId, notificationId);
    if (!recipients.length) {
      await this.recordDelivery(orgId, notificationId, { status: 'skipped', provider: this.email.name, recipientHint: null, error: 'no_recipient_with_email' });
      return 'skipped';
    }
    const ids: string[] = [];
    try {
      for (const to of recipients) ids.push((await this.email.send({ to, ...message })).messageId);
    } catch (error) {
      this.logger.warn(`email for notification ${notificationId} failed: ${(error as Error).message}`);
      await this.recordDelivery(orgId, notificationId, { status: 'failed', provider: this.email.name, recipientHint: recipients.map(maskEmail).join(', '),
        error: (error as Error).message.slice(0, 300), messageId: ids.join(',') || null });
      return 'failed';
    }
    await this.recordDelivery(orgId, notificationId, { status: 'sent', provider: this.email.name, recipientHint: recipients.map(maskEmail).join(', '), messageId: ids.join(',') });
    return 'sent';
  }

  private recordDelivery(orgId: string, notificationId: string, d: { status: string; provider: string; recipientHint: string | null; error?: string; messageId?: string | null }) {
    return this.db.withTenant(orgId, (tx) => tx.query(
      `insert into notification_deliveries(org_id, notification_id, channel, recipient_hint, provider, status, error, provider_message_id)
       values ($1, $2, 'email', $3, $4, $5, $6, $7) on conflict (notification_id, channel) do nothing`,
      [orgId, notificationId, d.recipientHint, d.provider, d.status, d.error ?? null, d.messageId ?? null]), 'system:notifications');
  }

  /** Active members the notification addresses (permission via role, branch access), with their sign-in email. */
  private async recipientEmails(orgId: string, notificationId: string): Promise<string[]> {
    return this.db.withPlatform(async (tx) => {
      const n = await tx.one<{ audience_permission: string | null; audience_user_id: string | null; branch_id: string | null }>(
        'select audience_permission, audience_user_id, branch_id from notifications where id = $1 and org_id = $2', [notificationId, orgId]);
      const roles = n.audience_permission
        ? Object.entries(ROLE_PERMISSIONS).filter(([, perms]) => (perms as readonly string[]).includes(n.audience_permission!)).map(([r]) => r) : [];
      const rows = await tx.query<{ email: string }>(
        `select distinct u.email from memberships m join auth.users u on u.id = m.user_id
          where m.org_id = $1 and m.status = 'active' and u.email is not null
            and (($2::uuid is not null and m.user_id = $2) or ($2::uuid is null and m.role::text = any($3::text[])))
            and ($4::uuid is null or m.branch_ids is null or $4 = any(m.branch_ids))`,
        [orgId, n.audience_user_id, roles, n.branch_id]);
      return rows.map((r) => r.email);
    }, 'system:notifications');
  }

  // -------------------------------------------------------------------------
  // Staff reads
  // -------------------------------------------------------------------------
  private audience(ctx: TenantContext) {
    return { perms: [...ROLE_PERMISSIONS[ctx.role]], userId: ctx.userId, branches: ctx.branchFilter };
  }

  private static readonly AUDIENCE_SQL = `n.org_id = $1
      and ((n.audience_user_id is not null and n.audience_user_id = $2)
        or (n.audience_user_id is null and n.audience_permission = any($3::text[])))
      and ($4::uuid[] is null or n.branch_id is null or n.branch_id = any($4::uuid[]))`;

  list(ctx: TenantContext, q: { unread?: 'true' | 'false'; limit: number; cursor?: string }): Promise<NotificationsPage> {
    const a = this.audience(ctx);
    return this.db.scoped(ctx, async (tx) => {
      const rows = await tx.query<any>(
        `select n.id, n.kind, n.severity, n.template_key, n.params, n.branch_id, n.link, n.created_at, r.read_at,
                coalesce((select json_agg(json_build_object('channel', d.channel, 'status', d.status, 'recipientHint', d.recipient_hint, 'attemptedAt', d.attempted_at))
                            from notification_deliveries d where d.notification_id = n.id), '[]'::json) as deliveries
           from notifications n left join notification_reads r on r.notification_id = n.id and r.user_id = $2
          where ${NotificationsService.AUDIENCE_SQL}
            and ($5::boolean is not true or r.read_at is null)
            and ($6::timestamptz is null or n.created_at < $6)
          order by n.created_at desc, n.id limit $7`,
        [ctx.orgId, a.userId, a.perms, a.branches, q.unread === 'true', q.cursor ?? null, q.limit]);
      const items: StaffNotification[] = rows.map((r) => ({
        id: r.id, kind: r.kind, severity: r.severity, templateKey: r.template_key, params: r.params ?? {}, branchId: r.branch_id, link: r.link,
        createdAt: new Date(r.created_at).toISOString(), readAt: r.read_at ? new Date(r.read_at).toISOString() : null,
        deliveries: (r.deliveries ?? []).map((d: any) => ({ ...d, attemptedAt: new Date(d.attemptedAt).toISOString() })),
      }));
      const unread = await this.unreadIn(tx, ctx);
      return { items, nextCursor: rows.length === q.limit ? items.at(-1)!.createdAt : null, unread };
    });
  }

  unreadCount(ctx: TenantContext) {
    return this.db.scoped(ctx, async (tx) => ({ unread: await this.unreadIn(tx, ctx) }));
  }

  private async unreadIn(tx: Tx, ctx: TenantContext): Promise<number> {
    const a = this.audience(ctx);
    const { n } = await tx.one<{ n: number }>(
      `select count(*)::int as n from notifications n
        where ${NotificationsService.AUDIENCE_SQL}
          and n.created_at > now() - interval '90 days'
          and not exists (select 1 from notification_reads r where r.notification_id = n.id and r.user_id = $2)`,
      [ctx.orgId, a.userId, a.perms, a.branches]);
    return n;
  }

  markRead(ctx: TenantContext, id: string) {
    const a = this.audience(ctx);
    return this.db.scoped(ctx, async (tx) => {
      const n = await tx.maybeOne(`select 1 from notifications n where n.id = $5 and ${NotificationsService.AUDIENCE_SQL}`, [ctx.orgId, a.userId, a.perms, a.branches, id]);
      if (!n) throw notFound('Notification');
      await tx.query(`insert into notification_reads(notification_id, org_id, user_id) values ($1, $2, $3) on conflict do nothing`, [id, ctx.orgId, ctx.userId]);
      return { id, read: true, unread: await this.unreadIn(tx, ctx) };
    });
  }

  markAllRead(ctx: TenantContext) {
    const a = this.audience(ctx);
    return this.db.scoped(ctx, async (tx) => {
      const rows = await tx.query(
        `insert into notification_reads(notification_id, org_id, user_id)
         select n.id, n.org_id, $2 from notifications n
          where ${NotificationsService.AUDIENCE_SQL}
            and not exists (select 1 from notification_reads r where r.notification_id = n.id and r.user_id = $2)
         on conflict do nothing returning notification_id`, [ctx.orgId, a.userId, a.perms, a.branches]);
      return { marked: rows.length, unread: 0 };
    });
  }
}
