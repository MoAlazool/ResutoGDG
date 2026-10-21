// The demo floors carry the legacy room architecture (gallery PAR-01): walls on every side, the window strip, the
// service bar and the entrance. Pure:  node --test scripts/demo/test/*.test.mjs
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { boxOf, DEMO_FLOORS, FLOOR_ARCHITECTURE, withArchitecture } from '../lib/floor-architecture.mjs';

const OBJECT_TYPES = ['wall', 'door', 'window', 'counter', 'text', 'chair', 'plant', 'divider', 'entrance', 'kitchen', 'bar'];
const overlap = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
// What the older loaders stored on both demo floors.
const OLD = [
  { id: 'wall-top', type: 'wall', label: 'North wall', x: 600, y: 40, width: 1100, height: 10, rotation: 0 },
  { id: 'door', type: 'door', label: 'Entrance', x: 120, y: 760, width: 90, height: 20, rotation: 0 },
];

describe('demo floor architecture (PAR-01)', () => {
  it('frames the Zamalek room like legacy: four walls, the window strip, the service bar and the entrance', () => {
    const { objects } = withArchitecture([], 'main');
    const byType = Object.groupBy(objects, (o) => o.type);
    assert.deepEqual(byType.wall.map((o) => o.label).sort(), ['East wall', 'North wall', 'South wall', 'West wall']);
    assert.equal(byType.window.length, 1);
    assert.deepEqual(byType.counter.map((o) => o.label), ['Service & bar']);
    assert.deepEqual(byType.door.map((o) => o.label), ['Entrance']);
  });

  it('adds only what an older floor is missing and keeps stored objects exactly as they are', () => {
    const moved = [{ ...OLD[0], x: 610, label: 'Front wall' }, OLD[1]];
    const r = withArchitecture(moved, 'main');
    assert.deepEqual(r.added, ['wall-left', 'wall-right', 'wall-bottom', 'window-north', 'counter-bar']);
    assert.deepEqual(r.objects.slice(0, 2), moved);
  });

  it('is idempotent: a second refresh changes nothing', () => {
    for (const code of ['main', 'burger']) {
      const once = withArchitecture(OLD, code);
      const twice = withArchitecture(once.objects, code);
      assert.deepEqual(twice.added, [], code);
      assert.deepEqual(twice.objects, once.objects, code);
    }
  });

  it('matches the objects older loaders stored, so they are never duplicated', () => {
    for (const code of ['main', 'burger']) {
      for (const o of OLD) assert.deepEqual(FLOOR_ARCHITECTURE[code].find((x) => x.id === o.id), o, `${code} ${o.id}`);
    }
  });

  it('passes the floor contract: known types, unique ids, inside the 1200 x 800 canvas', () => {
    for (const [code, list] of Object.entries(FLOOR_ARCHITECTURE)) {
      assert.equal(new Set(list.map((o) => o.id)).size, list.length, code);
      for (const o of list) {
        assert.ok(OBJECT_TYPES.includes(o.type), `${code} ${o.id} type`);
        assert.match(o.id, /^[\w-]+$/);
        const b = boxOf(o);
        assert.ok(b.left >= 0 && b.top >= 0 && b.right <= 1200 && b.bottom <= 800, `${code} ${o.id} inside the canvas`);
      }
    }
  });

  it('never puts a counter on a table (the Floor Studio reports counter/table overlaps)', () => {
    for (const [code, floor] of Object.entries(DEMO_FLOORS)) {
      const counters = FLOOR_ARCHITECTURE[code].filter((o) => o.type === 'counter');
      assert.ok(counters.length, `${code} has a counter`);
      // Chairs reach about 30 units past a table edge: keep counters clear of them too.
      for (const c of counters) for (const t of floor.tables) {
        const tb = boxOf(t);
        assert.ok(!overlap(boxOf(c), { left: tb.left - 30, right: tb.right + 30, top: tb.top - 30, bottom: tb.bottom + 30 }), `${code} ${c.label} / ${t.label}`);
      }
    }
  });
});
