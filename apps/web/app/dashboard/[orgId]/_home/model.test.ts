import { describe, expect, it } from 'vitest';
import { defaultOverviewPreferences, setOverviewSectionVisible } from '@/lib/contracts-home';
import type { Insight } from '@resuto/contracts';
import {
  addDays, attentionPath, cumulative, insightAction, insightProvenance, localToday, moveAmong, openInsights, overviewPath, periodRange,
  providerName, sectionAvailable, shownSections, validRange, type HomeAccess,
} from './model';

const access = (perms: string[], modules: string[] = ['core', 'marketing', 'intelligence']): HomeAccess => ({
  can: (p) => perms.includes(p), hasModule: (m) => modules.includes(m),
});
const owner = access(['analytics:read', 'ai:use', 'marketing:write', 'menu:read', 'inventory:read', 'kitchen:operate']);
const NOW = Date.parse('2026-10-25T20:30:00Z'); // 00:30 on 26 October in Dubai (UTC+4), late on 25 October in Cairo.

describe('periods', () => {
  it('uses the restaurant\'s local date', () => {
    expect(localToday('Asia/Dubai', NOW)).toBe('2026-10-26');
    expect(localToday('Africa/Cairo', NOW)).toBe('2026-10-25');
  });

  it('resolves today, 7 and 30 days including today, and a valid custom range', () => {
    expect(periodRange('today', 'Africa/Cairo', undefined, NOW)).toEqual({ from: '2026-10-25', to: '2026-10-25' });
    expect(periodRange('7d', 'Africa/Cairo', undefined, NOW)).toEqual({ from: '2026-10-19', to: '2026-10-25' });
    expect(periodRange('30d', 'Africa/Cairo', undefined, NOW)).toEqual({ from: '2026-09-26', to: '2026-10-25' });
    expect(periodRange('custom', 'Africa/Cairo', { from: '2026-09-01', to: '2026-09-30' }, NOW)).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    // An invalid custom range falls back to the last 7 days instead of sending a request the API refuses.
    expect(periodRange('custom', 'Africa/Cairo', { from: '2026-09-30', to: '2026-09-01' }, NOW)).toEqual({ from: '2026-10-19', to: '2026-10-25' });
    expect(periodRange('custom', 'Africa/Cairo', { from: '2026-02-30', to: '2026-03-01' }, NOW).from).toBe('2026-10-19');
  });

  it('accepts at most 400 days, real dates only', () => {
    expect(validRange('2025-09-01', '2026-10-05')).toBe(true);
    expect(validRange('2025-01-01', '2026-10-05')).toBe(false);
    expect(validRange('2026-13-01', '2026-13-02')).toBe(false);
    expect(validRange(null, '2026-01-01')).toBe(false);
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('builds the request paths with the shell branch, leaving it out for all branches', () => {
    expect(overviewPath('o1', { branchId: 'b1', from: '2026-10-19', to: '2026-10-25', compare: 'last_year' }))
      .toBe('/o/o1/analytics/overview?branchId=b1&from=2026-10-19&to=2026-10-25&compare=last_year');
    expect(overviewPath('o1', { branchId: '', from: '2026-10-25', to: '2026-10-25', compare: 'previous_period' }))
      .toBe('/o/o1/analytics/overview?from=2026-10-25&to=2026-10-25&compare=previous_period');
    expect(attentionPath('o1', '')).toBe('/o/o1/attention');
    expect(attentionPath('o1', 'b2')).toBe('/o/o1/attention?branchId=b2');
  });
});

describe('sections', () => {
  it('shows only sections the role can use, in the member\'s order, without hidden ones', () => {
    const cashier = access(['orders:read']);
    expect(shownSections(defaultOverviewPreferences(), owner)).toEqual(['now', 'performance', 'attention', 'customers', 'actions']);
    expect(shownSections(defaultOverviewPreferences(), cashier)).toEqual(['attention']);
    expect(sectionAvailable('actions', access(['ai:use'], ['core']))).toBe(false);
    expect(shownSections(setOverviewSectionVisible(defaultOverviewPreferences(), 'customers', false), owner)).not.toContain('customers');
  });

  it('moves past sections the member cannot see, keeping them in place', () => {
    const noAi = access(['analytics:read']);
    // customers (index 3) moves down past nothing it can see: "actions" is unavailable, so it stays.
    const d = defaultOverviewPreferences();
    expect(moveAmong(d, 'customers', 1, noAi)).toBe(d);
    const ai = access(['ai:use'], ['intelligence']);
    // For a member who sees only attention and actions, moving actions up jumps over the analytics sections.
    const moved = moveAmong(d, 'actions', -1, ai);
    expect(moved.sections.map((x) => x.id)).toEqual(['now', 'performance', 'actions', 'customers', 'attention']);
    expect(shownSections(moved, ai)).toEqual(['actions', 'attention']);
  });
});

describe('next actions', () => {
  const insight = (templateKey: string, params: Record<string, unknown> = {}, evidence: Record<string, unknown> = {}) =>
    ({ templateKey, params, evidence }) as Pick<Insight, 'templateKey' | 'params' | 'evidence'>;
  const names = { winBack: 'Win back regulars', promote: (d: string) => `Promote ${d}` };
  const product = '7f1c2a8e-1d2b-4c3d-9e4f-5a6b7c8d9e0f';

  it('opens a prefilled campaign draft for win-back and slow dishes, never acting by itself', () => {
    const win = insightAction(insight('inactive_valuable', { customers: 4 }), owner, names);
    expect(win).toEqual({ kind: 'winBack', href: '/marketing?draft=campaign&objective=reactivation&name=Win+back+regulars' });
    const drop = insightAction(insight('item_drop', { product: { en: 'Koshari', ar: 'كشري' } }, { productId: product }), owner, names, 'ar');
    expect(drop?.kind).toBe('promote');
    expect(new URLSearchParams(drop!.href.split('?')[1]).get('name')).toBe('Promote كشري');
    expect(drop!.href.startsWith('/marketing?draft=campaign&objective=upsell')).toBe(true);
  });

  it('falls back to what the role can open, or nothing', () => {
    const menuOnly = access(['menu:read']);
    expect(insightAction(insight('item_drop', { product: 'Koshari' }, { productId: product }), menuOnly, names)).toEqual({ kind: 'dish', href: `/menu?product=${product}` });
    expect(insightAction(insight('inactive_valuable'), menuOnly, names)).toBeNull();
    expect(insightAction(insight('stock_sold_out', {}, { productId: 'not-an-id' }), owner, names)).toBeNull();
    expect(insightAction(insight('low_stock'), owner, names)).toEqual({ kind: 'stock', href: '/inventory?tab=alerts' });
    expect(insightAction(insight('slow_kitchen'), owner, names)).toEqual({ kind: 'kitchen', href: '/kitchen' });
    expect(insightAction(insight('revenue_drop'), owner, names)).toEqual({ kind: 'sales', href: '/analytics/sales' });
    expect(insightAction(insight('mystery'), owner, names)).toBeNull();
    // Marketing outside the plan: no draft.
    expect(insightAction(insight('churn_high'), access(['marketing:write'], ['core']), names)).toBeNull();
  });

  it('keeps open insights, most severe first, and labels model output as an estimate', () => {
    const mk = (id: string, severity: Insight['severity'], status: Insight['status'], createdAt: string) => ({ id, severity, status, createdAt }) as Insight;
    const list = openInsights([mk('a', 'info', 'new', '2026-10-01'), mk('b', 'critical', 'seen', '2026-09-01'), mk('c', 'warning', 'dismissed', '2026-10-02'),
      mk('d', 'warning', 'new', '2026-10-03'), mk('e', 'warning', 'new', '2026-10-04')]);
    expect(list.map((i) => i.id)).toEqual(['b', 'e', 'd', 'a']);
    expect(insightProvenance('deterministic')).toBe('live');
    expect(insightProvenance('model')).toBe('estimated');
    expect(insightProvenance('llm')).toBe('estimated');
  });
});

describe('helpers', () => {
  it('cumulates and names providers', () => {
    expect(cumulative([1, 2, 0, 3])).toEqual([1, 3, 3, 6]);
    expect(providerName('meta_ads')).toBe('Meta Ads');
    expect(providerName('foodics')).toBe('Foodics');
  });
});
