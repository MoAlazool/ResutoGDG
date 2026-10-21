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

describe('floor room architecture (PAR-01)', async () => {
  const { DEMO_FLOOR_MAIN } = await import('../landing/floor-data.fixture');
  const { inDrawOrder } = await import('./FloorScene');
  const f = DEMO_FLOOR_MAIN as unknown as { width: number; height: number; zones: FloorObject[]; objects: FloorObject[] };
  const html = renderToStaticMarkup(createElement('svg', null, createElement(FloorSceneContent, {
    layout: { width: f.width, height: f.height, zones: f.zones, objects: f.objects, tables: [] }, mode: 'operations',
  })));
  const ids = [...html.matchAll(/data-object-id="([^"]+)"/g)].map((m) => m[1]);

  it('draws the demo room like legacy: four walls, the window strip, the service bar and the entrance', () => {
    expect(html.match(/class="wall-core"/g)?.length).toBe(4);
    expect(html).toContain('class="window-frame"');
    expect(html).toContain('class="counter-surface"');
    expect(html).toMatch(/<text[^>]*class="structure-label"[^>]*>Service &amp; bar<\/text>/);
    expect(html).toContain('class="door-leaf"');
  });

  it('draws walls before the openings cut into them, whatever order the layout stores them in', () => {
    // The stored order has the door before the south wall (older floors gained their walls later).
    expect(f.objects.findIndex((o) => o.id === 'door')).toBeLessThan(f.objects.findIndex((o) => o.id === 'wall-bottom'));
    expect(ids.indexOf('wall-bottom')).toBeLessThan(ids.indexOf('door'));
    expect(ids.indexOf('wall-top')).toBeLessThan(ids.indexOf('window-north'));
    // Non-wall objects keep their stored order.
    expect(ids.filter((i) => !i.startsWith('wall-') && !i.startsWith('zone-'))).toEqual(['door', 'window-north', 'counter-bar']);
  });

  it('keeps the sort stable and leaves a layout without walls untouched', () => {
    const o = (id: string, type: string) => ({ id, type });
    expect(inDrawOrder([o('a', 'plant'), o('w', 'wall'), o('b', 'door'), o('d', 'divider')]).map((x) => x.id)).toEqual(['w', 'd', 'a', 'b']);
    const plain = [o('a', 'plant'), o('b', 'door')];
    expect(inDrawOrder(plain)).toEqual(plain);
  });
});
