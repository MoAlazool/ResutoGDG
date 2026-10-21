// Read-only MCP tools. Queries are tenant-scoped read models (allowed by
// MODULE_CONTRACTS.md §1.2) executed in the client's TenantContext; branch scope
// is applied explicitly in SQL because MCP runs in tenant mode (RLS pins the org).
import { DomainError, notFound } from '../../../common/errors/domain-error';
import type { Tx } from '../../../common/db/db.service';
import type { TenantContext } from '../../../common/auth/context';
import {
  assertPeriod, branchScope, decodeCursor, encodeCursor, escapeLike, iso, maskEmail, maskName, maskPhone, piiVisible,
} from '../mcp.util';
import { OFFERED_SQL, SOLD_OUT_SQL } from '../../menu/availability';
import { defineTool, type McpTool } from './types';

const EXCLUDED = `('cancelled', 'awaiting_payment')`;

async function orgInfo(tx: Tx, orgId: string) {
  return tx.one<{ timezone: string; currency: string }>('select timezone, currency from organizations where id = $1', [orgId]);
}

const toBranch = (b: any) => ({ id: b.id, code: b.code, name: b.name, nameAr: b.name_ar, isActive: b.is_active });

const orderSummary = (ctx: TenantContext) => (o: any) => ({
  id: o.id, number: o.number, branchId: o.branch_id, branchName: o.branch_name, status: o.status, paymentStatus: o.payment_status,
  channel: o.channel, fulfillment: o.fulfillment, currency: o.currency, totalMinor: o.total_minor, paidMinor: o.paid_minor,
  itemCount: o.item_count, customerName: piiVisible(ctx) ? o.customer_name : maskName(o.customer_name), placedAt: iso(o.placed_at)!,
});

const ORDER_COLUMNS = `o.id, o.number, o.branch_id, b.name as branch_name, o.status, o.payment_status, o.channel, o.fulfillment,
  o.currency, o.total_minor, o.paid_minor, o.customer_name, o.placed_at,
  (select coalesce(sum(l.quantity), 0)::int from order_lines l where l.order_id = o.id) as item_count`;

