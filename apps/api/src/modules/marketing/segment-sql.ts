import { segmentDefinition, type SegmentGroup, type SegmentRule } from '@resuto/contracts';

/**
 * Compiles the validated segment DSL (contracts/marketing.ts) into a boolean SQL
 * expression over `customers c`. Only the fixed fragments below are emitted;
 * every user value becomes a bound parameter with an explicit cast — nothing
 * from the definition is ever concatenated into SQL text.
 */
export interface CompiledSegment {
  where: string;
  params: unknown[];
}

const LIVE_ORDER = `o.customer_id = c.id and o.status <> 'cancelled'`;

export function compileSegment(definition: unknown, firstParam = 2): CompiledSegment {
  const def = segmentDefinition.parse(definition); // re-validate: callers may pass stored JSON
  const params: unknown[] = [];
  const p = (value: unknown, cast: string) => {
    params.push(value);
    return `$${firstParam + params.length - 1}::${cast}`;
  };
  const within = (days: number | undefined) => (days ? ` and o.placed_at >= now() - make_interval(days => ${p(days, 'int')})` : '');

  const rule = (r: SegmentRule): string => {
    switch (r.type) {
      case 'inactive_days_gte':
        return `coalesce((select max(o.placed_at) from orders o where ${LIVE_ORDER}), c.last_seen_at) < now() - make_interval(days => ${p(r.days, 'int')})`;
      case 'orders_gte':
        return `(select count(*) from orders o where ${LIVE_ORDER}${within(r.withinDays)}) >= ${p(r.count, 'int')}`;
      case 'spent_gte':
        return `(select coalesce(sum(o.total_minor), 0) from orders o where ${LIVE_ORDER}${within(r.withinDays)}) >= ${p(r.amountMinor, 'bigint')}`;
      case 'has_tag':
        return `${p(r.tag, 'text')} = any(c.tags)`;
      case 'consent':
        return `c.marketing_consent = ${p(r.value, 'boolean')}`;
      case 'branch':
        return `exists (select 1 from orders o where ${LIVE_ORDER} and o.branch_id = ${p(r.branchId, 'uuid')})`;
      case 'purchased_product':
        return `exists (select 1 from order_lines ol join orders o on o.id = ol.order_id where ${LIVE_ORDER} and ol.product_id = ${p(r.productId, 'uuid')}${within(r.withinDays)})`;
      case 'channel':
        return `exists (select 1 from orders o where ${LIVE_ORDER} and o.channel = ${p(r.channel, 'order_channel')})`;
    }
  };
  const group = (g: SegmentGroup): string =>
    `(${g.rules.map((r) => ('op' in r ? group(r) : rule(r))).join(g.op === 'and' ? ' and ' : ' or ')})`;
  return { where: group(def), params };
}

/** `select c.id from customers c where c.org_id = $1 and <segment>` */
export function segmentQuery(orgId: string, definition: unknown, select = 'c.id') {
  const compiled = compileSegment(definition, 2);
  return { sql: `select ${select} from customers c where c.org_id = $1::uuid and ${compiled.where}`, params: [orgId, ...compiled.params] };
}
