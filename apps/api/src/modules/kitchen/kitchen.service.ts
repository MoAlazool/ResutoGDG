import { Injectable } from '@nestjs/common';
import type { KitchenFeed, KitchenTicket, OrderStatus } from '@resuto/contracts';
import type { TenantContext } from '../../common/auth/context';
import { DbService, type Tx } from '../../common/db/db.service';
import { conflict, invalid, notFound } from '../../common/errors/domain-error';
import { OrdersKernelService } from '../kernel/orders-kernel.service';

const ACTIVE = `('placed', 'accepted', 'preparing', 'ready')`;
const NEW_TICKET_SECONDS = 60;

/**
 * Kitchen display (KDS). Order-level bumps are kernel transitions; line-level
 * `kitchen_status` is owned here. The order state machine forbids
 * ready → preparing, so a *recall* is line-level only: the order stays `ready`
 * while the recalled line shows as preparing again on the KDS (and is counted
 * in `recall_count`). When every line is ready again nothing else changes.
 */
@Injectable()
export class KitchenService {
  constructor(private readonly db: DbService, private readonly kernel: OrdersKernelService) {}

  async feed(ctx: TenantContext, branchId: string, opts: { station?: string; since?: string }): Promise<KitchenFeed> {
    ctx.assertBranch(branchId);
    if (opts.since !== undefined && !/^\d{1,20}$/.test(opts.since)) throw invalid('invalid_cursor', 'Invalid cursor');
    return this.db.scoped(ctx, async (tx) => {
      if (!(await tx.maybeOne('select 1 from branches where id = $1', [branchId]))) throw notFound('Branch');
      const marker = await tx.one<{ cursor: string; now: Date }>(
        `select coalesce((extract(epoch from greatest(
            (select max(o.updated_at) from orders o where o.branch_id = $1 and o.updated_at > now() - interval '2 days'),
            (select max(l.updated_at) from order_lines l join orders o on o.id = l.order_id
              where o.branch_id = $1 and o.status in ${ACTIVE}))) * 1000000)::bigint, 0)::text as cursor, now() as now`, [branchId]);
      const stations = (await tx.query<{ station: string }>(
        `select distinct station from products where org_id = $1 and is_active order by station`, [ctx.orgId])).map((s) => s.station);
      if (opts.since && BigInt(opts.since) >= BigInt(marker.cursor)) {
        return { cursor: marker.cursor, serverTime: marker.now.toISOString(), unchanged: true, stations, tickets: [] };
      }
      return { cursor: marker.cursor, serverTime: marker.now.toISOString(), stations, tickets: await this.tickets(tx, branchId, opts.station, marker.now) };
    });
  }

  private async tickets(tx: Tx, branchId: string, station: string | undefined, now: Date): Promise<KitchenTicket[]> {
    const orders = await tx.query<any>(
      `select o.id, o.number, o.status, o.fulfillment, o.channel, o.customer_name, o.placed_at, o.accepted_at, o.notes, o.version, t.label as table_label
         from orders o left join dining_tables t on t.id = o.table_id
        where o.branch_id = $1 and o.status in ${ACTIVE}
          and ($2::text is null or exists (select 1 from order_lines l where l.order_id = o.id and l.station = $2))
        order by o.placed_at, o.id limit 300`, [branchId, station ?? null]);
    if (!orders.length) return [];
    const lines = await tx.query<any>(
      `select l.id, l.order_id, l.name, l.name_ar, l.quantity, l.station, l.kitchen_status, l.notes, l.modifiers, p.prep_minutes
         from order_lines l left join products p on p.id = l.product_id
        where l.order_id = any($1::uuid[]) and ($2::text is null or l.station = $2) order by l.created_at, l.id`,
      [orders.map((o) => o.id), station ?? null]);
    return orders.map((o) => ({
      id: o.id, number: o.number, status: o.status, fulfillment: o.fulfillment, channel: o.channel, tableLabel: o.table_label,
      customerName: o.customer_name, placedAt: o.placed_at.toISOString(), acceptedAt: o.accepted_at?.toISOString() ?? null,
      ageSeconds: Math.max(0, Math.round((now.getTime() - o.placed_at.getTime()) / 1000)), notes: o.notes, version: o.version,
      isNew: o.status === 'placed' && now.getTime() - o.placed_at.getTime() < NEW_TICKET_SECONDS * 1000,
      lines: lines.filter((l) => l.order_id === o.id).map((l) => ({
        id: l.id, name: l.name, nameAr: l.name_ar, quantity: l.quantity, station: l.station, kitchenStatus: l.kitchen_status, notes: l.notes,
        modifiers: (l.modifiers as any[]).map((m) => m.option), prepMinutes: l.prep_minutes,
      })),
    }));
  }

  /** Order-level bump (accept / start / ready / hand over) through the kernel state machine. */
  async bump(ctx: TenantContext, orderId: string, to: OrderStatus, version?: number) {
    return this.db.scoped(ctx, async (tx) => {
      const o = await tx.maybeOne<{ branch_id: string; status: string }>('select branch_id, status from orders where id = $1', [orderId]);
      if (!o || !ctx.canAccessBranch(o.branch_id)) throw notFound('Order');
      const r = await this.kernel.transition(tx, ctx, orderId, to, { expectedVersion: version });
      if (to === 'preparing') await tx.query(`update order_lines set kitchen_started_at = coalesce(kitchen_started_at, now()) where order_id = $1 and kitchen_status <> 'cancelled'`, [orderId]);
      if (to === 'ready') {
        await tx.query(
          `update order_lines set kitchen_started_at = coalesce(kitchen_started_at, now()), kitchen_ready_at = coalesce(kitchen_ready_at, now())
            where order_id = $1 and kitchen_status <> 'cancelled'`, [orderId]);
      }
      return r;
    });
  }

