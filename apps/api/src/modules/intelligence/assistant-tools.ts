// Deterministic, authorized read tools for the owner assistant. Every number the assistant
// shows comes from one of these SQL-backed tools; the LLM (when configured) only chooses tools
// and phrases the answer.
import type { Permission } from '@resuto/contracts';
import { z } from 'zod';
import type { TenantContext } from '../../common/auth/context';
import type { Tx } from '../../common/db/db.service';
import { addDays } from './calendar';
import { SOLD } from './data.service';

export const PERIODS = ['today', 'yesterday', 'last_7_days', 'last_30_days', 'this_month', 'last_month'] as const;
export type Period = (typeof PERIODS)[number];

export function periodRange(period: Period, today: string): { from: string; to: string } {
  switch (period) {
    case 'today': return { from: today, to: today };
    case 'yesterday': return { from: addDays(today, -1), to: addDays(today, -1) };
    case 'last_7_days': return { from: addDays(today, -6), to: today };
    case 'last_30_days': return { from: addDays(today, -29), to: today };
    case 'this_month': return { from: `${today.slice(0, 7)}-01`, to: today };
    case 'last_month': {
      const first = `${today.slice(0, 7)}-01`;
      const lastPrev = addDays(first, -1);
      return { from: `${lastPrev.slice(0, 7)}-01`, to: lastPrev };
    }
  }
}

export interface ToolEnv {
  tx: Tx;
  ctx: TenantContext;
  today: string;
  currency: string;
  /** Branch filter: explicit branch or the caller's scope (null = all branches). */
  branches: string[] | null;
  defaultBranchId: string | null;
  forecast(branchId: string, productId: string | undefined, horizon: number): Promise<any>;
}

export interface AssistantTool<A extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  permission: Permission;
  args: A;
  /** Gemini function declaration parameters (OpenAPI subset). */
  parameters: Record<string, unknown>;
  /** Tools that call the AI service run outside the read transaction. */
  external?: boolean;
  run(env: ToolEnv, args: any): Promise<Record<string, unknown>>;
}

const periodParam = { type: 'STRING', enum: [...PERIODS], description: 'Reporting period in the restaurant time zone' };
const branchFilterSql = `($3::uuid[] is null or o.branch_id = any($3::uuid[]))`;

const salesSummary: AssistantTool = {
  name: 'sales_summary',
  description: 'Orders, revenue and average order value for a period (excludes cancelled and unpaid online orders).',
  permission: 'analytics:read',
  args: z.object({ period: z.enum(PERIODS).default('today') }),
  parameters: { type: 'OBJECT', properties: { period: periodParam }, required: ['period'] },
  async run(env, args) {
    const { from, to } = periodRange(args.period, env.today);
    const r = await env.tx.one<any>(
      `select count(*) filter (where ${SOLD})::int as orders, coalesce(sum(o.total_minor) filter (where ${SOLD}), 0)::bigint as revenue,
              count(*) filter (where o.status = 'cancelled')::int as cancelled,
              count(*) filter (where ${SOLD} and o.fulfillment = 'dine_in')::int as dine_in,
              count(*) filter (where ${SOLD} and o.fulfillment = 'pickup')::int as pickup,
              count(*) filter (where ${SOLD} and o.fulfillment = 'delivery')::int as delivery
         from orders o where o.org_id = $1 and o.business_date between $2::date and $4::date and ${branchFilterSql}`,
      [env.ctx.orgId, from, env.branches, to]);
    return {
      period: args.period, from, to, currency: env.currency, orders: r.orders, revenueMinor: Number(r.revenue),
      averageOrderMinor: r.orders ? Math.round(Number(r.revenue) / r.orders) : 0, cancelledOrders: r.cancelled,
      byFulfillment: { dineIn: r.dine_in, pickup: r.pickup, delivery: r.delivery },
    };
  },
};

const topItems: AssistantTool = {
  name: 'top_items',
  description: 'Best-selling (direction=top) or worst-selling (direction=bottom, includes active items with no sales) menu items for a period.',
  permission: 'analytics:read',
  args: z.object({ period: z.enum(PERIODS).default('last_7_days'), direction: z.enum(['top', 'bottom']).default('top'), limit: z.number().int().min(1).max(10).default(5) }),
  parameters: { type: 'OBJECT', properties: { period: periodParam, direction: { type: 'STRING', enum: ['top', 'bottom'] }, limit: { type: 'INTEGER', minimum: 1, maximum: 10 } }, required: ['period'] },
  async run(env, args) {
    const { from, to } = periodRange(args.period, env.today);
    const rows = await env.tx.query<any>(
      `select p.id, p.name, p.name_ar, coalesce(s.qty, 0)::int as quantity, coalesce(s.revenue, 0)::bigint as revenue
         from products p left join (
           select ol.product_id, sum(ol.quantity) as qty, sum(ol.line_total_minor) as revenue
             from order_lines ol join orders o on o.id = ol.order_id
            where o.org_id = $1 and ${SOLD} and ol.kitchen_status <> 'cancelled' and o.business_date between $2::date and $4::date and ${branchFilterSql}
            group by ol.product_id) s on s.product_id = p.id
        where p.org_id = $1 and (p.is_active or s.qty is not null)
        order by case when $5 = 'top' then -coalesce(s.qty, 0) else coalesce(s.qty, 0) end, p.name limit $6`,
      [env.ctx.orgId, from, env.branches, to, args.direction, args.limit]);
    return { period: args.period, from, to, direction: args.direction, currency: env.currency,
      items: rows.map((r) => ({ productId: r.id, name: r.name, nameAr: r.name_ar, quantity: r.quantity, revenueMinor: Number(r.revenue) })) };
  },
};

