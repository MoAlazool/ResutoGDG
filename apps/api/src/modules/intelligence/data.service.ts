import { Injectable } from '@nestjs/common';
import type { TenantContext } from '../../common/auth/context';
import type { Tx } from '../../common/db/db.service';
import { notFound } from '../../common/errors/domain-error';
import { IN_STOCK_SQL, OFFERED_SQL, SOLD_OUT_SQL } from '../menu/availability';

/** Orders that count as demand/sales: everything except cancelled and unpaid online orders. */
export const SOLD = `o.status not in ('cancelled', 'awaiting_payment')`;

export interface ProductRef { id: string; name: string; nameAr: string | null; priceMinor: number; currency: string }

/**
 * Read-only extraction of the minimal data the models need. Runs inside a tenant-scoped
 * transaction (RLS + explicit org/branch filters). Nothing here writes.
 */
@Injectable()
export class IntelligenceDataService {
  async branch(tx: Tx, ctx: TenantContext, branchId: string) {
    ctx.assertBranch(branchId);
    const b = await tx.maybeOne<{ id: string; country: 'EG' | 'SA'; currency: string; today: string; lat: string | null; lng: string | null; timezone: string }>(
      `select b.id, o.country, o.currency, (now() at time zone coalesce(b.timezone, o.timezone))::date::text as today,
              b.latitude::text as lat, b.longitude::text as lng, coalesce(b.timezone, o.timezone) as timezone
         from branches b join organizations o on o.id = b.org_id where b.id = $1 and b.org_id = $2`, [branchId, ctx.orgId]);
    if (!b) throw notFound('Branch');
    return b;
  }

  async org(tx: Tx, ctx: TenantContext) {
    return tx.one<{ country: 'EG' | 'SA'; currency: string; timezone: string; today: string }>(
      `select country, currency, timezone, (now() at time zone timezone)::date::text as today from organizations where id = $1`, [ctx.orgId]);
  }

  async products(tx: Tx, ctx: TenantContext, ids: string[]): Promise<Map<string, ProductRef>> {
    if (!ids.length) return new Map();
    const rows = await tx.query<any>(
      `select id, name, name_ar, price_minor, currency from products where org_id = $1 and id = any($2::uuid[])`, [ctx.orgId, ids]);
    return new Map(rows.map((r) => [r.id, { id: r.id, name: r.name, nameAr: r.name_ar, priceMinor: r.price_minor, currency: r.currency }]));
  }

  /** Top products by quantity sold at a branch in the trailing window. */
  async topProducts(tx: Tx, ctx: TenantContext, branchId: string, fromDate: string, toDate: string, limit: number): Promise<string[]> {
    const rows = await tx.query<{ product_id: string }>(
      `select ol.product_id from order_lines ol join orders o on o.id = ol.order_id
        where o.org_id = $1 and o.branch_id = $2 and ${SOLD} and ol.kitchen_status <> 'cancelled' and ol.product_id is not null
          and o.business_date between $3::date and $4::date
        group by ol.product_id order by sum(ol.quantity) desc, ol.product_id limit $5`, [ctx.orgId, branchId, fromDate, toDate, limit]);
    return rows.map((r) => r.product_id);
  }

  /** Daily quantities per product (business date) — days without sales are omitted (the service fills zeros). */
  async dailyQuantities(tx: Tx, ctx: TenantContext, branchId: string, productIds: string[], fromDate: string, toDate: string) {
    const rows = await tx.query<{ product_id: string; d: string; qty: number }>(
      `select ol.product_id, o.business_date::text as d, sum(ol.quantity)::int as qty
         from order_lines ol join orders o on o.id = ol.order_id
        where o.org_id = $1 and o.branch_id = $2 and ${SOLD} and ol.kitchen_status <> 'cancelled'
          and ol.product_id = any($3::uuid[]) and o.business_date between $4::date and $5::date
        group by 1, 2 order by 2`, [ctx.orgId, branchId, productIds, fromDate, toDate]);
    const out = new Map<string, Array<{ date: string; quantity: number }>>(productIds.map((id) => [id, []]));
    for (const r of rows) out.get(r.product_id)!.push({ date: r.d, quantity: r.qty });
    return out;
  }

