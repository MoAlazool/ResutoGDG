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

  it('gives a live floor the legacy portrait phone crop over its tables and its room shell', () => {
    const [x, y, w, h] = narrowView(landingFloorFrom(DEMO_FLOOR_MAIN)).split(' ').map(Number);
    // POL-01: the crop reaches the north wall + window strip (y 34-46) and the south wall (y 755-765), as legacy's phone
    // hero showed them; before, it stopped at y 55-735 and the phone hero had no room architecture at all.
    expect(y).toBeLessThanOrEqual(34);
    expect(y! + h!).toBeGreaterThanOrEqual(765);
    // ...and stops above the entrance's label (door y 760, label 766-795), which it used to cut into (stray glyphs).
    expect(y! + h!).toBeLessThanOrEqual(766);
    expect(w! / h!).toBeCloseTo(480 / 680, 2); // the legacy portrait shape
    expect(h).toBeLessThanOrEqual(850); // tables keep at least 80% of the legacy scale (680 tall)
    expect(x).toBe(130); // starts at the first column of tables (T4, round 120, spans 190-310)
  });

  it('the recorded sample keeps the legacy crop’s x and reaches its north wall, window strip and south wall', () => {
    // Before: the fixed legacy crop 140 60 480 680 (y 60-740) left out every wall and the window (POL-01 review).
    const [x, y, w, h] = narrowView(SAMPLE_FLOOR).split(' ').map(Number);
    expect(x).toBe(140);
    const shell = SAMPLE_FLOOR.objects.filter((o) => (o.type === 'wall' && o.width > o.height) || o.type === 'window');
    expect(shell.map((o) => o.id).sort()).toEqual(['demo-wall', 'demo-wall-south', 'demo-window']);
    for (const o of shell) {
      expect(y, o.id).toBeLessThanOrEqual(o.y - o.height / 2);
      expect(y! + h!, o.id).toBeGreaterThanOrEqual(o.y + o.height / 2);
    }
    // The entrance (y 740) draws its label from y 746: the crop ends above it rather than through it.
    const door = SAMPLE_FLOOR.objects.find((o) => o.type === 'door')!;
    expect(y! + h!).toBeLessThanOrEqual(door.y + 6);
    expect(w! / h!).toBeCloseTo(480 / 680, 2);
    expect(h).toBeGreaterThanOrEqual(680);
    expect(h).toBeLessThanOrEqual(850);
  });

  it('doors do not stretch the crop, and the bottom edge never cuts through a door label', () => {
    const bare = { ...DEMO_FLOOR_MAIN, objects: [] as unknown[] };
    const base = narrowView(landingFloorFrom(bare));
    // A door well below the tables, over their columns: not part of the shell, so the crop stays as it was.
    const low = { id: 'd', type: 'door', label: 'Entrance', x: 300, y: 790, width: 90, height: 20, rotation: 0 };
    expect(narrowView(landingFloorFrom({ ...bare, objects: [low] }))).toBe(base);
    // A door whose label band (y+6 .. y+35) straddles the bottom edge: the crop ends just above the label.
    const [, y0, , h0] = base.split(' ').map(Number);
    const end = y0! + h0!;
    const door = { ...low, y: end - 16 };
    const [, y1, w1, h1] = narrowView(landingFloorFrom({ ...bare, objects: [door] })).split(' ').map(Number);
    expect(y1! + h1!).toBeLessThanOrEqual(door.y + 6);
    expect(w1! / h1!).toBeCloseTo(480 / 680, 2);
    // ...unless that would cut a wall the crop reached: then the edge stays below the wall.
    const wall = { id: 'w', type: 'wall', label: 'South wall', x: 600, y: door.y + 2, width: 1100, height: 10, rotation: 0 };
    const [, y2, , h2] = narrowView(landingFloorFrom({ ...bare, objects: [wall, door] })).split(' ').map(Number);
    expect(y2! + h2!).toBeGreaterThanOrEqual(wall.y + wall.height / 2);
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
