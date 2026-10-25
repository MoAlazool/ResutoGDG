// FT-17 read tools: menu (ids for update_product_availability), finance P&L (the finance module's own computation),
// payments (read-only, masked), delivery status, and query_data: a bounded, schema-based query compiled from fixed SQL
// fragments. No input string ever becomes SQL text; values are bound parameters.
import { ORDER_STATUSES, untrusted } from '@resuto/contracts';
import { QUERY_DATASETS, type QueryDataset } from '@resuto/contracts/mcp-tools';
import { DomainError } from '../../../common/errors/domain-error';
import type { Tx } from '../../../common/db/db.service';
import type { TenantContext } from '../../../common/auth/context';
import { OFFERED_SQL, SOLD_OUT_SQL } from '../../menu/availability';
import { assertPeriod, branchScope, decodeCursor, encodeCursor, escapeLike, invalidInput, iso, maskName, piiVisible } from '../mcp.util';
import { defineTool, type McpTool } from './types';

async function orgInfo(tx: Tx, orgId: string) {
  return tx.one<{ timezone: string; currency: string }>('select timezone, currency from organizations where id = $1', [orgId]);
}

/** A provider reference is shown only by its last 4 characters (enough to find it in the provider dashboard). */
const maskRef = (v: string | null | undefined) => (v ? `…${v.slice(-4)}` : null);

// ---------------------------------------------------------------------------
// query_data: whitelisted SQL fragments per dataset. Keys come from the validated enum input only.
// ---------------------------------------------------------------------------
interface DatasetSql {
  from: string;
  time: string;
  branch: string;
  status: string;
  defaultStatuses: string[] | null;
  extraWhere?: (input: { includeTest: boolean }) => string;
  measures: Record<string, string>;
  groups: Record<string, string>;
  permissions: Array<'payments:read' | 'reservations:read' | 'orders:read'>;
  definition: string;
}

const timeGroups = (col: string) => ({
  day: `to_char((${col} at time zone $tz)::date, 'YYYY-MM-DD')`,
  week: `to_char(date_trunc('week', ${col} at time zone $tz)::date, 'YYYY-MM-DD')`,
  month: `to_char(date_trunc('month', ${col} at time zone $tz), 'YYYY-MM')`,
  weekday: `extract(isodow from ${col} at time zone $tz)::int`,
  hour: `extract(hour from ${col} at time zone $tz)::int`,
});

/** Orders that count as sales: everything except cancelled and unpaid online orders. */
const SOLD = ORDER_STATUSES.filter((s) => s !== 'cancelled' && s !== 'awaiting_payment') as string[];

