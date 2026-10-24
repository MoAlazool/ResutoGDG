// @vitest-environment jsdom
/// <reference path="../src/lucide-icons.d.ts" />
import ChevronRight from 'lucide-react/dist/esm/icons/chevron-right.mjs';
import Search from 'lucide-react/dist/esm/icons/search.mjs';
import { describe, expect, it } from 'vitest';
import { Icon, isDirectional } from '../src/icon';
import { NAV_ICONS, NavIcon } from '../src/nav-icons';
import { NAV_GLYPHS } from '../src/shell';
import { $, EASTERN_DIGITS, html, mount } from './dom';

describe('Icon', () => {
  it('is decorative by default and named when given a label (EN and AR)', () => {
    const plain = html(<Icon icon={Search} />);
    expect(plain).toContain('aria-hidden="true"');
    expect(plain).not.toContain('role="img"');
    const en = html(<Icon icon={Search} label="Search" />);
    expect(en).toContain('role="img"');
    expect(en).toContain('aria-label="Search"');
    const ar = html(<Icon icon={Search} label="بحث" />, 'ar');
    expect(ar).toContain('aria-label="بحث"');
    expect(ar).not.toMatch(EASTERN_DIGITS);
  });

  it('marks direction-dependent icons for mirroring in RTL, and lets `mirror` override', () => {
    expect(isDirectional(ChevronRight)).toBe(true);
    expect(isDirectional(Search)).toBe(false);
    const view = mount(<><Icon icon={ChevronRight} /><Icon icon={Search} /><Icon icon={Search} mirror /><Icon icon={ChevronRight} mirror={false} /></>, 'ar');
    const svgs = [...view.host.querySelectorAll('svg')];
    expect(svgs.map((s) => s.classList.contains('rui-icon-dir'))).toEqual([true, false, true, false]);
    expect(view.host.closest('[dir]')?.getAttribute('dir')).toBe('rtl');
    view.unmount();
  });

  it('sizes the svg and keeps it out of the tab order', () => {
    const view = mount(<Icon icon={Search} size={20} />);
    const svg = $(view.host, 'svg');
    expect(svg.getAttribute('width')).toBe('20');
    expect(svg.getAttribute('focusable')).toBe('false');
    view.unmount();
  });
});

describe('NAV_ICONS', () => {
  it('has an icon for every navigation glyph name, and no glyph name without one', () => {
    expect(Object.keys(NAV_ICONS).sort()).toEqual(Object.keys(NAV_GLYPHS).sort());
  });

  it('gives each module its own icon (the glyph set reused ◉ for three modules)', () => {
    const modules = Object.entries(NAV_ICONS).filter(([k]) => k !== 'lock');
    const names = modules.map(([, c]) => c.displayName);
    expect(new Set(names).size).toBe(names.length);
  });

  it('renders a navigation icon as a decorative svg', () => {
    const out = html(<NavIcon name="orders" />);
    expect(out).toMatch(/^<svg/);
    expect(out).toContain('aria-hidden="true"');
  });
});
