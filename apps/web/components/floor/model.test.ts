import { describe, expect, it } from 'vitest';
import {
  arrange, autoNumber, bounds, chairPositions, createItem, demoFloor, duplicateItems, emptyBackground, geometryError, isDraftId, layoutErrors,
  normalizeLayout, normalizeRotation, overlaps, quantize, resizeFromPointer, rotationFromPointer, sameLayout, tightView, toSaveBody,
  type FloorLayout, type FloorObject, type FloorTable,
} from './model';
import { checkpoint, clearDraft, draftKey, emptyHistory, HISTORY_LIMIT, loadDraft, redo, rememberDraft, undo } from './draft-store';

const table = (over: Partial<FloorTable> = {}): FloorTable => ({
  id: over.id ?? 't', label: 'T1', capacity: 4, zone: 'Main Room', shape: 'square', cx: 300, cy: 300, width: 100, height: 100, rotation: 0,
  features: [], reservable: true, minSpendMinor: null, premium: false, internalNotes: null, ...over,
});
const obj = (over: Partial<FloorObject> = {}): FloorObject => ({ id: 'o', type: 'wall', label: 'Wall', x: 600, y: 400, width: 200, height: 10, rotation: 0, ...over });
const layout = (over: Partial<FloorLayout> = {}): FloorLayout => ({ revision: 3, width: 1200, height: 800, background: emptyBackground(), zones: [], objects: [], tables: [], ...over });

describe('bounds', () => {
  it('uses the centre for tables and objects', () => {
    expect(bounds(table({ cx: 300, cy: 200, width: 100, height: 60 }))).toEqual({ left: 250, right: 350, top: 170, bottom: 230 });
    expect(bounds(obj({ x: 600, y: 40, width: 1120, height: 16 }))).toEqual({ left: 40, right: 1160, top: 32, bottom: 48 });
  });
  it('swaps extents at 90° and grows at 45°', () => {
    const b = bounds(table({ width: 160, height: 90, rotation: 90 }));
    expect(b.right - b.left).toBeCloseTo(90);
    expect(b.bottom - b.top).toBeCloseTo(160);
    const d = bounds(table({ width: 100, height: 100, rotation: 45 }));
    expect(d.right - d.left).toBeCloseTo(141.42, 1);
  });
});

describe('geometry validation (legacy rules)', () => {
  it('accepts objects inside the canvas', () => {
    expect(geometryError(table())).toBeNull();
    expect(geometryError(table({ cx: 50, cy: 50, width: 100, height: 100 }))).toBeNull();
  });
  it('rejects objects outside the canvas, including by rotation', () => {
    expect(geometryError(table({ cx: 40, cy: 300 }))).toBe('outside_canvas');
    expect(geometryError(table({ cx: 1180, cy: 300 }))).toBe('outside_canvas');
    expect(geometryError(table({ cx: 600, cy: 760, width: 60, height: 60 }))).toBeNull();
    expect(geometryError(table({ cx: 50, cy: 300, width: 100, height: 100, rotation: 45 }))).toBe('outside_canvas');
  });
  it('rejects invalid dimensions and rotation', () => {
    expect(geometryError(table({ width: 3 }))).toBe('invalid_dimensions');
    expect(geometryError(table({ rotation: 360 }))).toBe('invalid_dimensions');
    expect(geometryError(table({ rotation: -1 }))).toBe('invalid_dimensions');
    expect(geometryError(table({ cx: Number.NaN }))).toBe('invalid_dimensions');
  });
  it('collects layout errors including background, capacity and duplicate labels', () => {
    const f = layout({ tables: [table({ id: 'a' }), table({ id: 'b', cx: 600, label: 't1' }), table({ id: 'c', cx: 900, label: 'T3', capacity: 0 })] });
    f.background = { ...f.background, x: 100, width: 1200 };
    const codes = layoutErrors(f).map((e) => `${e.id}:${e.code}`);
    expect(codes).toEqual(expect.arrayContaining(['b:duplicate_label', 'c:invalid_capacity', 'null:background_outside']));
    expect(layoutErrors(demoFloor())).toEqual([]);
  });
});

describe('overlaps', () => {
  it('reports overlapping tables and counters but ignores zones and walls', () => {
    const f = layout({
      tables: [table({ id: 'a', label: 'T1', cx: 300 }), table({ id: 'b', label: 'T2', cx: 380 }), table({ id: 'c', label: 'T3', cx: 700 })],
      objects: [obj({ id: 'bar', type: 'counter', label: 'Bar', x: 720, y: 300, width: 40, height: 40 }), obj({ id: 'w', x: 300, y: 300 })],
    });
    expect(overlaps(f)).toEqual(['T1 / T2', 'T3 / Bar']);
    expect(overlaps(demoFloor())).toEqual([]);
  });
  it('treats touching edges as not overlapping', () => {
    expect(overlaps(layout({ tables: [table({ id: 'a', cx: 300 }), table({ id: 'b', cx: 400 })] }))).toEqual([]);
  });
});