const DATASETS: Record<QueryDataset, DatasetSql> = {
  orders: {
    from: 'orders o join branches b on b.id = o.branch_id', time: 'o.placed_at', branch: 'o.branch_id', status: 'o.status::text',
    defaultStatuses: SOLD,
    measures: { count: 'count(*)::int', revenue_minor: 'coalesce(sum(o.total_minor), 0)::bigint', avg_order_value_minor: 'coalesce(round(avg(o.total_minor)), 0)::bigint',
      discount_minor: 'coalesce(sum(o.discount_minor), 0)::bigint' },
    groups: { ...timeGroups('o.placed_at'), branch: 'b.name', channel: 'o.channel::text', fulfillment: 'o.fulfillment::text', status: 'o.status::text' },
    permissions: ['orders:read'],
    definition: 'One row per order placed in the period (restaurant timezone). Default statuses exclude cancelled and awaiting_payment. revenue_minor = sum of order totals as charged; avg_order_value_minor = rounded mean order total. Integer minor units.',
  },
  order_items: {
    from: 'order_lines l join orders o on o.id = l.order_id join branches b on b.id = o.branch_id left join products p on p.id = l.product_id left join menu_categories c on c.id = p.category_id',
    time: 'o.placed_at', branch: 'o.branch_id', status: 'o.status::text',
    defaultStatuses: SOLD,
    extraWhere: () => `l.kitchen_status <> 'cancelled'`,
    measures: { quantity: 'coalesce(sum(l.quantity), 0)::int', revenue_minor: 'coalesce(sum(l.line_total_minor), 0)::bigint', count: 'count(distinct o.id)::int' },
    groups: { ...timeGroups('o.placed_at'), branch: 'b.name', channel: 'o.channel::text', fulfillment: 'o.fulfillment::text', product: 'l.name',
      category: `coalesce(c.name, 'Uncategorised')` },
    permissions: ['orders:read'],
    definition: 'Sold order lines (cancelled lines excluded) of orders placed in the period. quantity = items sold; revenue_minor = line totals including modifiers; count = distinct orders. Integer minor units.',
  },
  reservations: {
    from: 'reservations r join branches b on b.id = r.branch_id', time: 'r.starts_at', branch: 'r.branch_id', status: 'r.status::text', defaultStatuses: null,
    measures: { count: 'count(*)::int', covers: 'coalesce(sum(r.party_size), 0)::int' },
    groups: { ...timeGroups('r.starts_at'), branch: 'b.name', status: 'r.status::text', source: 'r.source' },
    permissions: ['reservations:read'],
    definition: 'Reservations starting in the period (restaurant timezone). covers = sum of party sizes.',
  },
  payments: {
    from: 'payments y join branches b on b.id = y.branch_id', time: 'coalesce(y.captured_at, y.created_at)', branch: 'y.branch_id', status: 'y.status::text',
    defaultStatuses: ['succeeded', 'refunded', 'partially_refunded'],
    extraWhere: ({ includeTest }) => (includeTest ? 'true' : 'not y.is_test'),
    measures: { count: 'count(*)::int', amount_minor: 'coalesce(sum(y.amount_minor), 0)::bigint', refunded_minor: 'coalesce(sum(y.refunded_minor), 0)::bigint' },
    groups: { ...timeGroups('coalesce(y.captured_at, y.created_at)'), branch: 'b.name', method: 'y.method::text', provider: 'y.provider', status: 'y.status::text' },
    permissions: ['payments:read'],
    definition: 'Payment attempts captured (or created, if never captured) in the period. Default statuses: succeeded, refunded, partially_refunded. Sandbox (test) payments are excluded unless includeTest. Integer minor units.',
  },
};

