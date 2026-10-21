import { describe, expect, it } from 'vitest';
import { parseMenuText, splitNames } from './menu-text-parser';

describe('menu text parser (no model)', () => {
  it('reads categories, bilingual names, prices with leaders and currencies, descriptions and add-ons', () => {
    const text = [
      'Starters / المقبلات',
      'Hummus - حمص ........ 85',
      'Chickpeas, tahini and olive oil',
      'Falafel (6 pcs)  EGP 60',
      '+ Extra tahini 10',
      '',
      'MAINS:',
      'Mixed grill مشويات مشكلة 350 LE',
      'Fresh juice  Small 25 / Large 35',
      '٨٥ ج.م  فول مدمس',
    ].join('\n');
    const { rows, uncertainties } = parseMenuText(text, 'EGP');
    expect(rows.map((r) => [r.category, r.name, r.nameAr, r.priceMinor])).toEqual([
      ['Starters', 'Hummus', 'حمص', 8500],
      ['Starters', 'Falafel (6 pcs)', null, 6000],
      ['MAINS', 'Mixed grill', 'مشويات مشكلة', 35000],
      ['MAINS', 'Fresh juice', null, 2500],
      ['MAINS', 'فول مدمس', 'فول مدمس', 8500],
    ]);
    expect(rows[0]!.description).toBe('Chickpeas, tahini and olive oil');
    expect(rows[1]!.modifiers).toEqual([{ name: 'Extras', nameAr: 'إضافات', minSelect: 0, maxSelect: 1, options: [{ name: 'Extra tahini', nameAr: null, priceDeltaMinor: 1000 }] }]);
    expect(rows[3]!.modifiers[0]).toMatchObject({ name: 'Size', minSelect: 1, maxSelect: 1,
      options: [{ name: 'Small', nameAr: 'صغير', priceDeltaMinor: 0 }, { name: 'Large', nameAr: 'كبير', priceDeltaMinor: 1000 }] });
    // Arabic-only name is flagged for the reviewer; every row starts unavailable and in review.
    expect(rows[4]!.uncertainFields).toContain('name');
    expect(rows.every((r) => r.status === 'review' && r.available === false)).toBe(true);
    expect(rows[0]!.source).toContain('Hummus');
    expect(uncertainties).toEqual([]);
  });

  it('flags items before any category and never invents a price', () => {
    const { rows, uncertainties } = parseMenuText('Koshari 45\nSoup of the day\n\nThank you for visiting!', 'EGP');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'Koshari', category: 'Mains', priceMinor: 4500 });
    expect(rows[0]!.uncertainFields).toContain('category');
    expect(rows[0]!.confidence).toBeLessThan(0.75);
    expect(rows[0]!.description).toBe('Soup of the day');
    expect(uncertainties.join(' ')).toMatch(/Thank you/);
    const none = parseMenuText('Our story\nWe cook with love.', 'SAR');
    expect(none.rows).toEqual([]);
    expect(none.uncertainties[0]).toMatch(/No priced items/);
  });

  it('handles SAR halalas, thousands separators and Arabic-Indic digits', () => {
    const { rows } = parseMenuText('Desserts\nKunafa  ر.س ٢٥٫٥٠\nFamily platter SAR 1,250', 'SAR');
    expect(rows.map((r) => r.priceMinor)).toEqual([2550, 125000]);
  });

  it('splits names by script', () => {
    expect(splitNames('Shawarma / شاورما')).toEqual({ name: 'Shawarma', nameAr: 'شاورما', arabicOnly: false });
    expect(splitNames('شاورما فراخ Chicken shawarma')).toEqual({ name: 'Chicken shawarma', nameAr: 'شاورما فراخ', arabicOnly: false });
  });
});