describe('alignment and distribution', () => {
  it('aligns left/right/top/bottom by rotated bounds', () => {
    const a = table({ id: 'a', cx: 200, cy: 200, width: 100 }), b = table({ id: 'b', cx: 500, cy: 420, width: 160, height: 90, shape: 'rect' });
    expect(arrange([a, b], 'align-left')).toBe(true);
    expect(bounds(b).left).toBe(bounds(a).left);
    arrange([a, b], 'align-bottom');
    expect(bounds(a).bottom).toBe(bounds(b).bottom);
    const c = table({ id: 'c', cx: 200, cy: 200, width: 100, rotation: 90, shape: 'rect', height: 60 }), d = table({ id: 'd', cx: 600, cy: 300 });
    arrange([c, d], 'align-right');
    expect(bounds(c).right).toBeCloseTo(bounds(d).right);
  });
  it('centres on the combined bounds', () => {
    const a = table({ id: 'a', cx: 200, cy: 200 }), b = table({ id: 'b', cx: 600, cy: 500 });
    arrange([a, b], 'align-center');
    expect(a.cx).toBe(400);
    expect(b.cx).toBe(400);
    arrange([a, b], 'align-middle');
    expect(a.cy).toBe(350);
  });
  it('spaces objects with equal gaps keeping the outer ones fixed', () => {
    const a = table({ id: 'a', cx: 150, width: 100 }), b = table({ id: 'b', cx: 260, width: 60, height: 60 }), c = table({ id: 'c', cx: 850, width: 100 });
    expect(arrange([c, a, b], 'space-x')).toBe(true);
    expect(a.cx).toBe(150);
    expect(c.cx).toBe(850);
    const gap1 = bounds(b).left - bounds(a).right, gap2 = bounds(c).left - bounds(b).right;
    expect(gap1).toBeCloseTo(gap2);
    expect(gap1).toBeCloseTo((800 - 260) / 2);
  });
  it('spaces vertically and requires enough objects', () => {
    const a = obj({ id: 'a', y: 100, height: 20 }), b = obj({ id: 'b', y: 130, height: 20 }), c = obj({ id: 'c', y: 700, height: 20 });
    arrange([a, b, c], 'space-y');
    expect(b.y).toBe(400);
    expect(arrange([a], 'align-left')).toBe(false);
    expect(arrange([a, b], 'space-x')).toBe(false);
  });
});

describe('editing helpers', () => {
  it('normalises rotation and quantises to the 10-unit grid', () => {
    expect(normalizeRotation(-15)).toBe(345);
    expect(normalizeRotation(375.4)).toBe(15);
    expect(quantize(234, true)).toBe(230);
    expect(quantize(234.6, false)).toBe(235);
  });
  it('resizes in the rotated frame and keeps round/square tables square', () => {
    const t = table({ cx: 500, cy: 400, shape: 'round' });
    resizeFromPointer(t, structuredClone(t), { x: 580, y: 430 }, true);
    expect(t.width).toBe(160);
    expect(t.height).toBe(160);
    const r = table({ cx: 500, cy: 400, shape: 'rect', rotation: 90 });
    resizeFromPointer(r, structuredClone(r), { x: 530, y: 480 }, true);
    expect(r.width).toBe(160);
    expect(r.height).toBe(60);
    const tiny = obj();
    resizeFromPointer(tiny, structuredClone(tiny), { x: 600, y: 400 }, false);
    expect(tiny.width).toBe(4);
  });
  it('rotates toward the pointer with 15° snapping', () => {
    expect(rotationFromPointer(table({ cx: 0, cy: 0 }), { x: 100, y: 0 }, true)).toBe(90);
    expect(rotationFromPointer(table({ cx: 0, cy: 0 }), { x: 100, y: 10 }, true)).toBe(90);
    expect(rotationFromPointer(table({ cx: 0, cy: 0 }), { x: 100, y: 10 }, false)).toBe(96);
  });
  it('auto-numbers in reading order and skips locked labels', () => {
    const ts = [table({ id: 'a', cx: 500, cy: 100, label: 'X' }), table({ id: 'b', cx: 100, cy: 100, label: 'Y' }), table({ id: 'c', cx: 100, cy: 500, label: 'T1', locked: true })];
    autoNumber(ts);
    expect(ts.map((t) => t.label)).toEqual(['T3', 'T2', 'T1']);
  });
  it('creates palette items with legacy defaults and unique table labels', () => {
    const f = layout({ tables: [table({ label: 'T2' })], zones: [obj({ id: 'z', type: 'zone', label: 'Main Room' })] });
    const round = createItem(f, 'round');
    expect(round.list).toBe('tables');
    expect(round.item).toMatchObject({ label: 'T3', capacity: 4, shape: 'round', width: 110, zone: 'Main Room' });
    expect(isDraftId(round.item.id)).toBe(true);
    expect(createItem(f, 'rect').item).toMatchObject({ width: 180, capacity: 6 });
    expect(createItem(f, 'wall').item).toMatchObject({ type: 'wall', width: 240, height: 10 });
    expect(createItem(f, 'terrace')).toMatchObject({ list: 'zones', item: { type: 'zone', label: 'Terrace', material: 'garden' } });
  });
  it('duplicates with offset and fresh ids', () => {
    const [copy] = duplicateItems([table({ id: 'srv-1', status: 'occupied', version: 3 })]);
    expect(copy).toMatchObject({ cx: 330, cy: 330, label: 'T1 copy' });
    expect(isDraftId(copy!.id)).toBe(true);
    expect((copy as FloorTable).status).toBeUndefined();
  });
  it('places chairs around round and rectangular tables', () => {
    const round = chairPositions({ capacity: 4, width: 100, height: 100, shape: 'round' });
    expect(round).toHaveLength(4);
    expect(round[0]!.x).toBeCloseTo(0);
    expect(round[0]!.y).toBeCloseTo(-71);
    const rect = chairPositions({ capacity: 6, width: 180, height: 110, shape: 'rect' });
    expect(rect).toHaveLength(6);
    expect(rect.filter((c) => c.rotation === 0)).toHaveLength(2);
    expect(chairPositions({ capacity: 99, width: 100, height: 100, shape: 'square' })).toHaveLength(20);
  });
  it('crops the view to the furniture', () => {
    expect(tightView(layout({ tables: [table({ cx: 300, cy: 300 })] }))).toBe('190 190 220 220');
    expect(tightView(layout())).toBe('0 0 1200 800');
  });
});

