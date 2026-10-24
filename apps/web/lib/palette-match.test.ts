import { describe, expect, it } from 'vitest';
import { MODULE_KEYS, type ModuleKey } from '@resuto/contracts';
import { translate } from './i18n/messages';
import { visibleAreas } from './nav';
import { actionEntries, pageEntries } from './palette-entries';
import { foldText, rankEntries, scoreEntry, searchableQuery } from './palette-match';

// Command palette matching (21-SHELL): in-house fuzzy matcher over localized labels (Arabic and English) and
// English keywords.

const ALL_ON = Object.fromEntries(MODULE_KEYS.map((m) => [m, true])) as Record<ModuleKey, boolean>;
const tr = (locale: 'en' | 'ar') => (k: string) => translate(locale, k);
const areas = visibleAreas({ role: 'owner', modules: ALL_ON, plan: 'pro', branch: { serviceMode: 'tables', acceptsReservations: true } });
const entries = (locale: 'en' | 'ar') => [
  ...pageEntries(areas, 'owner', tr(locale), { explore: true }),
  ...actionEntries({ role: 'owner', hrefs: new Set(areas.flatMap((a) => a.items.map((i) => i.href))), multiBranch: true }, tr(locale)),
];
const first = (locale: 'en' | 'ar', q: string) => rankEntries(entries(locale), q)[0]?.href ?? rankEntries(entries(locale), q)[0]?.id;

describe('palette text folding', () => {
  it('ignores case, accents, Arabic diacritics, tatweel and hamza forms, and reads Arabic-Indic digits', () => {
    expect(foldText('Café')).toBe('cafe');
    expect(foldText('أحمد')).toBe(foldText('احمد'));
    expect(foldText('إعدادات')).toBe(foldText('اعدادات'));
    expect(foldText('مـــطـبـخ')).toBe(foldText('مطبخ'));
    expect(foldText('الطَّلَبات')).toBe(foldText('الطلبات'));
    expect(foldText('مدرسة')).toBe(foldText('مدرسه'));
    expect(foldText('١٢٣')).toBe('123');
  });
});

describe('palette matching (English)', () => {
  it('finds pages by the start of their label, best match first', () => {
    expect(first('en', 'ord')).toBe('/orders');
    expect(first('en', 'kitch')).toBe('/kitchen');
    expect(first('en', 'Payments')).toBe('/payments');
    expect(first('en', 'pnl')).toBe('/finance/pnl');
    expect(first('en', 'profit')).toBe('/finance/pnl');
  });

  it('matches any word of a label, several words, and keywords', () => {
    expect(first('en', 'tables')).toBe('/floor');
    expect(first('en', 'team roles')).toBe('/team');
    expect(first('en', 'kds')).toBe('/kitchen');
    expect(first('en', 'whatsapp')).toBe('/inbox');
    expect(first('en', 'claude')).toBe('/mcp');
  });

  it('tolerates skipped letters (subsequence) but prefers real prefixes', () => {
    expect(first('en', 'anlytcs')).toBe('/analytics');
    expect(scoreEntry('ord', { label: 'Orders' })).toBeGreaterThan(scoreEntry('ord', { label: 'Recorded' }));
    expect(scoreEntry('zzz', { label: 'Orders' })).toBe(0);
  });

  it('finds actions', () => {
    expect(first('en', 'sign out')).toBe('action:sign-out');
    expect(first('en', 'new order')).toBe('/orders?new=1');
    expect(first('en', 'invite')).toBe('/team?invite=1');
    expect(first('en', 'language')).toBe('action:language');
    expect(first('en', 'switch branch')).toBe('action:branches');
  });
});

describe('palette matching (Arabic)', () => {
  it('finds pages by their Arabic labels, with or without hamza and diacritics', () => {
    expect(first('ar', 'الطلبات')).toBe('/orders');
    expect(first('ar', 'المطبخ')).toBe('/kitchen');
    expect(first('ar', 'اعدادات')).toBe('/settings');
    expect(first('ar', 'التحليلات')).toBe('/analytics');
    expect(first('ar', 'الحجو')).toBe('/reservations');
  });

  it('still finds pages by their English names in an Arabic page', () => {
    expect(first('ar', 'orders')).toBe('/orders');
    expect(first('ar', 'inbox')).toBe('/inbox');
  });

  it('finds Arabic actions', () => {
    expect(first('ar', 'تسجيل الخروج')).toBe('action:sign-out');
    expect(first('ar', 'طلب جديد')).toBe('/orders?new=1');
  });
});

describe('record search trigger', () => {
  it('searches records for a digit or two letters, never for one letter', () => {
    expect(searchableQuery('7')).toBe(true);
    expect(searchableQuery('#١٢')).toBe(true);
    expect(searchableQuery('mo')).toBe(true);
    expect(searchableQuery('م')).toBe(false);
    expect(searchableQuery('m')).toBe(false);
    expect(searchableQuery('  ')).toBe(false);
  });
});

describe('palette entries', () => {
  it('lists pages with their area and actions the role may use', () => {
    const t = tr('en');
    const kitchenAreas = visibleAreas({ role: 'kitchen', modules: ALL_ON, plan: 'pro', branch: null });
    const kitchen = actionEntries({ role: 'kitchen', hrefs: new Set(kitchenAreas.flatMap((a) => a.items.map((i) => i.href))), multiBranch: false }, t).map((e) => e.id);
    expect(kitchen).toEqual(['action:language', 'action:sign-out']);
    const owner = entries('en');
    expect(owner.find((e) => e.href === '/orders')).toMatchObject({ label: 'Orders', hint: 'Operations' });
    expect(owner.find((e) => e.href === '/finance/pnl')?.label).toMatch(/^Finance › /);
    expect(owner.some((e) => e.href === '/menu-import')).toBe(true);
    // No "switch branch" with a single branch.
    expect(actionEntries({ role: 'owner', hrefs: new Set(['/orders']), multiBranch: false }, t).map((e) => e.id)).not.toContain('action:branches');
  });

  it('labels never carry Arabic-Indic digits', () => {
    for (const e of entries('ar')) expect(e.label).not.toMatch(/[٠-٩۰-۹]/);
  });
});