const lowStock: AssistantTool = {
  name: 'low_stock',
  description: 'Inventory items at or below their reorder level and stock-tracked menu items with 5 or fewer left.',
  permission: 'inventory:read',
  args: z.object({}),
  parameters: { type: 'OBJECT', properties: {} },
  async run(env) {
    const items = await env.tx.query<any>(
      `select i.name, i.name_ar, i.unit, l.quantity::float8 as quantity, i.reorder_level::float8 as reorder_level, b.name as branch
         from inventory_items i join stock_levels l on l.item_id = i.id join branches b on b.id = l.branch_id
        where i.org_id = $1 and i.is_active and l.quantity <= i.reorder_level and ($2::uuid[] is null or l.branch_id = any($2::uuid[]))
        order by l.quantity - i.reorder_level limit 20`, [env.ctx.orgId, env.branches]);
    const products = await env.tx.query<any>(
      `select p.name, p.name_ar, s.stock_qty, b.name as branch from products p
         join product_branch_settings s on s.product_id = p.id join branches b on b.id = s.branch_id
        where p.org_id = $1 and p.is_active and p.track_stock and s.stock_qty is not null and s.stock_qty <= 5
          and ($2::uuid[] is null or s.branch_id = any($2::uuid[])) order by s.stock_qty, p.name limit 20`, [env.ctx.orgId, env.branches]);
    return {
      inventory: items.map((i) => ({ name: i.name, nameAr: i.name_ar, unit: i.unit, quantity: i.quantity, reorderLevel: i.reorder_level, branch: i.branch })),
      menuItems: products.map((p) => ({ name: p.name, nameAr: p.name_ar, stock: p.stock_qty, branch: p.branch })),
    };
  },
};

const reservationsToday: AssistantTool = {
  name: 'reservations_today',
  description: 'Reservations starting today (counts, covers and times; no guest contact details).',
  permission: 'reservations:read',
  args: z.object({}),
  parameters: { type: 'OBJECT', properties: {} },
  async run(env) {
    const rows = await env.tx.query<any>(
      `select to_char(r.starts_at at time zone coalesce(b.timezone, o.timezone), 'HH24:MI') as time, r.party_size, r.status::text as status
         from reservations r join branches b on b.id = r.branch_id join organizations o on o.id = r.org_id
        where r.org_id = $1 and (r.starts_at at time zone coalesce(b.timezone, o.timezone))::date = $2::date
          and r.status in ('held', 'pending_deposit', 'confirmed', 'seated', 'completed') and ($3::uuid[] is null or r.branch_id = any($3::uuid[]))
        order by r.starts_at limit 100`, [env.ctx.orgId, env.today, env.branches]);
    return { date: env.today, reservations: rows.length, covers: rows.reduce((s, r) => s + r.party_size, 0),
      slots: rows.map((r) => ({ time: r.time, partySize: r.party_size, status: r.status })) };
  },
};

const insights: AssistantTool = {
  name: 'insights',
  description: 'The newest open insights (alerts and opportunities) with severity.',
  permission: 'ai:use',
  args: z.object({ limit: z.number().int().min(1).max(10).default(5) }),
  parameters: { type: 'OBJECT', properties: { limit: { type: 'INTEGER', minimum: 1, maximum: 10 } } },
  async run(env, args) {
    const rows = await env.tx.query<any>(
      `select title, severity, kind, method, created_at from ai_insights where org_id = $1 and status in ('new', 'seen')
          and ($2::uuid[] is null or branch_id is null or branch_id = any($2::uuid[])) order by created_at desc limit $3`,
      [env.ctx.orgId, env.branches, args.limit]);
    return { insights: rows.map((r) => ({ title: r.title, severity: r.severity, kind: r.kind, method: r.method })) };
  },
};

const demandForecast: AssistantTool = {
  name: 'demand_forecast',
  description: 'Forecast of daily item demand for the next 7–14 days for the top items of a branch (model, backtest error and 80% intervals).',
  permission: 'ai:use',
  external: true,
  args: z.object({ days: z.number().int().min(7).max(14).default(7) }),
  parameters: { type: 'OBJECT', properties: { days: { type: 'INTEGER', minimum: 7, maximum: 14 } } },
  async run(env, args) {
    if (!env.defaultBranchId) return { items: [], note: 'no_branch' };
    const fc = await env.forecast(env.defaultBranchId, undefined, args.days);
    return {
      branchId: env.defaultBranchId, asOf: fc.asOf, days: args.days,
      items: fc.items.map((it: any) => ({
        name: it.name, nameAr: it.nameAr, model: it.model,
        total: Math.round(it.forecast.reduce((s: number, p: any) => s + p.yhat, 0) * 10) / 10,
        lowerTotal: Math.round(it.forecast.reduce((s: number, p: any) => s + p.lower, 0) * 10) / 10,
        upperTotal: Math.round(it.forecast.reduce((s: number, p: any) => s + p.upper, 0) * 10) / 10,
        backtestWape: it.candidates.find((c: any) => c.model === it.model)?.metrics?.wape ?? null,
      })),
    };
  },
};

export const ASSISTANT_TOOLS: AssistantTool[] = [salesSummary, topItems, lowStock, reservationsToday, insights, demandForecast];
export const toolByName = (name: string) => ASSISTANT_TOOLS.find((t) => t.name === name);
