import { Injectable, Logger } from '@nestjs/common';
import { MCP_TOOLS } from '@resuto/contracts';
import { DbService } from '../../common/db/db.service';
import { OnDomainEvent, Scheduled, type OutboxEvent } from '../../common/events/events';
import { maskEmail } from './email.provider';
import { NotificationsService } from './notifications.service';

/**
 * Consumers that turn domain facts into staff notifications (FT-06). Each is idempotent: the notification is keyed
 * by its source (document + reminder day, stock alert, approval, invitation, payment alert), so redelivered events
 * and re-runs change nothing. Email is attempted after the notification commits, outside any transaction.
 */
@Injectable()
export class NotificationsHandlers {
  private readonly logger = new Logger('NotificationsHandlers');

  constructor(private readonly db: DbService, private readonly notifications: NotificationsService) {}

  /**
   * Licence / permit expiry reminders (compliance.document_expiring, published by the compliance reminder job
   * with the reminder 'raised'). The reminder becomes 'sent' only when an email provider accepted the message.
   */
  @OnDomainEvent('notifications.licence_expiring', 'compliance.document_expiring')
  async onLicenceExpiring(e: OutboxEvent) {
    if (!e.orgId) return;
    const p = e.payload;
    const { id, created } = await this.db.withTenant(e.orgId, (tx) => this.notifications.raise(tx, e.orgId!, {
      branchId: p.branchId ?? null, audiencePermission: 'compliance:read', kind: 'licence_expiring',
      severity: Number(p.daysLeft) <= 7 ? 'critical' : 'warning', templateKey: 'licence_expiring',
      params: { title: p.title, kind: p.kind, expiresOn: p.expiresOn, daysLeft: Number(p.daysLeft) },
      entityType: 'compliance_document', entityId: e.aggregateId, link: '/compliance',
      dedupeKey: `licence:${e.aggregateId}:${p.daysBefore}`,
    }), 'system:notifications');
    const status = await this.notifications.deliverEmail(e.orgId, id, {
      subject: `Licence expiring: ${p.title}`,
      text: `${p.title} expires on ${p.expiresOn} (${p.daysLeft} days left). Open Resuto → Compliance to renew it.`,
    });
    if (status === 'sent') {
      await this.db.withTenant(e.orgId, (tx) => tx.query(
        `update compliance_reminders set status = 'sent', sent_at = now() where document_id = $1 and days_before = $2 and status = 'raised'`,
        [e.aggregateId, p.daysBefore]), 'system:notifications');
    }
    if (created) this.logger.log(`licence reminder ${e.aggregateId} raised (email ${status})`);
  }

  /** Low stock (one stock.low per breach, from inventory). */
  @OnDomainEvent('notifications.stock_low', 'stock.low')
  async onStockLow(e: OutboxEvent) {
    if (!e.orgId) return;
    const p = e.payload;
    const names = await this.db.withTenant(e.orgId, (tx) => tx.maybeOne<{ name_ar: string | null }>(
      'select name_ar from inventory_items where id = $1', [p.itemId]), 'system:notifications');
    const { id } = await this.db.withTenant(e.orgId, (tx) => this.notifications.raise(tx, e.orgId!, {
      branchId: p.branchId ?? null, audiencePermission: 'inventory:read', kind: 'stock_low',
      severity: Number(p.quantity) <= 0 ? 'critical' : 'warning', templateKey: 'stock_low',
      params: { item: p.itemName, itemAr: names?.name_ar ?? null, quantity: Number(p.quantity), reorderLevel: Number(p.reorderLevel), unit: p.unit },
      entityType: 'inventory_item', entityId: p.itemId, link: '/inventory', dedupeKey: `stock_alert:${p.alertId ?? e.id}`,
    }), 'system:notifications');
    await this.notifications.deliverEmail(e.orgId, id, {
      subject: `Low stock: ${p.itemName}`, text: `${p.itemName} is at ${p.quantity} ${p.unit} (reorder level ${p.reorderLevel}).`,
    });
  }

