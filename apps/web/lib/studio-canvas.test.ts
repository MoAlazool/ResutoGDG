import type { PublicSite } from '@resuto/contracts';
import { describe, expect, it } from 'vitest';
import { CANVAS_PROTOCOL, CANVAS_SANDBOX, fromCanvas, readFromCanvas, readToCanvas, toCanvas } from './studio-canvas';

const frame = { name: 'frame window' };
const parent = { name: 'editor window' };
const ORIGIN = 'https://app.resuto.test';
const SID = '6f1c2a40-0000-4000-8000-000000000001';
const site = {
  slug: 'grill', revision: 1, publishedAt: null, preview: true, org: { name: 'Grill' }, template: 'olive', theme: {}, seo: {},
  sections: [{ id: SID, kind: 'hero', content: {} }], branches: [], menuHighlights: [], canonicalHost: null, links: { order: '/order/grill' }, storefronts: [],
} as unknown as PublicSite;

describe('Studio canvas messages (sandboxed iframe, no allow-same-origin)', () => {
  it('sandboxes the frame with scripts only', () => {
    expect(CANVAS_SANDBOX).toBe('allow-scripts');
    expect(CANVAS_SANDBOX).not.toMatch(/same-origin|top-navigation|popups|forms|modals/);
  });

  it('editor accepts ready and select from its own frame (opaque origin "null") only', () => {
    expect(readFromCanvas({ data: fromCanvas.ready(), origin: 'null', source: frame }, frame)).toEqual(fromCanvas.ready());
    expect(readFromCanvas({ data: fromCanvas.select(SID), origin: 'null', source: frame }, frame)).toEqual(fromCanvas.select(SID));
    expect(readFromCanvas({ data: fromCanvas.select('site'), origin: 'null', source: frame }, frame)?.type).toBe('select');
    expect(readFromCanvas({ data: fromCanvas.select(null), origin: 'null', source: frame }, frame)).toEqual(fromCanvas.select(null));
  });

  it('editor ignores messages from other windows, other origins and malformed or extended shapes', () => {
    const ok = fromCanvas.select(SID);
    expect(readFromCanvas({ data: ok, origin: 'null', source: parent }, frame)).toBeNull();
    expect(readFromCanvas({ data: ok, origin: 'null', source: frame }, null)).toBeNull();
    for (const origin of [ORIGIN, 'https://evil.example', '']) expect(readFromCanvas({ data: ok, origin, source: frame }, frame)).toBeNull();
    const bad: unknown[] = [
      null, 'select', [ok], { ...ok, v: 2 }, { ...ok, protocol: 'other' }, { ...ok, type: 'navigate' }, { ...ok, id: 'javascript:alert(1)' },
      { ...ok, id: '../../etc' }, { ...ok, extra: true }, { protocol: CANVAS_PROTOCOL, v: 1, type: 'select' }, Object.assign(Object.create({ polluted: true }), ok),
      { protocol: CANVAS_PROTOCOL, v: 1, type: 'ready', token: 'x' },
    ];
    for (const data of bad) expect(readFromCanvas({ data, origin: 'null', source: frame }, frame), JSON.stringify(data)).toBeNull();
  });

  it('canvas accepts render and select from its parent at the app origin only', () => {
    const render = toCanvas.render(site, 'ar', SID, null);
    expect(readToCanvas({ data: render, origin: ORIGIN, source: parent }, parent, ORIGIN)).toMatchObject({ type: 'render', locale: 'ar', selected: SID });
    expect(readToCanvas({ data: toCanvas.select(SID), origin: ORIGIN, source: parent }, parent, ORIGIN)).toEqual(toCanvas.select(SID));
    expect(readToCanvas({ data: render, origin: 'https://evil.example', source: parent }, parent, ORIGIN)).toBeNull();
    expect(readToCanvas({ data: render, origin: 'null', source: parent }, parent, ORIGIN)).toBeNull();
    expect(readToCanvas({ data: render, origin: ORIGIN, source: frame }, parent, ORIGIN)).toBeNull();
  });

  it('canvas refuses render messages whose site or options are not the expected shape', () => {
    const base = toCanvas.render(site, 'en', null, 'after');
    const bad: unknown[] = [
      { ...base, locale: 'fr' }, { ...base, compare: 'side' }, { ...base, selected: 42 }, { ...base, site: null }, { ...base, site: { ...site, sections: 'x' } },
      { ...base, site: { ...site, sections: [{ id: 1, kind: 'hero', content: {} }] } }, { ...base, site: { ...site, org: null } }, { ...base, html: '<script>' },
    ];
    for (const data of bad) expect(readToCanvas({ data, origin: ORIGIN, source: parent }, parent, ORIGIN), JSON.stringify(data).slice(0, 80)).toBeNull();
  });
});
