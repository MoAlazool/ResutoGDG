// Segment builder state (21-CRM): pure helpers over the rule engine's DSL (packages/contracts marketing.ts, compiled by
// apps/api/src/modules/marketing/segment-sql.ts). Only the rule types, fields and limits the engine supports exist here.
import type { SegmentGroup, SegmentRule } from '@resuto/contracts';

export type RuleType = SegmentRule['type'];
export const RULE_TYPES: RuleType[] = ['inactive_days_gte', 'orders_gte', 'spent_gte', 'has_tag', 'consent', 'branch', 'purchased_product', 'channel', 'points_balance_gte'];
export const ORDER_CHANNELS = ['qr', 'web', 'whatsapp', 'staff', 'pos', 'mcp', 'phone', 'messenger', 'instagram'] as const;
/** The engine's limits (SEGMENT_MAX_DEPTH, SEGMENT_MAX_RULES, 20 rules per group). */
export const LIMITS = { depth: 3, rules: 30, perGroup: 20 } as const;
/** Rule types that take an optional "in the last N days" window. */
export const WINDOWED: ReadonlySet<RuleType> = new Set(['orders_gte', 'spent_gte', 'purchased_product']);

export type Node = SegmentRule | SegmentGroup;
export type Path = number[];
export const isGroup = (n: Node): n is SegmentGroup => 'op' in n;

export function defaultRule(type: RuleType, ctx: { branchId?: string | null } = {}): SegmentRule {
  switch (type) {
    case 'inactive_days_gte': return { type, days: 30 };
    case 'orders_gte': return { type, count: 2 };
    case 'spent_gte': return { type, amountMinor: 50_000 };
    case 'has_tag': return { type, tag: '' };
    case 'consent': return { type, value: true };
    case 'branch': return { type, branchId: ctx.branchId ?? '' };
    case 'purchased_product': return { type, productId: '' };
    case 'channel': return { type, channel: 'whatsapp' };
    case 'points_balance_gte': return { type, points: 100 };
  }
}

export const EMPTY_DEFINITION: SegmentGroup = { op: 'and', rules: [{ type: 'consent', value: true }, { type: 'inactive_days_gte', days: 30 }] };

/** Nesting depth (the top group is 1) and number of rules, as the API measures them. */
export function measure(g: SegmentGroup, depth = 1): { depth: number; rules: number } {
  let d = depth;
  let n = 0;
  for (const r of g.rules) {
    if (isGroup(r)) { const m = measure(r, depth + 1); d = Math.max(d, m.depth); n += m.rules; } else n += 1;
  }
  return { depth: d, rules: n };
}

export function nodeAt(g: SegmentGroup, path: Path): Node {
  let n: Node = g;
  for (const i of path) n = (n as SegmentGroup).rules[i]!;
  return n;
}

/** A copy of the tree with the node at `path` replaced by fn(node). */
export function updateAt(g: SegmentGroup, path: Path, fn: (n: Node) => Node): SegmentGroup {
  if (!path.length) return fn(g) as SegmentGroup;
  const [i, ...rest] = path;
  return { ...g, rules: g.rules.map((r, j) => (j === i ? (rest.length ? updateAt(r as SegmentGroup, rest, fn) : fn(r)) : r)) };
}

/** Removes the node at `path`; a nested group left empty goes too (the top group keeps at least nothing to add to). */
export function removeAt(g: SegmentGroup, path: Path): SegmentGroup {
  if (!path.length) return g;
  const parent = path.slice(0, -1);
  const i = path[path.length - 1]!;
  const next = updateAt(g, parent, (n) => ({ ...(n as SegmentGroup), rules: (n as SegmentGroup).rules.filter((_, j) => j !== i) }));
  const p = nodeAt(next, parent) as SegmentGroup;
  return parent.length && !p.rules.length ? removeAt(next, parent) : next;
}

export function canAddRule(root: SegmentGroup, groupPath: Path): boolean {
  return measure(root).rules < LIMITS.rules && (nodeAt(root, groupPath) as SegmentGroup).rules.length < LIMITS.perGroup;
}

/** A nested group at `groupPath` would sit at depth groupPath.length + 2. */
export function canAddGroup(root: SegmentGroup, groupPath: Path): boolean {
  return groupPath.length + 2 <= LIMITS.depth && canAddRule(root, groupPath);
}

export function addRule(root: SegmentGroup, groupPath: Path, rule: SegmentRule): SegmentGroup {
  return canAddRule(root, groupPath) ? updateAt(root, groupPath, (n) => ({ ...(n as SegmentGroup), rules: [...(n as SegmentGroup).rules, rule] })) : root;
}

export function addGroup(root: SegmentGroup, groupPath: Path, rule: SegmentRule): SegmentGroup {
  if (!canAddGroup(root, groupPath)) return root;
  const parentOp = (nodeAt(root, groupPath) as SegmentGroup).op;
  // A nested group usually reads as the opposite join ("all of … and any of …").
  return updateAt(root, groupPath, (n) => ({ ...(n as SegmentGroup), rules: [...(n as SegmentGroup).rules, { op: parentOp === 'and' ? 'or' : 'and', rules: [rule] }] }));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const int = (n: unknown, min: number, max: number) => Number.isInteger(n) && (n as number) >= min && (n as number) <= max;
const windowOk = (d: number | undefined) => d === undefined || int(d, 1, 3650);

/** Whether one rule has a value the engine accepts (the API validates again). */
export function ruleValid(r: SegmentRule): boolean {
  switch (r.type) {
    case 'inactive_days_gte': return int(r.days, 1, 3650);
    case 'orders_gte': return int(r.count, 1, 100_000) && windowOk(r.withinDays);
    case 'spent_gte': return int(r.amountMinor, 0, Number.MAX_SAFE_INTEGER) && windowOk(r.withinDays);
    case 'has_tag': return r.tag.trim().length >= 1 && r.tag.trim().length <= 40;
    case 'consent': return typeof r.value === 'boolean';
    case 'branch': return UUID.test(r.branchId);
    case 'purchased_product': return UUID.test(r.productId) && windowOk(r.withinDays);
    case 'channel': return (ORDER_CHANNELS as readonly string[]).includes(r.channel);
    case 'points_balance_gte': return int(r.points, 0, 10_000_000);
  }
}

/** Ready to count and save: every rule valid, no empty group, within the limits. */
export function definitionValid(g: SegmentGroup): boolean {
  const m = measure(g);
  if (m.rules < 1 || m.rules > LIMITS.rules || m.depth > LIMITS.depth) return false;
  const walk = (x: SegmentGroup): boolean => x.rules.length >= 1 && x.rules.length <= LIMITS.perGroup
    && x.rules.every((r) => (isGroup(r) ? walk(r) : ruleValid(r)));
  return walk(g);
}

/** The definition as the API takes it: tags trimmed; nothing else changes. */
export function normalise(g: SegmentGroup): SegmentGroup {
  return { op: g.op, rules: g.rules.map((r) => (isGroup(r) ? normalise(r) : r.type === 'has_tag' ? { ...r, tag: r.tag.trim().toLowerCase() } : r)) };
}