  /** Line-level status (start, ready, recall). May advance the order; never moves it backwards. */
  async line(ctx: TenantContext, lineId: string, status: 'queued' | 'preparing' | 'ready') {
    return this.db.scoped(ctx, async (tx) => {
      const l = await tx.maybeOne<any>(
        `select l.*, o.branch_id, o.status as order_status from order_lines l join orders o on o.id = l.order_id where l.id = $1 for update of l`, [lineId]);
      if (!l || !ctx.canAccessBranch(l.branch_id)) throw notFound('Order line');
      await tx.query('select 1 from orders where id = $1 for update', [l.order_id]);
      if (!['placed', 'accepted', 'preparing', 'ready'].includes(l.order_status)) throw conflict('order_not_in_kitchen', 'This order has left the kitchen.');
      if (l.kitchen_status === 'cancelled' || l.kitchen_status === 'served') throw conflict('line_closed', 'This item is no longer in the kitchen.');
      if (l.kitchen_status === status) return { id: lineId, kitchenStatus: status, orderStatus: l.order_status, changed: false };
      const recall = l.kitchen_status === 'ready' && status !== 'ready';
      await tx.query(
        `update order_lines set kitchen_status = $2::kitchen_status,
            kitchen_started_at = case when $2 = 'queued' then null else coalesce(kitchen_started_at, now()) end,
            kitchen_ready_at = case when $2 = 'ready' then now() else null end,
            recall_count = recall_count + $3
          where id = $1`, [lineId, status, recall ? 1 : 0]);
      await this.kernel.event(tx, ctx, l.order_id, recall ? 'line_recalled' : 'line_status_changed', l.kitchen_status, status, { lineId, station: l.station });
      let orderStatus = l.order_status as OrderStatus;
      if (status !== 'queued' && (orderStatus === 'placed' || orderStatus === 'accepted')) {
        orderStatus = (await this.kernel.transition(tx, ctx, l.order_id, 'preparing', { reason: 'kitchen_line_started' })).status;
      }
      if (status === 'ready' && orderStatus === 'preparing') {
        const pending = await tx.one<{ n: number }>(
          `select count(*)::int as n from order_lines where order_id = $1 and kitchen_status in ('queued', 'preparing')`, [l.order_id]);
        if (pending.n === 0) orderStatus = (await this.kernel.transition(tx, ctx, l.order_id, 'ready', { reason: 'all_lines_ready' })).status;
      }
      return { id: lineId, kitchenStatus: status, orderStatus, changed: true, recalled: recall };
    });
  }

  /** Measured prep times vs the menu's target minutes, per station and dish. */
  async prepTimes(ctx: TenantContext, branchId: string, days: number) {
    ctx.assertBranch(branchId);
    return this.db.scoped(ctx, async (tx) => {
      const rows = await tx.query<any>(
        `select l.station, l.product_id, l.name, p.prep_minutes as target_minutes, count(*)::int as samples,
                round(avg(extract(epoch from (coalesce(l.kitchen_ready_at, o.ready_at) - coalesce(l.kitchen_started_at, o.accepted_at, o.placed_at)))) / 60.0, 1)::float8 as avg_prep_minutes,
                round(avg(extract(epoch from (coalesce(l.kitchen_ready_at, o.ready_at) - o.placed_at))) / 60.0, 1)::float8 as avg_ticket_minutes,
                coalesce(sum(l.recall_count), 0)::int as recalls
           from order_lines l join orders o on o.id = l.order_id left join products p on p.id = l.product_id
          where o.branch_id = $1 and o.placed_at > now() - make_interval(days => $2) and coalesce(l.kitchen_ready_at, o.ready_at) is not null
            and l.kitchen_status <> 'cancelled'
          group by l.station, l.product_id, l.name, p.prep_minutes order by l.station, samples desc`, [branchId, days]);
      const stations = new Map<string, { station: string; samples: number; avgPrepMinutes: number; avgTicketMinutes: number }>();
      for (const r of rows) {
        const s = stations.get(r.station) ?? { station: r.station, samples: 0, avgPrepMinutes: 0, avgTicketMinutes: 0 };
        const total = s.samples + r.samples;
        s.avgPrepMinutes = Math.round(((s.avgPrepMinutes * s.samples + r.avg_prep_minutes * r.samples) / total) * 10) / 10;
        s.avgTicketMinutes = Math.round(((s.avgTicketMinutes * s.samples + r.avg_ticket_minutes * r.samples) / total) * 10) / 10;
        s.samples = total;
        stations.set(r.station, s);
      }
      return {
        days, stations: [...stations.values()],
        products: rows.map((r) => ({
          station: r.station, productId: r.product_id, name: r.name, targetMinutes: r.target_minutes, samples: r.samples,
          avgPrepMinutes: r.avg_prep_minutes, avgTicketMinutes: r.avg_ticket_minutes, recalls: r.recalls,
          overTarget: r.target_minutes !== null && r.avg_prep_minutes > r.target_minutes,
        })),
      };
    });
  }
}
