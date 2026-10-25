import { describe, expect, it } from 'vitest';
import {
  ATTENTION_ACCESS, ATTENTION_KINDS, defaultOverviewPreferences, moveOverviewSection, normaliseOverviewPreferences, OVERVIEW_SECTIONS,
  sameOverviewPreferences, setOverviewSectionVisible,
} from './home-sections';
import { overviewPreferencesInput, overviewQuery } from './home';
import { PERMISSIONS } from './permissions';
import { MODULE_KEYS } from './modules';

describe('overview preferences helpers', () => {
  it('defaults to every section, visible, in the plan order', () => {
    expect(defaultOverviewPreferences().sections).toEqual(OVERVIEW_SECTIONS.map((id) => ({ id, visible: true })));
    expect(OVERVIEW_SECTIONS).toEqual(['now', 'performance', 'attention', 'customers', 'actions']);
  });

  it('normalises a stored value: keeps known sections in order, drops unknown and repeated ones, appends missing ones', () => {
    const p = normaliseOverviewPreferences({ sections: [{ id: 'customers', visible: false }, { id: 'floor', visible: true }, { id: 'now' }, { id: 'customers', visible: true }, 'x'] });
    expect(p.sections).toEqual([
      { id: 'customers', visible: false }, { id: 'now', visible: true },
      { id: 'performance', visible: true }, { id: 'attention', visible: true }, { id: 'actions', visible: true },
    ]);
    for (const junk of [null, undefined, 42, 'text', [], { sections: 'no' }]) expect(normaliseOverviewPreferences(junk)).toEqual(defaultOverviewPreferences());
  });

  it('moves a section one place and stops at the ends; shows and hides', () => {
    const d = defaultOverviewPreferences();
    expect(moveOverviewSection(d, 'attention', -1).sections.map((s) => s.id)).toEqual(['now', 'attention', 'performance', 'customers', 'actions']);
    expect(moveOverviewSection(d, 'now', -1)).toBe(d);
    expect(moveOverviewSection(d, 'actions', 1)).toBe(d);
    const hidden = setOverviewSectionVisible(d, 'customers', false);
    expect(hidden.sections.find((s) => s.id === 'customers')!.visible).toBe(false);
    expect(sameOverviewPreferences(hidden, d)).toBe(false);
    expect(sameOverviewPreferences(setOverviewSectionVisible(hidden, 'customers', true), d)).toBe(true);
  });

  it('validates the PUT body', () => {
    expect(overviewPreferencesInput.safeParse(defaultOverviewPreferences()).success).toBe(true);
    expect(overviewPreferencesInput.safeParse({ sections: [{ id: 'now', visible: true }, { id: 'now', visible: true }] }).success).toBe(false);
    expect(overviewPreferencesInput.safeParse({ sections: [] }).success).toBe(false);
    expect(overviewPreferencesInput.safeParse({ sections: [{ id: 'now', visible: true }], extra: 1 }).success).toBe(false);
  });
});

describe('overview query', () => {
  it('takes from and to together, compare only with them', () => {
    expect(overviewQuery.safeParse({}).success).toBe(true);
    expect(overviewQuery.safeParse({ from: '2026-09-01', to: '2026-09-07', compare: 'last_year' }).success).toBe(true);
    expect(overviewQuery.safeParse({ from: '2026-09-01' }).success).toBe(false);
    expect(overviewQuery.safeParse({ compare: 'none' }).success).toBe(false);
    expect(overviewQuery.safeParse({ from: '2026-09-08', to: '2026-09-07' }).success).toBe(false);
    expect(overviewQuery.safeParse({ from: '2025-01-01', to: '2026-09-07' }).success).toBe(false);
  });
});

describe('attention access', () => {
  it('names a real permission and module for every kind', () => {
    expect(Object.keys(ATTENTION_ACCESS).sort()).toEqual([...ATTENTION_KINDS].sort());
    for (const { permission, module } of Object.values(ATTENTION_ACCESS)) {
      expect(PERMISSIONS).toContain(permission);
      if (module) expect(MODULE_KEYS).toContain(module);
    }
  });
});
