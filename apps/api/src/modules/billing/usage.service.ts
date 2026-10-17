import { Injectable } from '@nestjs/common';
import { DbService, type Tx } from '../../common/db/db.service';
import { OnDomainEvent, type OutboxEvent } from '../../common/events/events';

export interface UsageRecord {
  metric: string;
  quantity?: number;
  /** 'merchant' for provider costs the restaurant pays directly (WhatsApp, payment fees, ads). */
  costOwner?: 'resuto' | 'merchant';
  externalCostMinor?: number | null;
  currency?: 'EGP' | 'SAR' | 'USD' | null;
  occurredAt?: Date | string;
  metadata?: Record<string, unknown>;
  /** Id of the metered thing (order id, request id). Makes recording idempotent. */
  sourceRef?: string | null;
}

/** Live counts and metered totals for the current billing period. */
export interface UsageSnapshot {
  periodStart: Date;
  periodEnd: Date | null;
  usage: Record<'orders' | 'staff' | 'branches' | 'ai_requests' | 'mcp_calls', number>;
}

/**
 * Usage metering (`usage_events`). Exported for other modules: E1 records
 * `ai_requests`, E2 records `mcp_calls` (MODULE_CONTRACTS.md §5).
 */
@Injectable()
export class UsageService {
  constructor(private readonly db: DbService) {}

  /** Records one usage row inside the caller's tenant transaction. Returns false when `sourceRef` was already metered. */
  async record(tx: Tx, orgId: string, r: UsageRecord): Promise<boolean> {
    const row = await tx.maybeOne(
      `insert into usage_events(org_id, metric, quantity, cost_owner, external_cost_minor, currency, occurred_at, metadata, source_ref)
       values ($1, $2, $3, $4, $5, $6, coalesce($7::timestamptz, now()), $8, $9)
       on conflict (org_id, metric, source_ref) where source_ref is not null do nothing
       returning id`,
      [orgId, r.metric, r.quantity ?? 1, r.costOwner ?? 'resuto', r.externalCostMinor ?? null, r.currency ?? null,
        r.occurredAt ?? null, r.metadata ?? {}, r.sourceRef ?? null]);
    return !!row;
  }

  async total(tx: Tx, orgId: string, metric: string, from: Date, to?: Date | null): Promise<number> {
    const { n } = await tx.one<{ n: number }>(
      `select coalesce(sum(quantity), 0)::int as n from usage_events
        where org_id = $1 and metric = $2 and occurred_at >= $3 and ($4::timestamptz is null or occurred_at < $4)`,
      [orgId, metric, from, to ?? null]);
    return n;
  }

  /**
   * Current-period usage. Orders, staff and branches are live counts (they
   * gate plan limits synchronously); AI and MCP calls are metered rows.
   * Staff counting matches invitation enforcement: active non-driver members
   * plus pending non-driver invitations.
   */
  async snapshot(tx: Tx, orgId: string): Promise<UsageSnapshot> {
    const sub = await tx.maybeOne<{ current_period_start: Date; current_period_end: Date }>(
      `select current_period_start, current_period_end from subscriptions where org_id = $1 and status <> 'canceled'`, [orgId]);
    const periodStart = sub?.current_period_start ?? startOfMonth(new Date());
    const periodEnd = sub?.current_period_end ?? null;
    const live = await tx.one<{ orders: number; staff: number; branches: number }>(
      `select (select count(*)::int from orders where org_id = $1 and placed_at >= $2) as orders,
              ((select count(*) from memberships where org_id = $1 and status = 'active' and role <> 'driver')
               + (select count(*) from invitations where org_id = $1 and status = 'pending' and role <> 'driver' and expires_at > now()))::int as staff,
              (select count(*)::int from branches where org_id = $1 and is_active) as branches`, [orgId, periodStart]);
    return {
      periodStart, periodEnd,
      usage: {
        orders: live.orders, staff: live.staff, branches: live.branches,
        ai_requests: await this.total(tx, orgId, 'ai_requests', periodStart),
        mcp_calls: await this.total(tx, orgId, 'mcp_calls', periodStart),
      },
    };
  }

  /** Meters every placed order (idempotent per order id). */
  @OnDomainEvent('billing.usage-orders', 'order.placed')
  async onOrderPlaced(event: OutboxEvent) {
    if (!event.orgId) return;
    await this.db.withTenant(event.orgId, (tx) => this.record(tx, event.orgId!, {
      metric: 'orders', sourceRef: event.aggregateId, occurredAt: event.createdAt, metadata: { orderId: event.aggregateId },
    }), 'system:billing');
  }
}

export const startOfMonth = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
