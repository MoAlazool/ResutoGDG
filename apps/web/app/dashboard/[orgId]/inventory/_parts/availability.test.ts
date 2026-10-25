import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement as h, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Product } from '@resuto/contracts';
import { DishStatus } from '@/components/ops/DishStatus';
import { LocaleProvider } from '@/lib/i18n/client';
import { messagesFor } from '@/lib/i18n/messages';
import { AvailabilityTable } from './availability';
import { DEFAULT_INVENTORY_TAB, INVENTORY_TABS, visibleInventoryTabs } from './tab-order';

// PAR-08: the landing views follow legacy. Dish availability is rendered from the real component; its status never
// says "Available" next to a red 0 from the recipe (review).
const B = 'b1';
const dish = (id: string, over: Partial<Product> = {}): Product => ({
  id, categoryId: 'c1', name: `Dish ${id}`, nameAr: `طبق ${id}`, description: null, descriptionAr: null, priceMinor: 14500, costMinor: null,
  currency: 'EGP', station: 'grill', prepMinutes: 10, spiceLevel: 0, dietary: [], allergens: [], ingredients: [], calories: null, imageUrl: null,
  imageMediaId: null, isActive: true, trackStock: false, sortOrder: 0, externalRef: null, version: 1, modifierGroupIds: [],
  branchSettings: [{ branchId: B, isAvailable: true, priceOverrideMinor: null, stockQty: null }], recipePortions: null, ...over,
});
const rows: Product[] = [
  dish('own', { trackStock: true, branchSettings: [{ branchId: B, isAvailable: true, priceOverrideMinor: null, stockQty: 12 }] }),
  dish('recipe', { recipePortions: [{ branchId: B, portions: 4 }] }),
  dish('empty', { recipePortions: [{ branchId: B, portions: 0 }] }),
  dish('untracked'),
  dish('eightysix', { recipePortions: [{ branchId: B, portions: 9 }], branchSettings: [{ branchId: B, isAvailable: true, priceOverrideMinor: null, stockQty: null, soldOut: true }] }),
];
const render = (node: ReactNode, locale: 'en' | 'ar' = 'en') =>
  renderToStaticMarkup(h(LocaleProvider, { locale, messages: messagesFor(locale, 'staff'), children: node }));
const rowOf = (html: string, name: string) => {
  const i = html.indexOf(`>${name}<`);
  return html.slice(i, html.indexOf('</tr>', i));
};

describe('dish availability (PAR-08)', () => {
  it('lists each dish with its portions, status and actions', () => {
    const html = render(h(AvailabilityTable, { rows, branchId: B, onToggle: () => {}, configureHref: '/dashboard/o/menu' }));
    expect(rowOf(html, 'Dish own')).toMatch(/badge-ok[^>]*><span class="num"[^>]*>12</);
    expect(rowOf(html, 'Dish recipe')).toMatch(/badge-danger[^>]*><span class="num" title="From the ingredients in stock \(recipe\)">4</);
    expect(rowOf(html, 'Dish untracked')).toContain('Not tracked: this dish has no recipe or stock count');
    // Recipe portions left out by the API (a role without inventory:read): "—" says why, not "no recipe".
    const hidden = render(h(AvailabilityTable, { rows: [dish('hidden', { recipePortions: undefined })], branchId: B }));
    expect(rowOf(hidden, 'Dish hidden')).toContain('Portions from ingredients are shown to roles with inventory access');
    expect(rowOf(html, 'Dish own')).toMatch(/badge-ok[^>]*>Available</);
    expect(rowOf(html, 'Dish own')).toContain('Sold out today');
    expect(rowOf(html, 'Dish own')).toContain('href="/dashboard/o/menu"');
    expect(rowOf(html, 'Dish eightysix')).toContain('Sold out');
  });

  it('a recipe dish with 0 portions from the ingredients is not shown as Available', () => {
    const row = rowOf(render(h(AvailabilityTable, { rows, branchId: B })), 'Dish empty');
    expect(row).toMatch(/badge-danger[^>]*><span class="num"[^>]*>0</);
    expect(row).toContain('Out of ingredients');
    expect(row).not.toMatch(/badge-ok[^>]*>Available</);
    expect(render(h(DishStatus, { p: rows[2]!, branchId: B }), 'ar')).toContain('نفدت المكونات');
  });

  it('without the permissions there are no actions', () => {
    const html = render(h(AvailabilityTable, { rows, branchId: B }));
    expect(html).not.toContain('Sold out today');
    expect(html).not.toContain('Configure');
  });
});

describe('inventory and settings open order (PAR-08, 21-OPS)', () => {
  it('inventory opens on stock levels (low stock first, plan §5); dish availability is the next tab, the stocktake a sheet', () => {
    expect(DEFAULT_INVENTORY_TAB).toBe('levels');
    expect(INVENTORY_TABS[0]).toBe('levels');
    expect(visibleInventoryTabs(true)).toEqual(['levels', 'availability', 'movement', 'items', 'recipes', 'alerts', 'waste', 'history']);
    // Without inventory:write, recording movements is hidden (and the stocktake action with it).
    expect(visibleInventoryTabs(false)).toEqual(['levels', 'availability', 'items', 'recipes', 'alerts', 'waste', 'history']);
  });

  it('settings opens on the service model; profile and the launch checklist follow', () => {
    // The settings page needs the whole dashboard context to render; its section order is read from the source.
    const src = readFileSync(join(__dirname, '..', '..', 'settings/page.tsx'), 'utf8');
    const mode = src.indexOf("<Card title={t('ops.mode.title')}>");
    const profile = src.indexOf('<Card title={s.profile}>');
    const checklist = src.indexOf('<Card title={s.checklist}');
    expect(mode).toBeGreaterThan(0);
    expect(mode).toBeLessThan(profile);
    expect(profile).toBeLessThan(checklist);
  });
});