export const dataTools: McpTool[] = [
  defineTool('list_menu', {
    description: 'Menu items with ids, categories, prices and availability (per branch, or at one branch with branchId). Use the productId and branchId with update_product_availability. Prices are integer minor units.',
    async handler(tx, ctx, input) {
      const { currency } = await orgInfo(tx, ctx.orgId);
      const scope = branchScope(ctx, input.branchId);
      const cur = decodeCursor(input.cursor, 3);
      const pattern = input.query ? `%${escapeLike(input.query)}%` : null;
      const rows = await tx.query<any>(
        `select p.id, p.name, p.name_ar, p.price_minor, p.dietary, p.allergens, p.track_stock, c.name as category, c.name_ar as category_ar, c.sort_order, p.sort_order as psort,
                (${OFFERED_SQL} and not ${SOLD_OUT_SQL}) as branch_available, s.price_override_minor, s.stock_qty,
                (select coalesce(array_agg(s.branch_id::text order by s.branch_id), '{}') from product_branch_settings s
                  where s.product_id = p.id and (not ${OFFERED_SQL} or ${SOLD_OUT_SQL}) and ($3::uuid[] is null or s.branch_id = any($3))) as unavailable_at,
                (select count(*)::int from product_modifier_groups g where g.product_id = p.id) as groups
           from products p join menu_categories c on c.id = p.category_id
           left join product_branch_settings s on s.product_id = p.id and s.branch_id = $2
          where p.org_id = $1 and p.is_active and c.is_active
            and ($4::text is null or p.name ilike $4 or coalesce(p.name_ar, '') ilike $4)
            and ($5::text is null or lower(c.name) = lower($5))
            and ($6::int is null or (c.sort_order, p.sort_order, p.id) > ($6::int, $7::int, $8::uuid))
          order by c.sort_order, p.sort_order, p.id limit $9`,
        [ctx.orgId, input.branchId ?? null, scope, pattern, input.category ?? null, cur ? Number(cur[0]) : null, cur ? Number(cur[1]) : null, cur?.[2] ?? null,
          (input.limit + 1) * (input.availableOnly ? 3 : 1)]);
      // FT-02 / DF-01 (ws5): "available" means offered at the branch and not sold out (86), the same rule ordering and
      // update_product_availability use; the subquery's `s` is product_branch_settings, as the shared fragments expect.
      const items = rows.map((r) => {
        const available = input.branchId ? r.branch_available ?? true : null;
        return {
          productId: r.id, name: r.name, nameAr: r.name_ar, category: r.category, categoryAr: r.category_ar,
          priceMinor: Number(input.branchId && r.price_override_minor !== null ? r.price_override_minor : r.price_minor), basePriceMinor: Number(r.price_minor),
          available, unavailableAtBranchIds: r.unavailable_at as string[], stockQty: input.branchId && r.track_stock ? r.stock_qty ?? null : null,
          dietary: r.dietary ?? [], allergens: r.allergens ?? [], modifierGroups: r.groups, _sort: [r.sort_order, r.psort, r.id],
        };
      }).filter((i) => !input.availableOnly || (input.branchId ? i.available : i.unavailableAtBranchIds.length === 0));
      const page = items.slice(0, input.limit);
      const last = page[page.length - 1];
      return {
        currency, branchId: input.branchId ?? null,
        items: page.map(({ _sort, ...i }) => i),
        nextCursor: (items.length > input.limit || rows.length > input.limit * (input.availableOnly ? 3 : 1)) && last ? encodeCursor(last._sort) : null,
      };
    },
  }),

  defineTool('get_finance_summary', {
    description: 'Profit and loss for a period, computed by the Resuto finance module from stored orders, refunds, expenses and payment fees (restaurant business dates): gross sales, discounts, refunds, VAT, net revenue, COGS, gross profit, operating expenses, fees, operating profit, with coverage warnings. Never estimated.',
    available: (ports) => !!ports.finance,
    async handler(tx, ctx, input, ports) {
      assertPeriod(input.from, input.to);
      if (!ports.finance) throw new DomainError('module_unavailable', 'Finance is not available in this deployment', 503);
      if (input.branchId) ctx.assertBranch(input.branchId);
      else if (ctx.branchFilter) {
        if (ctx.branchFilter.length !== 1) throw invalidInput('This connection is limited to some branches: pass branchId for one of them');
      }
      const branchId = input.branchId ?? ctx.branchFilter?.[0];
      const p = await ports.finance.pnlTx(tx, { from: input.from, to: input.to, ...(branchId ? { branchId } : {}) });
      return {
        currency: p.currency, from: p.period.from, to: p.period.to, branchId: p.period.branchId,
        grossSalesMinor: p.lines.grossSalesMinor, discountsMinor: p.lines.discountsMinor, refundsMinor: p.lines.refundsMinor, vatMinor: p.lines.vatMinor,
        netRevenueMinor: p.lines.netRevenueMinor, cogsMinor: p.lines.cogsMinor, grossProfitMinor: p.lines.grossProfitMinor,
        operatingExpensesMinor: p.lines.operatingExpensesMinor, operatingExpensesByKind: p.lines.operatingExpensesByKind,
        paymentFeesMinor: p.lines.paymentFeesMinor, operatingProfitMinor: p.lines.operatingProfitMinor,
        grossMarginBp: p.grossMarginBp, operatingMarginBp: p.operatingMarginBp,
        coverage: { linesWithoutCost: p.coverage.linesWithoutCost, unpaidOrders: p.coverage.unpaidOrders, paymentsWithUnknownFee: p.coverage.paymentsWithUnknownFee,
          testPayments: p.coverage.testPayments },
        warnings: p.warnings, methodology: p.methodology, method: 'deterministic_sql' as const,
      };
    },
  }),

  defineTool('list_payments', {
    description: 'Payments recorded by Resuto (read-only), newest first: amount, method, provider, status, refunds and fee, linked order or reservation. Provider references are masked to their last 4 characters; card data, tokens and payer details are never returned. Sandbox (test) payments are excluded unless includeTest.',
    async handler(tx, ctx, input) {
      const { timezone } = await orgInfo(tx, ctx.orgId);
      const scope = branchScope(ctx, input.branchId);
      const cur = decodeCursor(input.cursor, 2);
      const rows = await tx.query<any>(
        `select y.id, y.branch_id, y.method::text as method, y.provider, y.status::text as status, y.amount_minor, y.refunded_minor, y.fee_minor, y.currency,
                y.is_test, y.provider_payment_id, y.created_at, y.captured_at, o.number as order_number, r.code as reservation_code
           from payments y left join orders o on o.id = y.order_id left join reservations r on r.id = y.reservation_id
          where y.org_id = $1 and ($2::uuid[] is null or y.branch_id = any($2)) and ($3::boolean or not y.is_test)
            and ($4::text[] is null or y.status::text = any($4))
            and ($5::date is null or y.created_at >= ($5::date)::timestamp at time zone $6)
            and ($7::date is null or y.created_at < ($7::date + 1)::timestamp at time zone $6)
            and ($8::timestamptz is null or (y.created_at, y.id) < ($8::timestamptz, $9::uuid))
          order by y.created_at desc, y.id desc limit $10`,
        [ctx.orgId, scope, input.includeTest, input.status ?? null, input.from ?? null, timezone, input.to ?? null, cur?.[0] ?? null, cur?.[1] ?? null, input.limit + 1]);
      const page = rows.slice(0, input.limit);
      const last = page[page.length - 1];
      return {
        items: page.map((y) => ({
          id: y.id, branchId: y.branch_id, orderNumber: y.order_number ?? null, reservationCode: y.reservation_code ?? null, method: y.method, provider: y.provider,
          status: y.status, amountMinor: Number(y.amount_minor), refundedMinor: Number(y.refunded_minor), feeMinor: y.fee_minor === null ? null : Number(y.fee_minor),
          currency: y.currency, isTest: y.is_test, providerReference: maskRef(y.provider_payment_id), createdAt: iso(y.created_at)!, capturedAt: iso(y.captured_at),
        })),
        nextCursor: rows.length > input.limit && last ? encodeCursor([new Date(last.created_at).toISOString(), last.id]) : null,
        masked: true as const,
      };
    },
  }),

  defineTool('list_delivery_jobs', {
    description: 'Delivery jobs with their status, driver, area, distance and ETA (default: active jobs). Exact addresses, phone numbers and proof photos are never returned; driver names are shortened unless the role may read customers. Read-only: status changes happen in the dispatch board and driver app.',
    async handler(tx, ctx, input) {
      const scope = branchScope(ctx, input.branchId);
      const cur = decodeCursor(input.cursor, 2);
      const statuses = input.status ?? ['unassigned', 'offered', 'assigned', 'accepted', 'picked_up', 'en_route'];
      const rows = await tx.query<any>(
        `select j.id, j.order_id, o.number, j.branch_id, j.status::text as status, d.display_name as driver, j.dropoff->>'area' as area, j.dropoff->>'city' as city,
                j.distance_m, j.eta_at, j.cod_amount_minor, j.cash_status, j.created_at, j.assigned_at, j.picked_up_at, j.delivered_at, j.failure_reason
           from delivery_jobs j join orders o on o.id = j.order_id left join drivers d on d.id = j.driver_id
          where j.org_id = $1 and ($2::uuid[] is null or j.branch_id = any($2)) and j.status::text = any($3)
            and ($4::timestamptz is null or (j.created_at, j.id) < ($4::timestamptz, $5::uuid))
          order by j.created_at desc, j.id desc limit $6`,
        [ctx.orgId, scope, statuses, cur?.[0] ?? null, cur?.[1] ?? null, input.limit + 1]);
      const pii = piiVisible(ctx);
      const page = rows.slice(0, input.limit);
      const last = page[page.length - 1];
      return {
        items: page.map((j) => ({
          id: j.id, orderId: j.order_id, orderNumber: j.number, branchId: j.branch_id, status: j.status,
          driverName: pii ? j.driver ?? null : maskName(j.driver), area: untrusted(j.area), city: untrusted(j.city), distanceM: j.distance_m ?? null,
          etaAt: iso(j.eta_at), codAmountMinor: Number(j.cod_amount_minor), cashStatus: j.cash_status, createdAt: iso(j.created_at)!,
          assignedAt: iso(j.assigned_at), pickedUpAt: iso(j.picked_up_at), deliveredAt: iso(j.delivered_at), failureReason: j.failure_reason ?? null,
        })),
        nextCursor: rows.length > input.limit && last ? encodeCursor([new Date(last.created_at).toISOString(), last.id]) : null,
        piiMasked: !pii,
      };
    },
  }),

  defineTool('query_data', {
    description: 'Bounded analytics query without SQL: choose a dataset (orders, order_items, reservations, payments), up to 3 measures, up to 2 groupings (day/week/month/weekday/hour, branch, channel, fulfillment, status, product, category, source, method, provider), a period of at most 366 days, optional branch and status filters. Resuto compiles it from fixed, parameterised SQL; customer details are never available.',
    async handler(tx, ctx, input) {
      assertPeriod(input.from, input.to);
      const d = DATASETS[input.dataset];
      // Defence in depth: the contract already rejects these combinations.
      const allowed = QUERY_DATASETS[input.dataset];
      for (const m of input.measures) if (!(allowed.measures as readonly string[]).includes(m) || !d.measures[m]) throw invalidInput(`${m} is not available for ${input.dataset}`);
      for (const g of input.groupBy) if (!(allowed.groupBy as readonly string[]).includes(g) || !d.groups[g]) throw invalidInput(`${g} is not available for ${input.dataset}`);
      for (const p of d.permissions) if (!ctx.can(p)) throw new DomainError('forbidden', `The connection's role (${ctx.role}) cannot read ${input.dataset} (${p})`, 403);
      const { timezone, currency } = await orgInfo(tx, ctx.orgId);
      const scope = branchScope(ctx, input.branchId);
      const statuses = input.status ?? d.defaultStatuses;
      const params: unknown[] = [ctx.orgId, scope, input.from, timezone, input.to, statuses];
      const tz = '$4';
      const sub = (frag: string) => frag.replaceAll('$tz', tz);
      const groupCols = input.groupBy.map((g, i) => `${sub(d.groups[g]!)} as g${i}`);
      const measureCols = input.measures.map((m, i) => `${d.measures[m]} as m${i}`);
      const where = [
        `${d.branch.replace(/\..*/, '')}.org_id = $1`, `($2::uuid[] is null or ${d.branch} = any($2))`,
        `${d.time} >= ($3::date)::timestamp at time zone $4`, `${d.time} < ($5::date + 1)::timestamp at time zone $4`,
        `($6::text[] is null or ${d.status} = any($6))`,
        d.extraWhere ? d.extraWhere({ includeTest: input.includeTest }) : 'true',
      ].join(' and ');
      const order = input.sort === 'group_asc' && input.groupBy.length ? input.groupBy.map((_, i) => `g${i} asc`).join(', ')
        : `m0 ${input.sort === 'measure_asc' ? 'asc' : 'desc'}${input.groupBy.map((_, i) => `, g${i} asc`).join('')}`;
      params.push(input.limit + 1);
      const sql = `select ${[...groupCols, ...measureCols].join(', ')} from ${d.from} where ${where}
        ${input.groupBy.length ? `group by ${input.groupBy.map((_, i) => `g${i}`).join(', ')}` : ''} order by ${order} limit $7`;
      await tx.query(`set local statement_timeout = '5s'`);
      const rows = await tx.query<any>(sql, params);
      const columns = [...input.groupBy, ...input.measures];
      return {
        dataset: input.dataset, from: input.from, to: input.to, timezone, currency, branchId: input.branchId ?? null, columns,
        rows: rows.slice(0, input.limit).map((r) => Object.fromEntries(columns.map((c, i) => {
          const v = i < input.groupBy.length ? r[`g${i}`] : r[`m${i - input.groupBy.length}`];
          return [c, v === null || v === undefined ? null : typeof v === 'string' && i >= input.groupBy.length ? Number(v) : typeof v === 'number' ? v : String(v)];
        }))),
        truncated: rows.length > input.limit, method: 'deterministic_sql' as const, definition: d.definition,
      };
    },
  }),
];
