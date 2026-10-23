import { describe, expect, it } from 'vitest';
import { landingFloorFrom, narrowView, SAMPLE_FLOOR } from './floor-data';
import { DEMO_FLOOR_MAIN } from './floor-data.fixture';

describe('landing floor (VP-12)', () => {
  it('uses the demo restaurant’s saved floor from the public floor endpoint', () => {
    const f = landingFloorFrom(DEMO_FLOOR_MAIN);
    expect(f.live).toBe(true);
    expect(f.tables.map((t) => t.label)).toEqual(['T1', 'T2', 'T3', 'T4', 'T5', 'T6']);
    expect(f.zones.map((z) => z.label)).toEqual(['Main room', 'Terrace']);
    expect(f.objects.map((o) => o.label)).toContain('Entrance');
    // The room architecture reaches the hero (PAR-01): walls, the window strip and the service bar.
    expect(new Set(f.objects.map((o) => o.type))).toEqual(new Set(['wall', 'door', 'window', 'counter']));
    expect(f.width).toBe(1200);
  });

  it('falls back to the recorded sample when the endpoint is unavailable or malformed', () => {
    for (const bad of [null, {}, { width: 1200, height: 800, tables: [] }, { width: 'x', tables: [{}] }]) {
      expect(landingFloorFrom(bad)).toBe(SAMPLE_FLOOR);
    }
  });

  it('gives a live floor the legacy portrait phone crop over its tables and its room shell, and keeps the legacy crop for the sample', () => {
    expect(narrowView(SAMPLE_FLOOR)).toBe('140 60 480 680');
    const [x, y, w, h] = narrowView(landingFloorFrom(DEMO_FLOOR_MAIN)).split(' ').map(Number);
    // POL-01: the crop reaches the north wall + window strip (y 34-46) and the south wall (y 755-765), as legacy's phone
    // hero showed them; before, it stopped at y 55-735 and the phone hero had no room architecture at all.
    expect(y).toBeLessThanOrEqual(34);
    expect(y! + h!).toBeGreaterThanOrEqual(765);
    expect(w! / h!).toBeCloseTo(480 / 680, 2); // the legacy portrait shape
    expect(h).toBeLessThanOrEqual(850); // tables keep at least 80% of the legacy scale (680 tall)
    expect(x).toBe(130); // starts at the first column of tables (T4, round 120, spans 190-310)
  });

  it('a phone crop without a reachable shell keeps the legacy size centred on the tables', () => {
    const bare = landingFloorFrom({ ...DEMO_FLOOR_MAIN, objects: [] });
    const [, y, w, h] = narrowView(bare).split(' ').map(Number);
    expect([w, h]).toEqual([480, 680]); // the legacy portrait crop's size, so tables draw at the legacy scale
    expect(y).toBeLessThanOrEqual(170); // T2/T3 (100 tall) start at 170
    expect(y! + h!).toBeGreaterThanOrEqual(620); // the terrace tables end at 620
    // A shell far from the tables (a tall canvas) would shrink the tables below 80%: the crop ignores it.
    const tall = landingFloorFrom({ ...DEMO_FLOOR_MAIN, height: 1600, objects: [{ id: 'w', type: 'wall', label: 'South wall', x: 600, y: 1500, width: 1100, height: 10, rotation: 0 }] });
    expect(narrowView(tall).split(' ').map(Number).slice(2)).toEqual([480, 680]);
    // Side walls (outside the tables' columns) and hidden objects do not stretch the crop.
    const sides = landingFloorFrom({ ...DEMO_FLOOR_MAIN, objects: [
      ...DEMO_FLOOR_MAIN.objects.filter((o) => o.id === 'wall-left' || o.id === 'wall-right'),
      { id: 'h', type: 'wall', label: 'Hidden', x: 600, y: 20, width: 1100, height: 10, rotation: 0, hidden: true },
    ] });
    expect(narrowView(sides).split(' ').map(Number).slice(2)).toEqual([480, 680]);
  });

  it('the recorded sample (the fallback when the API is down) is a closed room like the legacy fixture', () => {
    const types = SAMPLE_FLOOR.objects.map((o) => o.type);
    expect(types.filter((t) => t === 'wall')).toHaveLength(4);
    expect(types).toEqual(expect.arrayContaining(['window', 'door', 'counter']));
    // Every table sits inside the walls.
    const walls = SAMPLE_FLOOR.objects.filter((o) => o.type === 'wall');
    const left = Math.min(...walls.map((o) => o.x + o.width / 2)), right = Math.max(...walls.map((o) => o.x - o.width / 2));
    const top = Math.min(...walls.map((o) => o.y + o.height / 2)), bottom = Math.max(...walls.map((o) => o.y - o.height / 2));
    for (const t of SAMPLE_FLOOR.tables) {
      expect(t.cx - t.width / 2).toBeGreaterThan(left);
      expect(t.cx + t.width / 2).toBeLessThan(right);
      expect(t.cy - t.height / 2).toBeGreaterThan(top);
      expect(t.cy + t.height / 2).toBeLessThan(bottom);
    }
  });

  it('centres a narrow live room in the portrait crop and never leaves the canvas', () => {
    // T2 (mid-room): with the room shell in the crop it is wider than 480, so T1 (cx 250) would be clamped at the canvas edge.
    const one = landingFloorFrom({ ...DEMO_FLOOR_MAIN, tables: [DEMO_FLOOR_MAIN.tables[1]] });
    const [x, y, w, h] = narrowView(one).split(' ').map(Number);
    const t = one.tables[0]!;
    expect(Math.abs(x! + w! / 2 - t.cx)).toBeLessThanOrEqual(1); // viewBox values are rounded to whole units
    // A table near the west wall: the crop is clamped to the canvas instead of leaving it.
    const [x1, , w1] = narrowView(landingFloorFrom({ ...DEMO_FLOOR_MAIN, tables: [DEMO_FLOOR_MAIN.tables[0]] })).split(' ').map(Number);
    expect(x1).toBe(0);
    expect(x1! + w1!).toBeLessThanOrEqual(DEMO_FLOOR_MAIN.width);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x! + w!).toBeLessThanOrEqual(one.width);
    expect(h).toBeGreaterThan(0);
  });
});
