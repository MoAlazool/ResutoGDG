import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { labelForms } from './labels';
import type { FloorObject } from './model';

// The web unit tests run without a JSX config (classic transform), so the component module needs a global React.
(globalThis as { React?: typeof React }).React = React;
const { FloorSceneContent, labelDirection } = await import('./FloorScene');
const { createElement } = React;

const zone = (label: string): FloorObject => ({ id: 'z', type: 'zone', label, x: 600, y: 220, width: 1000, height: 300, rotation: 0, color: '#e9efe5' });
const draw = (label: string) =>
  renderToStaticMarkup(createElement('svg', null, createElement(FloorSceneContent, { layout: { width: 1200, height: 800, zones: [zone(label)], objects: [], tables: [] } })));
const zoneText = (html: string) => /<text class="zone-label"[^>]*>/.exec(html)?.[0] ?? '';

describe('floor scene zone captions (VP-13 / VS-08)', () => {
  it('reads a label’s direction from its first strong character', () => {
    expect(labelDirection('الصالة الرئيسية')).toBe('rtl');
    expect(labelDirection('Main room')).toBe('ltr');
    expect(labelDirection('12 التراس')).toBe('rtl');
    expect(labelDirection('VIP الطابق')).toBe('ltr');
    expect(labelDirection('')).toBe('ltr');
  });

  it('keeps an Arabic caption inside the zone, at its top right, whatever the page direction', () => {
    const t = zoneText(draw('الصالة الرئيسية'));
    // Explicit direction on the text: an inherited direction:rtl can no longer flip "start" to the other edge.
    expect(t).toContain('direction="rtl"');
    expect(t).toContain('text-anchor="start"');
    expect(t).toContain('x="476"'); // right inset: 1000 / 2 - 24
  });

  it('keeps a Latin caption at the zone’s top left', () => {
    const t = zoneText(draw('Main room'));
    expect(t).toContain('direction="ltr"');
    expect(t).toContain('x="-476"');
  });
});

describe('standard floor label lookup', () => {
  it('tries the stored label, then sentence and title case', () => {
    expect(labelForms('MAIN ROOM')).toEqual(['MAIN ROOM', 'Main room', 'Main Room']);
    expect(labelForms('Main room')).toEqual(['Main room', 'Main Room']);
    expect(labelForms('  service   &  bar ')).toEqual(['  service   &  bar ', 'service & bar', 'Service & bar', 'Service & Bar']);
  });
});