  /** Customer orders (id, time, amount only) for RFM/churn. Branch-scoped members only see their branches. */
  async customerOrders(tx: Tx, ctx: TenantContext, days = 730, max = 200_000) {
    return tx.query<{ customerId: string; at: string; totalMinor: number }>(
      `select o.customer_id as "customerId", to_char(o.placed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as at,
              o.total_minor as "totalMinor"
         from orders o
        where o.org_id = $1 and o.customer_id is not null and ${SOLD} and o.placed_at >= now() - make_interval(days => $2)
          and ($3::uuid[] is null or o.branch_id = any($3::uuid[]))
        order by o.placed_at limit $4`, [ctx.orgId, days, ctx.branchFilter, max]);
  }

  /** Baskets (one order = one basket of distinct product ids). */
  async baskets(tx: Tx, ctx: TenantContext, branchId: string | null, days = 365, max = 100_000) {
    return tx.query<{ customerId: string | null; at: string; items: string[] }>(
      `select o.customer_id as "customerId", to_char(o.placed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as at,
              array_agg(distinct ol.product_id::text) as items
         from orders o join order_lines ol on ol.order_id = o.id
        where o.org_id = $1 and ${SOLD} and ol.product_id is not null and o.placed_at >= now() - make_interval(days => $2)
          and ($3::uuid is null or o.branch_id = $3) and ($4::uuid[] is null or o.branch_id = any($4::uuid[]))
        group by o.id, o.customer_id, o.placed_at order by o.placed_at desc limit $5`,
      [ctx.orgId, days, branchId, ctx.branchFilter, max]);
  }

  /**
   * Products the caller must never recommend at this branch: archived, not offered here, 86'd (sold out, until the
   * restore time) or out of tracked stock. Same rules as ordering (menu/availability.ts), so a dish the kitchen 86'd
   * is never suggested.
   */
  async unavailableProducts(tx: Tx, ctx: TenantContext, branchId: string): Promise<string[]> {
    const rows = await tx.query<{ id: string }>(
      `select p.id from products p left join product_branch_settings s on s.product_id = p.id and s.branch_id = $2
        where p.org_id = $1 and (not p.is_active or not ${OFFERED_SQL} or ${SOLD_OUT_SQL} or not ${IN_STOCK_SQL})`,
      [ctx.orgId, branchId]);
    return rows.map((r) => r.id);
  }

  async customerNames(tx: Tx, ctx: TenantContext, ids: string[]) {
    if (!ids.length) return new Map<string, string | null>();
    const rows = await tx.query<{ id: string; display_name: string | null }>(
      `select id, display_name from customers where org_id = $1 and id = any($2::uuid[])`, [ctx.orgId, ids]);
    return new Map(rows.map((r) => [r.id, r.display_name]));
  }

  /** A driver's open delivery jobs at a branch, in placement order (the naive route). */
  async openJobs(tx: Tx, ctx: TenantContext, branchId: string, driverId: string, promiseMinutes: number) {
    const driver = await tx.maybeOne<{ id: string; lat: string | null; lng: string | null; fresh: boolean }>(
      `select id, last_latitude::text as lat, last_longitude::text as lng,
              coalesce(last_location_at > now() - interval '10 minutes', false) as fresh
         from drivers where id = $1 and org_id = $2`, [driverId, ctx.orgId]);
    if (!driver) throw notFound('Driver');
    const jobs = await tx.query<any>(
      `select j.id, j.order_id, o.number, j.dropoff_latitude::float8 as lat, j.dropoff_longitude::float8 as lng,
              j.dropoff->>'line1' as address,
              to_char(coalesce(o.scheduled_for, o.placed_at + make_interval(mins => $4)) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as promised_at
         from delivery_jobs j join orders o on o.id = j.order_id
        where j.org_id = $1 and j.branch_id = $2 and j.driver_id = $3
          and j.status in ('assigned', 'accepted', 'picked_up', 'en_route')
        order by o.placed_at, j.id limit 50`, [ctx.orgId, branchId, driverId, promiseMinutes]);
    return { driver, jobs };
  }

  /** Platform registry model id for a task/name (nullable when the registry has not been synced). */
  async modelId(tx: Tx, task: string, name: string): Promise<string | null> {
    const r = await tx.maybeOne<{ id: string }>(
      `select id from ai_models where org_id is null and task = $1 and name = $2 order by created_at desc limit 1`, [task, name]);
    return r?.id ?? null;
  }
}