describe('save body and normalisation', () => {
  it('omits ids of new tables and never sends operational status', () => {
    const f = layout({ tables: [table({ id: 'srv-1', status: 'occupied', version: 2 }), table({ id: 'new-abc', cx: 700, label: 'T2' })] });
    const body = toSaveBody(f, 'key-1');
    expect(body.baseRevision).toBe(3);
    expect(body.key).toBe('key-1');
    expect(body.layout.tables[0]).not.toHaveProperty('status');
    expect(body.layout.tables[0]).not.toHaveProperty('version');
    expect(body.layout.tables[0]!.id).toBe('srv-1');
    expect(body.layout.tables[1]!.id).toBeUndefined();
  });
  it('maps legacy shapes and minimum spend', () => {
    const f = normalizeLayout({ revision: 1, tables: [{ id: 'a', label: 'T1', capacity: '4', shape: 'rectangle', cx: '10', cy: 20, width: 100, height: 60, minimumSpend: 5000 } as any] });
    expect(f.tables[0]).toMatchObject({ shape: 'rect', capacity: 4, cx: 10, minSpendMinor: 5000, reservable: true, features: [] });
    expect(f.background).toEqual(emptyBackground());
  });
});

describe('draft persistence and history', () => {
  const mem = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
  };
  it('keeps a dirty draft and clears it when it matches the base', () => {
    const s = mem(), key = draftKey('org', 'branch');
    const base = layout(), draft = layout({ tables: [table()] });
    expect(rememberDraft(s, key, draft, base)).toBe(true);
    const loaded = loadDraft(s, key)!;
    expect(sameLayout(loaded.draft, draft)).toBe(true);
    expect(loaded.base.revision).toBe(3);
    rememberDraft(s, key, base, base);
    expect(loadDraft(s, key)).toBeNull();
    s.setItem(key, '{broken');
    expect(loadDraft(s, key)).toBeNull();
    clearDraft(s, key);
    expect(s.m.size).toBe(0);
  });
  it('reports a full storage instead of throwing', () => {
    const full = { getItem: () => null, setItem: () => { throw new Error('QuotaExceeded'); }, removeItem: () => undefined };
    expect(rememberDraft(full, 'k', layout({ tables: [table()] }), layout())).toBe(false);
  });
  it('undoes and redoes with a bounded history', () => {
    const a = layout(), b = layout({ tables: [table()] });
    let h = checkpoint(emptyHistory(), a);
    const u = undo(h, b)!;
    expect(u.draft).toEqual(a);
    const r = redo(u.history, u.draft)!;
    expect(r.draft).toEqual(b);
    expect(undo(emptyHistory(), a)).toBeNull();
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) h = checkpoint(h, a);
    expect(h.past).toHaveLength(HISTORY_LIMIT);
  });
});
