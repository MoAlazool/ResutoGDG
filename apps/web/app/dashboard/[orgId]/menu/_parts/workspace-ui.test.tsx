// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Category, Product } from '@resuto/contracts';
import { $, $$, click, EASTERN_DIGITS, key, mount } from '../../../../../../../packages/ui/test/dom';
import { LocaleProvider } from '@/lib/i18n/client';
import { messagesFor } from '@/lib/i18n/messages';
import { CategoryRail } from './CategoryRail';
import { ItemsTable } from './ItemsTable';

// 21-MENU: the category rail (keyboard reorder, announcements, filter) and the dishes table (availability switch at
// the branch, prices in tabular Western digits, selection that never opens the row), in English and Arabic.

const inLocale = (locale: 'en' | 'ar', node: ReactNode) => (
  <LocaleProvider locale={locale} messages={{ ...messagesFor(locale, 'guest'), ...messagesFor(locale, 'staff') }}>{node}</LocaleProvider>
);
const cat = (id: string, name: string, nameAr: string, sortOrder: number): Category => ({ id, menuId: 'm', name, nameAr, description: null, defaultStation: null, sortOrder, isActive: true });
const CATS = [cat('c1', 'Starters', 'المقبلات', 0), cat('c2', 'Mains', 'الأطباق الرئيسية', 1), cat('c3', 'Drinks', 'المشروبات', 2)];
const dish = (id: string, over: Partial<Product> = {}): Product => ({
  id, categoryId: 'c2', name: id, nameAr: `${id} ع`, description: null, descriptionAr: null, priceMinor: 12550, costMinor: null, currency: 'EGP',
  station: 'Grill', prepMinutes: null, spiceLevel: 0, dietary: [], allergens: ['milk'], ingredients: [], calories: null, imageUrl: null, imageMediaId: null,
  isActive: true, trackStock: false, sortOrder: 0, externalRef: null, version: 1, branchSettings: [], modifierGroupIds: [], ...over,
});
afterEach(() => { document.body.innerHTML = ''; });

const rail = (locale: 'en' | 'ar', onReorder = vi.fn(async () => {}), onSelect = vi.fn()) => mount(inLocale(locale, (
  <CategoryRail categories={CATS} counts={new Map([['c1', 3], ['c2', 12], ['c3', 4]])} total={19} selected="" onSelect={onSelect}
    writable busy={false} onAdd={() => {}} onRename={() => {}} onArchive={() => {}} onReorder={onReorder} />
)), locale);

describe('CategoryRail', () => {
  it('reorders from the keyboard on a handle (arrows, Home, End), announces the move and keeps focus on the handle', async () => {
    const onReorder = vi.fn(async () => {});
    const v = rail('en', onReorder);
    const handle = () => $(v.host, '[data-handle="c1"]');
    expect(handle().getAttribute('aria-label')).toBe('Reorder Starters');
    handle().focus();
    await act(async () => { key(handle(), 'ArrowDown'); });
    expect(onReorder).toHaveBeenLastCalledWith(['c2', 'c1', 'c3']);
    expect($(v.host, '[role="status"]').textContent).toBe('Starters moved to position 2 of 3.');
    expect(document.activeElement).toBe(handle());
    await act(async () => { key(handle(), 'End'); });
    expect(onReorder).toHaveBeenLastCalledWith(['c2', 'c3', 'c1']);
    await act(async () => { key(handle(), 'Home'); });
    expect(onReorder).toHaveBeenLastCalledWith(['c1', 'c2', 'c3']);
    await act(async () => { key(handle(), 'ArrowUp'); }); // already first: nothing to save
    expect(onReorder).toHaveBeenCalledTimes(3);
    expect($$(v.host, '.menu-rail-name').map((n) => n.textContent)).toEqual(['All dishes', 'Starters', 'Mains', 'Drinks']);
    v.unmount();
  });

  it('filters by category with pressed buttons, and shows counts in Western digits in Arabic', () => {
    const onSelect = vi.fn();
    const v = rail('ar', undefined, onSelect);
    const picks = $$(v.host, '.menu-rail-pick');
    expect(picks[0]!.getAttribute('aria-pressed')).toBe('true');
    click(picks[2]!);
    expect(onSelect).toHaveBeenCalledWith('c2');
    expect(v.host.textContent).toContain('الأطباق الرئيسية');
    expect(v.host.textContent).toContain('12');
    expect(v.host.textContent).not.toMatch(EASTERN_DIGITS);
    expect($(v.host, '[data-handle="c2"]').getAttribute('aria-label')).toBe('إعادة ترتيب الأطباق الرئيسية');
    v.unmount();
  });

  it('puts back the order when saving it fails', async () => {
    const v = rail('en', vi.fn(async () => { throw new Error('offline'); }));
    await act(async () => { key($(v.host, '[data-handle="c3"]'), 'ArrowUp'); });
    expect($$(v.host, '.menu-rail-name').map((n) => n.textContent)).toEqual(['All dishes', 'Starters', 'Mains', 'Drinks']);
    v.unmount();
  });
});

