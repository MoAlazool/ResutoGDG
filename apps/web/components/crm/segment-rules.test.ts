import { segmentDefinition, type SegmentGroup } from '@resuto/contracts';
import { describe, expect, it } from 'vitest';
import {
  addGroup, addRule, canAddGroup, canAddRule, defaultRule, definitionValid, EMPTY_DEFINITION, LIMITS, measure, nodeAt, normalise, RULE_TYPES,
  removeAt, ruleValid, updateAt,
} from './segment-rules';

// 21-CRM: the segment builder edits the existing rule engine's DSL only, within its limits; everything it can produce
// once valid is accepted by the contract schema the API validates with.

const BRANCH = '0b5a3c7e-1f2d-4c3b-9a8e-7d6c5b4a3f21';
const PRODUCT = '9a8e7d6c-5b4a-4f21-8b5a-3c7e1f2d4c3b';

describe('segment rules', () => {
  it('offers exactly the rule types the engine compiles, each with a default the contract accepts once filled in', () => {
    expect(RULE_TYPES).toEqual(['inactive_days_gte', 'orders_gte', 'spent_gte', 'has_tag', 'consent', 'branch', 'purchased_product', 'channel', 'points_balance_gte']);
    for (const type of RULE_TYPES) {
      let r = defaultRule(type, { branchId: BRANCH });
      if (r.type === 'has_tag') r = { ...r, tag: 'vip' };
      if (r.type === 'purchased_product') r = { ...r, productId: PRODUCT };
      expect(ruleValid(r), type).toBe(true);
      expect(() => segmentDefinition.parse({ op: 'and', rules: [r] }), type).not.toThrow();
    }
    // Incomplete defaults are not sent.
    expect(ruleValid(defaultRule('has_tag'))).toBe(false);
    expect(ruleValid(defaultRule('purchased_product'))).toBe(false);
    expect(ruleValid(defaultRule('branch'))).toBe(false);
    expect(ruleValid({ type: 'orders_gte', count: 0 })).toBe(false);
    expect(ruleValid({ type: 'orders_gte', count: 2, withinDays: 0 })).toBe(false);
    expect(ruleValid({ type: 'channel', channel: 'fax' as never })).toBe(false);
  });

  it('edits the tree: update, add rules and groups, remove (an emptied group goes too)', () => {
    let d: SegmentGroup = EMPTY_DEFINITION;
    d = updateAt(d, [1], () => ({ type: 'inactive_days_gte', days: 60 }));
    expect(nodeAt(d, [1])).toEqual({ type: 'inactive_days_gte', days: 60 });
    d = addGroup(d, [], defaultRule('branch', { branchId: BRANCH }));
    expect(nodeAt(d, [2])).toEqual({ op: 'or', rules: [{ type: 'branch', branchId: BRANCH }] });
    d = addRule(d, [2], { type: 'channel', channel: 'qr' });
    expect(measure(d)).toEqual({ depth: 2, rules: 4 });
    expect(definitionValid(d)).toBe(true);
    expect(() => segmentDefinition.parse(d)).not.toThrow();
    d = removeAt(d, [2, 0]);
    d = removeAt(d, [2, 0]);
    expect(d.rules).toHaveLength(2); // the emptied nested group was removed with its last rule
    expect(EMPTY_DEFINITION.rules).toHaveLength(2); // never mutated
  });

  it('keeps to the engine limits: depth 3, 30 rules, 20 per group', () => {
    let d: SegmentGroup = { op: 'and', rules: [{ type: 'consent', value: true }] };
    d = addGroup(d, [], { type: 'consent', value: true });
    d = addGroup(d, [1], { type: 'consent', value: true });
    expect(measure(d).depth).toBe(3);
    expect(canAddGroup(d, [1, 1])).toBe(false);
    expect(addGroup(d, [1, 1], { type: 'consent', value: true })).toBe(d);
    let wide: SegmentGroup = { op: 'or', rules: [] };
    for (let i = 0; i < 25; i++) wide = addRule(wide, [], { type: 'orders_gte', count: i + 1 });
    expect(wide.rules).toHaveLength(LIMITS.perGroup);
    expect(canAddRule(wide, [])).toBe(false);
    let many: SegmentGroup = { op: 'and', rules: [] };
    for (let g = 0; g < 3; g++) {
      many = addGroup(many, [], { type: 'orders_gte', count: 1 });
      for (let i = 0; i < 12; i++) many = addRule(many, [g], { type: 'orders_gte', count: i + 2 });
    }
    expect(measure(many).rules).toBe(LIMITS.rules);
    expect(canAddRule(many, [0])).toBe(false);
    expect(definitionValid(many)).toBe(true);
    expect(() => segmentDefinition.parse(many)).not.toThrow();
  });

  it('refuses empty or invalid definitions and normalises tags as the API stores them', () => {
    expect(definitionValid({ op: 'and', rules: [] })).toBe(false);
    expect(definitionValid({ op: 'and', rules: [{ op: 'or', rules: [] }] })).toBe(false);
    expect(definitionValid({ op: 'and', rules: [{ type: 'has_tag', tag: '  ' }] })).toBe(false);
    expect(normalise({ op: 'and', rules: [{ type: 'has_tag', tag: '  VIP ' }, { op: 'or', rules: [{ type: 'has_tag', tag: 'Regular' }] }] }))
      .toEqual({ op: 'and', rules: [{ type: 'has_tag', tag: 'vip' }, { op: 'or', rules: [{ type: 'has_tag', tag: 'regular' }] }] });
  });
});
