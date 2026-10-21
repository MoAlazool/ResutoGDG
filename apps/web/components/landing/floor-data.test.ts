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

  it('gives a live floor the legacy portrait phone crop over its tables, and keeps the legacy crop for the sample', () => {
    expect(narrowView(SAMPLE_FLOOR)).toBe('140 60 480 680');
    const [x, y, w, h] = narrowView(landingFloorFrom(DEMO_FLOOR_MAIN)).split(' ').map(Number);
    expect([w, h]).toEqual([480, 680]); // the legacy portrait crop's size, so tables draw at the legacy scale
    expect(y).toBeLessThanOrEqual(170); // T2/T3 (100 tall) start at 170
    expect(y! + h!).toBeGreaterThanOrEqual(620); // the terrace tables end at 620
    expect(x).toBe(130); // starts at the first column of tables (T4, round 120, spans 190-310)
  });

  it('centres a narrow live room in the portrait crop and never leaves the canvas', () => {
    const one = landingFloorFrom({ ...DEMO_FLOOR_MAIN, tables: [DEMO_FLOOR_MAIN.tables[0]] });
    const [x, y, w, h] = narrowView(one).split(' ').map(Number);
    const t = one.tables[0]!;
    expect(x! + w! / 2).toBeCloseTo(t.cx, 0);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x! + w!).toBeLessThanOrEqual(one.width);
    expect(h).toBeGreaterThan(0);
  });
});