export const readTools: McpTool[] = [
  defineTool('get_restaurant_profile', {
    description: 'Restaurant name, country, currency, timezone and how many branches this connection can see. Start here.',
    async handler(tx, ctx) {
      const org = await tx.one<any>('select id, name, name_ar, slug, country, currency, timezone, default_locale, status from organizations where id = $1', [ctx.orgId]);
      const [{ n }] = await tx.query<{ n: number }>(
        `select count(*)::int as n from branches where org_id = $1 and ($2::uuid[] is null or id = any($2))`, [ctx.orgId, ctx.branchFilter]);
      return {
        id: org.id, name: org.name, nameAr: org.name_ar, slug: org.slug, country: org.country, currency: org.currency,
        timezone: org.timezone, defaultLocale: org.default_locale, status: org.status, branchCount: n,
        actingRole: ctx.role, branchScope: ctx.branchFilter,
      };
    },
  }),

  defineTool('list_branches', {
    description: 'Branches this connection may access, with the services each one offers (dine-in, pickup, delivery, reservations).',
    async handler(tx, ctx) {
      const rows = await tx.query<any>(
        `select * from branches where org_id = $1 and ($2::uuid[] is null or id = any($2)) order by created_at`, [ctx.orgId, ctx.branchFilter]);
      return {
        items: rows.map((b) => ({ ...toBranch(b), city: b.city, acceptsDineIn: b.accepts_dine_in, acceptsPickup: b.accepts_pickup,
          acceptsDelivery: b.accepts_delivery, acceptsReservations: b.accepts_reservations })),
      };
    },
  }),

  defineTool('list_orders', {
    description: 'Orders, newest first, with optional branch/status/fulfillment/date filters (dates in the restaurant timezone). Amounts are integer minor units (piastres/halalas). Paginate with nextCursor.',
    async handler(tx, ctx, input) {
      const { timezone } = await orgInfo(tx, ctx.orgId);
      const scope = branchScope(ctx, input.branchId);
      const cur = decodeCursor(input.cursor, 2);
      const rows = await tx.query<any>(
        `select ${ORDER_COLUMNS} from orders o join branches b on b.id = o.branch_id
          where o.org_id = $1 and ($2::uuid[] is null or o.branch_id = any($2))
            and ($3::text[] is null or o.status::text = any($3)) and ($4::text is null or o.fulfillment::text = $4)
            and ($5::date is null or o.placed_at >= ($5::date)::timestamp at time zone $6)
            and ($7::date is null or o.placed_at < ($7::date + 1)::timestamp at time zone $8)
            and ($9::timestamptz is null or (o.placed_at, o.id) < ($9::timestamptz, $10::uuid))
          order by o.placed_at desc, o.id desc limit $11`,
        [ctx.orgId, scope, input.status ?? null, input.fulfillment ?? null, input.from ?? null, timezone, input.to ?? null, timezone,
          cur?.[0] ?? null, cur?.[1] ?? null, input.limit + 1]);
      const page = rows.slice(0, input.limit);
      const last = page[page.length - 1];
      return {
        items: page.map(orderSummary(ctx)),
        nextCursor: rows.length > input.limit && last ? encodeCursor([new Date(last.placed_at).toISOString(), last.id]) : null,
      };
    },
  }),

  defineTool('get_order', {
    description: 'One order with its lines, modifiers, totals and status timeline. Customer contact details are masked unless the connection role may read customers.',
    async handler(tx, ctx, input) {
      const o = await tx.maybeOne<any>(
        `select ${ORDER_COLUMNS}, o.subtotal_minor, o.discount_minor, o.delivery_fee_minor, o.service_charge_minor, o.tax_minor,
                o.tax_inclusive, o.refunded_minor, o.notes, o.scheduled_for, o.customer_phone, t.label as table_label
           from orders o join branches b on b.id = o.branch_id left join dining_tables t on t.id = o.table_id
          where o.org_id = $1 and o.id = $2`, [ctx.orgId, input.orderId]);
      // Out-of-scope orders are reported as missing, like other tenants' records.
      if (!o || !ctx.canAccessBranch(o.branch_id)) throw notFound('Order');
      const lines = await tx.query<any>(
        `select name, quantity, unit_price_minor, modifiers_total_minor, line_total_minor, modifiers, kitchen_status, notes
           from order_lines where order_id = $1 order by created_at, id`, [o.id]);
      const events = await tx.query<any>(
        `select event_type, to_status, created_at from order_events where order_id = $1 order by id limit 100`, [o.id]);
      const pii = piiVisible(ctx);
      return {
        ...orderSummary(ctx)(o),
        subtotalMinor: o.subtotal_minor, discountMinor: o.discount_minor, deliveryFeeMinor: o.delivery_fee_minor,
        serviceChargeMinor: o.service_charge_minor, taxMinor: o.tax_minor, taxInclusive: o.tax_inclusive, refundedMinor: o.refunded_minor,
        notes: o.notes, tableLabel: o.table_label, scheduledFor: iso(o.scheduled_for),
        customerPhone: pii ? o.customer_phone : maskPhone(o.customer_phone), piiMasked: !pii,
        lines: lines.map((l) => ({
          name: l.name, quantity: l.quantity, unitPriceMinor: l.unit_price_minor, modifiersTotalMinor: l.modifiers_total_minor,
          lineTotalMinor: l.line_total_minor, kitchenStatus: l.kitchen_status, notes: l.notes,
          modifiers: (Array.isArray(l.modifiers) ? l.modifiers : []).map((m: any) => String(m?.option ?? m?.name ?? '')).filter(Boolean),
        })),
        timeline: events.map((e) => ({ status: e.to_status, event: e.event_type, at: iso(e.created_at)! })),
      };
    },
  }),

  defineTool('list_reservations', {
    description: 'Reservations for one day (default today, restaurant timezone), ordered by start time. Guest phone numbers are masked unless the role may read customers.',
    async handler(tx, ctx, input) {
      const { timezone } = await orgInfo(tx, ctx.orgId);
      const scope = branchScope(ctx, input.branchId);
      const cur = decodeCursor(input.cursor, 2);
      const [{ day }] = await tx.query<{ day: string }>(`select coalesce($1::date, (now() at time zone $2)::date)::text as day`, [input.date ?? null, timezone]);
      const rows = await tx.query<any>(
        `select r.id, r.code, r.branch_id, b.name as branch_name, r.guest_name, r.guest_phone, r.party_size, r.starts_at, r.ends_at,
                r.status, t.label as table_label, r.deposit_minor, r.deposit_status, r.source
           from reservations r join branches b on b.id = r.branch_id left join dining_tables t on t.id = r.table_id
          where r.org_id = $1 and ($2::uuid[] is null or r.branch_id = any($2))
            and r.starts_at >= ($3::date)::timestamp at time zone $4 and r.starts_at < ($5::date + 1)::timestamp at time zone $6
            and ($7::text[] is null or r.status::text = any($7))
            and ($8::timestamptz is null or (r.starts_at, r.id) > ($8::timestamptz, $9::uuid))
          order by r.starts_at, r.id limit $10`,
        [ctx.orgId, scope, day, timezone, day, timezone, input.status ?? null, cur?.[0] ?? null, cur?.[1] ?? null, input.limit + 1]);
      const pii = piiVisible(ctx);
      const page = rows.slice(0, input.limit);
      const last = page[page.length - 1];
      return {
        date: day, timezone, piiMasked: !pii,
        items: page.map((r) => ({
          id: r.id, code: r.code, branchId: r.branch_id, branchName: r.branch_name,
          guestName: pii ? r.guest_name : (maskName(r.guest_name) ?? ''), guestPhone: pii ? r.guest_phone : maskPhone(r.guest_phone),
          partySize: r.party_size, startsAt: iso(r.starts_at)!, endsAt: iso(r.ends_at)!, status: r.status, tableLabel: r.table_label,
          depositMinor: r.deposit_minor, depositStatus: r.deposit_status, source: r.source,
        })),
        nextCursor: rows.length > input.limit && last ? encodeCursor([new Date(last.starts_at).toISOString(), last.id]) : null,
      };
    },
  }),

  defineTool('search_customers', {
    description: 'Find customers by name, phone digits or email fragment (max 25 results, no export). Phone/email are masked unless the connection role may read customers. Branch-scoped connections only see customers who ordered at their branches.',
    async handler(tx, ctx, input) {
      const pattern = `%${escapeLike(input.query)}%`;
      const digits = input.query.replace(/\D/g, '');
      const scope = ctx.branchFilter;
      const rows = await tx.query<any>(
        `select c.id, c.display_name, c.phone_e164, c.email::text as email, c.marketing_consent,
                count(o.id)::int as orders_count,
                coalesce(sum(o.total_minor) filter (where o.status not in ${EXCLUDED}), 0)::bigint as total_spent,
                max(o.placed_at) as last_order_at
           from customers c
           left join orders o on o.customer_id = c.id and o.org_id = c.org_id and ($2::uuid[] is null or o.branch_id = any($2))
          where c.org_id = $1
            and (c.display_name ilike $3 or c.email::text ilike $4 or ($5::text <> '' and c.phone_e164 like $6))
          group by c.id
         having $7::uuid[] is null or count(o.id) > 0
          order by max(o.placed_at) desc nulls last, c.display_name
          limit $8`,
        [ctx.orgId, scope, pattern, pattern, digits.length >= 4 ? digits : '', `%${digits}%`, scope, input.limit]);
      const pii = piiVisible(ctx);
      return {
        piiMasked: !pii,
        items: rows.map((c) => ({
          id: c.id, displayName: pii ? c.display_name : maskName(c.display_name),
          phone: pii ? c.phone_e164 : maskPhone(c.phone_e164), email: pii ? c.email : maskEmail(c.email),
          marketingConsent: c.marketing_consent, ordersCount: c.orders_count, totalSpentMinor: c.total_spent, lastOrderAt: iso(c.last_order_at),
        })),
      };
    },
  }),

  defineTool('get_sales_summary', {
    description: 'Deterministic sales figures for a period (restaurant timezone): order count, revenue, average order value, discounts, payments and refunds, split by fulfillment and channel. Computed by SQL, never estimated.',
    async handler(tx, ctx, input) {
      assertPeriod(input.from, input.to);
      const { timezone, currency } = await orgInfo(tx, ctx.orgId);
      const scope = branchScope(ctx, input.branchId);
      const where = `o.org_id = $1 and ($2::uuid[] is null or o.branch_id = any($2))
        and o.placed_at >= ($3::date)::timestamp at time zone $4 and o.placed_at < ($5::date + 1)::timestamp at time zone $6`;
      const params = [ctx.orgId, scope, input.from, timezone, input.to, timezone];
      const [t] = await tx.query<any>(
        `select count(*) filter (where o.status not in ${EXCLUDED})::int as orders,
                coalesce(sum(o.total_minor) filter (where o.status not in ${EXCLUDED}), 0)::bigint as revenue,
                coalesce(sum(o.discount_minor) filter (where o.status not in ${EXCLUDED}), 0)::bigint as discount,
                coalesce(sum(o.paid_minor), 0)::bigint as paid,
                coalesce(sum(o.refunded_minor), 0)::bigint as refunded,
                count(*) filter (where o.status = 'cancelled')::int as cancelled
           from orders o where ${where}`, params);
      const split = (col: string) => tx.query<any>(
        `select o.${col}::text as k, count(*)::int as orders, coalesce(sum(o.total_minor), 0)::bigint as revenue
           from orders o where ${where} and o.status not in ${EXCLUDED} group by o.${col} order by revenue desc, k`, params);
      const [byF, byC] = [await split('fulfillment'), await split('channel')];
      return {
        currency, from: input.from, to: input.to, timezone, branchId: input.branchId ?? null,
        orders: t.orders, revenueMinor: t.revenue, averageOrderValueMinor: t.orders ? Math.round(t.revenue / t.orders) : 0,
        discountMinor: t.discount, paidMinor: t.paid, refundedMinor: t.refunded, cancelledOrders: t.cancelled,
        byFulfillment: byF.map((r) => ({ fulfillment: r.k, orders: r.orders, revenueMinor: r.revenue })),
        byChannel: byC.map((r) => ({ channel: r.k, orders: r.orders, revenueMinor: r.revenue })),
        method: 'deterministic_sql' as const,
        definition: 'Revenue = sum of order totals (after discounts, including delivery fee and tax as charged) for orders placed in the period, excluding cancelled and unpaid-online (awaiting_payment) orders. AOV = revenue / orders, rounded. paid/refunded = amounts recorded against orders placed in the period. Integer minor units.',
      };
    },
  }),

  defineTool('list_top_items', {
    description: 'Best-selling menu items for a period by quantity or revenue (excludes cancelled orders and cancelled lines).',
    async handler(tx, ctx, input) {
      assertPeriod(input.from, input.to);
      const { timezone, currency } = await orgInfo(tx, ctx.orgId);
      const scope = branchScope(ctx, input.branchId);
      const rows = await tx.query<any>(
        `select l.product_id, min(l.name) as name, sum(l.quantity)::int as quantity, sum(l.line_total_minor)::bigint as revenue,
                count(distinct o.id)::int as orders
           from order_lines l join orders o on o.id = l.order_id
          where o.org_id = $1 and ($2::uuid[] is null or o.branch_id = any($2)) and o.status not in ${EXCLUDED}
            and l.kitchen_status <> 'cancelled'
            and o.placed_at >= ($3::date)::timestamp at time zone $4 and o.placed_at < ($5::date + 1)::timestamp at time zone $6
          group by l.product_id, case when l.product_id is null then l.name end
          order by ${input.by === 'revenue' ? 'revenue' : 'quantity'} desc, name limit $7`,
        [ctx.orgId, scope, input.from, timezone, input.to, timezone, input.limit]);
      return {
        currency, from: input.from, to: input.to, by: input.by,
        items: rows.map((r) => ({ productId: r.product_id, name: r.name, quantity: r.quantity, revenueMinor: r.revenue, orders: r.orders })),
      };
    },
  }),

  defineTool('get_inventory_status', {
    description: 'Stock on hand per inventory item and branch with reorder levels, plus unit stock of stock-tracked menu products.',
    async handler(tx, ctx, input) {
      const scope = branchScope(ctx, input.branchId);
      const items = await tx.query<any>(
        `select i.id, i.name, i.unit, s.branch_id, b.name as branch_name, s.quantity, i.reorder_level
           from stock_levels s join inventory_items i on i.id = s.item_id join branches b on b.id = s.branch_id
          where s.org_id = $1 and i.is_active and ($2::uuid[] is null or s.branch_id = any($2))
          order by i.name, b.name limit $3`, [ctx.orgId, scope, input.limit]);
      const products = await tx.query<any>(
        `select p.id, p.name, s.branch_id, s.stock_qty, ${OFFERED_SQL} as offered, ${SOLD_OUT_SQL} as sold_out
           from products p join product_branch_settings s on s.product_id = p.id
          where p.org_id = $1 and p.is_active and p.track_stock and s.stock_qty is not null
            and ($2::uuid[] is null or s.branch_id = any($2))
          order by s.stock_qty, p.name limit $3`, [ctx.orgId, scope, input.limit]);
      return {
        items: items.map((r) => {
          const quantity = Number(r.quantity), reorderLevel = Number(r.reorder_level);
          return { itemId: r.id, name: r.name, unit: r.unit, branchId: r.branch_id, branchName: r.branch_name, quantity, reorderLevel,
            low: quantity <= 0 || (reorderLevel > 0 && quantity <= reorderLevel) };
        }),
        // FT-02 / DF-01: offered here, not 86'd and in stock (the ordering rules); soldOut / offered say which one failed.
        trackedProducts: products.map((p) => ({ productId: p.id, name: p.name, branchId: p.branch_id, stockQty: p.stock_qty,
          offered: p.offered, soldOut: p.sold_out, available: p.offered && !p.sold_out && p.stock_qty > 0 })),
      };
    },
  }),

  defineTool('list_low_stock', {
    description: 'Inventory items at or below their reorder level (or out of stock), with the shortfall, and stock-tracked products that are sold out.',
    async handler(tx, ctx, input) {
      const scope = branchScope(ctx, input.branchId);
      const items = await tx.query<any>(
        `select i.id, i.name, i.unit, s.branch_id, b.name as branch_name, s.quantity, i.reorder_level
           from stock_levels s join inventory_items i on i.id = s.item_id join branches b on b.id = s.branch_id
          where s.org_id = $1 and i.is_active and ($2::uuid[] is null or s.branch_id = any($2))
            and (s.quantity <= 0 or (i.reorder_level > 0 and s.quantity <= i.reorder_level))
          order by (s.quantity - i.reorder_level), i.name limit 200`, [ctx.orgId, scope]);
      const soldOut = await tx.query<any>(
        `select p.id, p.name, pbs.branch_id from products p join product_branch_settings pbs on pbs.product_id = p.id
          where p.org_id = $1 and p.is_active and p.track_stock and pbs.stock_qty is not null and pbs.stock_qty <= 0
            and ($2::uuid[] is null or pbs.branch_id = any($2)) order by p.name limit 200`, [ctx.orgId, scope]);
      return {
        items: items.map((r) => {
          const quantity = Number(r.quantity), reorderLevel = Number(r.reorder_level);
          return { itemId: r.id, name: r.name, unit: r.unit, branchId: r.branch_id, branchName: r.branch_name, quantity, reorderLevel,
            shortfall: Math.max(reorderLevel - quantity, 0) };
        }),
        soldOutProducts: soldOut.map((p) => ({ productId: p.id, name: p.name, branchId: p.branch_id })),
      };
    },
  }),

  defineTool('list_insights', {
    description: 'Insights produced by Resuto Intelligence (sales, inventory, marketing, operations), newest first. Each insight states its method (deterministic, model or llm) and evidence.',
    async handler(tx, ctx, input) {
      const scope = branchScope(ctx, input.branchId);
      const rows = await tx.query<any>(
        `select id, kind, severity, title, body, method, status, branch_id, evidence, template_key, template_params, created_at from ai_insights
          where org_id = $1 and (branch_id is null or $2::uuid[] is null or branch_id = any($2))
            and ($3::uuid is null or branch_id = $3)
            and status = any($4::text[]) and ($5::text[] is null or severity = any($5))
          order by created_at desc limit $6`,
        [ctx.orgId, scope, input.branchId ?? null, input.status ?? ['new', 'seen'], input.severity ?? null, input.limit]);
      return {
        items: rows.map((r) => ({ id: r.id, kind: r.kind, severity: r.severity, title: r.title, body: r.body, method: r.method,
          status: r.status, branchId: r.branch_id, evidence: r.evidence ?? {},
          // FT-15: clients render title/body in their language from the template (renderInsight in @resuto/contracts).
          templateKey: r.template_key ?? null, params: r.template_params ?? null, createdAt: iso(r.created_at)! })),
      };
    },
  }),

  defineTool('get_approval_status', {
    description: 'Status of an approval request created by a sensitive tool (pending, executed, rejected, expired or failed) and, once executed, its result.',
    async handler(tx, ctx, input) {
      if (ctx.actorType !== 'mcp_client') throw new DomainError('forbidden', 'Approvals belong to MCP clients', 403);
      const a = await tx.maybeOne<any>(
        `select id, tool, status, summary, requested_at, expires_at, decided_at, executed_at, result, error from mcp_approvals
          where org_id = $1 and id = $2 and client_id = $3`, [ctx.orgId, input.approvalId, ctx.actorId]);
      if (!a) throw notFound('Approval');
      const expired = a.status === 'pending' && new Date(a.expires_at).getTime() <= Date.now();
      // Payment URLs carry a guest bearer token: hand them to the client once, then keep only a marker.
      if (a.status === 'executed' && a.result && typeof a.result === 'object' && typeof a.result.url === 'string') {
        await tx.query(`update mcp_approvals set result = (result - 'url') || '{"urlDelivered": true}'::jsonb where id = $1`, [a.id]);
      }
      return {
        approvalId: a.id, tool: a.tool, status: expired ? 'expired' : a.status, summary: a.summary,
        requestedAt: iso(a.requested_at)!, expiresAt: iso(a.expires_at)!, decidedAt: iso(a.decided_at), executedAt: iso(a.executed_at),
        result: a.result ?? null, error: a.error ?? null,
      };
    },
  }),
];