describe('ItemsTable', () => {
  const rows = [
    dish('Koshari'),
    dish('Fattah', { priceMinor: 9000, compareAtMinor: 12000, branchSettings: [{ branchId: 'b1', isAvailable: true, priceOverrideMinor: null, stockQty: null, soldOut: true }] }),
    dish('Hawawshi', { branchSettings: [{ branchId: 'b1', isAvailable: false, priceOverrideMinor: null, stockQty: null }] }),
    dish('Molokhia', { branchSettings: [{ branchId: 'b1', isAvailable: true, priceOverrideMinor: 15000, stockQty: null }] }),
  ];
  const table = (locale: 'en' | 'ar', props: { onOpen?: (p: Product) => void; onAvailability?: (p: Product, on: boolean) => void; onSelectedChange?: (ids: string[]) => void } = {}) => mount(inLocale(locale, (
    <ItemsTable rows={rows} categories={CATS} branchId="b1" branchName={locale === 'ar' ? 'الزمالك' : 'Zamalek'} currency="EGP" selected={[]}
      onSelectedChange={props.onSelectedChange ?? (() => {})} onOpen={props.onOpen} canAvailability selectable pending={new Set()}
      onAvailability={props.onAvailability ?? (() => {})} bulkActions={() => null} empty={<p>none</p>} />
  )), locale);

  it('shows the switch per offered dish at the branch (checked unless sold out), never opening the row', () => {
    const onOpen = vi.fn();
    const onAvailability = vi.fn();
    const onSelectedChange = vi.fn();
    const v = table('en', { onOpen, onAvailability, onSelectedChange });
    const switches = $$<HTMLInputElement>(v.host, 'input[role="switch"]');
    expect(switches.map((s) => s.checked)).toEqual([true, false, true]); // Hawawshi is not offered here: no switch
    expect(v.host.textContent).toContain('Not offered here');
    expect(v.host.textContent).toContain('Koshari available at Zamalek');
    click(switches[1]!);
    expect(onAvailability).toHaveBeenCalledWith(rows[1], true);
    click($$<HTMLInputElement>(v.host, 'tbody input[type="checkbox"]:not([role])')[0]!);
    expect(onSelectedChange).toHaveBeenCalledWith(['Koshari']);
    expect(onOpen).not.toHaveBeenCalled();
    const tr = $$(v.host, 'tbody tr')[0]!;
    key(tr, 'Enter');
    expect(onOpen).toHaveBeenCalledWith(rows[0]);
    v.unmount();
  });

  it('prices: the branch price, the struck-through was-price of a discount, tabular Western digits in Arabic', () => {
    const v = table('ar');
    const prices = $$(v.host, '.menu-price');
    expect(prices).toHaveLength(4);
    expect(prices[1]!.querySelector('s')).toBeTruthy(); // Fattah: discounted from 120
    expect(prices[3]!.textContent).toContain('150'); // Molokhia: the branch price
    expect(prices[3]!.textContent).toContain('سعر الفرع');
    expect(prices.every((p) => p.classList.contains('num'))).toBe(true);
    expect(v.host.textContent).not.toMatch(EASTERN_DIGITS);
    expect($$(v.host, '[data-row-id]').map((e) => e.getAttribute('data-row-id'))).toEqual(['Koshari', 'Fattah', 'Hawawshi', 'Molokhia']);
    v.unmount();
  });
});
