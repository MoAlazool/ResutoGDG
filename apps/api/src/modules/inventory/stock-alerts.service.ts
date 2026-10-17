import { Injectable } from '@nestjs/common';
import { DbService, type Tx } from '../../common/db/db.service';
import { OnDomainEvent, type OutboxEvent } from '../../common/events/events';
import { OutboxService } from '../../common/platform/outbox.service';

/**
 * Low-stock detection. An item is low in a branch when it has a reorder level
 * above zero and its stock level is at or below it. Each breach opens one
 * stock_alerts row and publishes exactly one `stock.low` event; the alert
 * resolves when the level rises above the reorder level again, so the next
 * breach is reported again.
 */
@Injectable()
export class StockAlertsService {
  constructor(private readonly outbox: OutboxService, private readonly db: DbService) {}

  async evaluate(tx: Tx, orgId: string, branchId: string | null, itemIds: string[]): Promise<{ opened: string[]; resolved: number }> {
    if (!itemIds.length) return { opened: [], resolved: 0 };
    const resolved = await tx.query(
      `update stock_alerts a set status = 'resolved', resolved_at = now()
         from inventory_items i
        where a.item_id = i.id and a.status = 'open' and a.item_id = any($1::uuid[]) and ($2::uuid is null or a.branch_id = $2)
          and (not i.is_active or i.reorder_level <= 0 or coalesce((select quantity from stock_levels sl
                where sl.branch_id = a.branch_id and sl.item_id = a.item_id), 0) > i.reorder_level)
        returning a.id`, [itemIds, branchId]);
    const opened = await tx.query<{ id: string; branch_id: string; item_id: string; quantity_at_open: string; reorder_level: string; name: string; unit: string }>(
      `with low as (
         select sl.branch_id, sl.item_id, sl.quantity, i.reorder_level, i.name, i.unit
           from stock_levels sl join inventory_items i on i.id = sl.item_id
          where sl.item_id = any($1::uuid[]) and ($2::uuid is null or sl.branch_id = $2)
            and i.is_active and i.reorder_level > 0 and sl.quantity <= i.reorder_level)
       , ins as (
         insert into stock_alerts(org_id, branch_id, item_id, quantity_at_open, reorder_level)
         select $3, branch_id, item_id, quantity, reorder_level from low
         on conflict (branch_id, item_id) where status = 'open' do nothing
         returning id, branch_id, item_id, quantity_at_open, reorder_level)
       select ins.*, low.name, low.unit from ins join low using (branch_id, item_id)`, [itemIds, branchId, orgId]);
    for (const a of opened) {
      await this.outbox.publish(tx, orgId, {
        type: 'stock.low', aggregateType: 'inventory_item', aggregateId: a.item_id,
        payload: { alertId: a.id, branchId: a.branch_id, itemId: a.item_id, itemName: a.name, unit: a.unit,
          quantity: Number(a.quantity_at_open), reorderLevel: Number(a.reorder_level) },
      });
    }
    return { opened: opened.map((a) => a.id), resolved: resolved.length };
  }

  /**
   * The kernel records sale/return movements from recipes when orders are placed
   * or cancelled; re-evaluate the affected items afterwards (worker, at least once —
   * evaluate() is idempotent because alerts are deduplicated).
   */
  @OnDomainEvent('inventory.low_stock_after_order', 'order.placed', 'order.cancelled')
  async onOrder(event: OutboxEvent) {
    if (!event.orgId) return;
    const orgId = event.orgId;
    await this.db.withTenant(orgId, async (tx) => {
      const rows = await tx.query<{ branch_id: string; item_id: string }>(
        `select distinct branch_id, item_id from stock_movements
          where org_id = $1 and reference_type = 'order' and reference_id = $2 and reason in ('sale', 'return')`, [orgId, event.aggregateId]);
      const byBranch = new Map<string, string[]>();
      for (const r of rows) byBranch.set(r.branch_id, [...(byBranch.get(r.branch_id) ?? []), r.item_id]);
      for (const [branchId, items] of byBranch) await this.evaluate(tx, orgId, branchId, items);
    }, 'system:inventory');
  }
}
