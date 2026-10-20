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
    expect(f.width).toBe(1200);
  });

  it('falls back to the recorded sample when the endpoint is unavailable or malformed', () => {
    for (const bad of [null, {}, { width: 1200, height: 800, tables: [] }, { width: 'x', tables: [{}] }]) {
      expect(landingFloorFrom(bad)).toBe(SAMPLE_FLOOR);
    }
  });

  it('crops a live floor to its tables on phones and keeps the legacy crop for the sample', () => {
    expect(narrowView(SAMPLE_FLOOR)).toBe('140 60 480 680');
    const [x, y, w, h] = narrowView(landingFloorFrom(DEMO_FLOOR_MAIN)).split(' ').map(Number);
    expect(x).toBe(130); // T4 (round, 120) spans 190–310
    expect(y).toBe(110); // T2/T3 (100) start at 170
    expect(x! + w!).toBe(900);
    expect(y! + h!).toBe(680);
  });
});