  /** An AI agent asked to run a sensitive tool; a person with mcp:approve must decide. */
  @OnDomainEvent('notifications.mcp_approval', 'mcp.approval_requested')
  async onMcpApproval(e: OutboxEvent) {
    if (!e.orgId) return;
    const tool = String(e.payload.tool ?? '');
    const meta = (MCP_TOOLS as Record<string, { title: string; titleAr: string }>)[tool];
    const { id } = await this.db.withTenant(e.orgId, async (tx) => {
      const a = await tx.maybeOne<{ summary: string | null; expires_at: Date }>('select summary, expires_at from mcp_approvals where id = $1', [e.aggregateId]);
      return this.notifications.raise(tx, e.orgId!, {
        audiencePermission: 'mcp:approve', kind: 'mcp_approval_requested', severity: 'warning', templateKey: 'mcp_approval_requested',
        params: { tool, toolTitle: meta?.title ?? tool, toolTitleAr: meta?.titleAr ?? null, summary: a?.summary ?? null,
          expiresAt: a?.expires_at ? new Date(a.expires_at).toISOString() : null },
        entityType: 'mcp_approval', entityId: e.aggregateId, link: '/mcp/approvals', dedupeKey: `mcp_approval:${e.aggregateId}`,
      });
    }, 'system:notifications');
    await this.notifications.deliverEmail(e.orgId, id, {
      subject: `Approval needed: ${meta?.title ?? tool}`, text: 'An AI assistant asked to run a sensitive action. Review it in Resuto → MCP → Approvals.',
    });
  }

  /**
   * A member was invited: the people who manage the team see it in the centre. The invitee's link is shared by the
   * inviter (only the token hash is stored), so no invitation email is sent from here.
   */
  @OnDomainEvent('notifications.member_invited', 'member.invited')
  async onMemberInvited(e: OutboxEvent) {
    if (!e.orgId) return;
    const email = typeof e.payload.email === 'string' ? e.payload.email : null;
    await this.db.withTenant(e.orgId, (tx) => this.notifications.raise(tx, e.orgId!, {
      audiencePermission: 'members:manage', kind: 'member_invited', severity: 'info', templateKey: 'member_invited',
      params: { role: e.payload.role, email: email ? maskEmail(email) : null },
      entityType: 'invitation', entityId: e.aggregateId, link: '/team', dedupeKey: `invitation:${e.aggregateId}`,
    }), 'system:notifications');
  }

  /**
   * Payment alerts (amount mismatch, late success, failed refund…) are rows written by the payments module.
   * This job turns each open alert into one notification for people who reconcile payments.
   */
  @Scheduled('notifications.payment_alerts', 60)
  async scanPaymentAlerts() {
    // Cross-tenant listing of alerts not yet notified (job resolution only; writes are tenant-scoped below).
    const alerts = await this.db.withPlatform((tx) => tx.query<{ id: string; org_id: string; branch_id: string | null; kind: string; provider: string | null; payment_id: string | null; created_at: Date }>(
      `select a.id, a.org_id, a.branch_id, a.kind, a.provider, a.payment_id, a.created_at from payment_alerts a
        where a.status = 'open' and a.created_at > now() - interval '7 days'
          and not exists (select 1 from notifications n where n.org_id = a.org_id and n.dedupe_key = 'payment_alert:' || a.id)
        order by a.created_at limit 200`), 'system:notifications');
    let raised = 0;
    for (const a of alerts) {
      const { id, created } = await this.db.withTenant(a.org_id, (tx) => this.notifications.raise(tx, a.org_id, {
        branchId: a.branch_id, audiencePermission: 'payments:reconcile', kind: 'payment_alert',
        severity: a.kind === 'refund_failed' || a.kind === 'amount_mismatch' ? 'critical' : 'warning', templateKey: 'payment_alert',
        params: { alertKind: a.kind, provider: a.provider, at: new Date(a.created_at).toISOString() },
        entityType: 'payment_alert', entityId: a.id, link: a.payment_id ? `/payments/${a.payment_id}` : '/payments', dedupeKey: `payment_alert:${a.id}`,
      }), 'system:notifications');
      if (!created) continue;
      raised++;
      await this.notifications.deliverEmail(a.org_id, id, { subject: 'Payment needs attention', text: `A payment alert (${a.kind}) needs review in Resuto → Payments.` });
    }
    return { raised };
  }
}
