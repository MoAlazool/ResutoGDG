import { describe, expect, it } from 'vitest';
import { metresBetween, project } from './map-projection';

describe('FT-14 schematic map projection', () => {
  const box = { width: 300, height: 200, pad: 20 };
  it('keeps every point inside the padded box, north up and east right', () => {
    const pts = project([{ latitude: 30.04, longitude: 31.23 }, { latitude: 30.06, longitude: 31.25 }, { latitude: 30.05, longitude: 31.24 }], box);
    for (const p of pts) {
      expect(p.x).toBeGreaterThanOrEqual(20); expect(p.x).toBeLessThanOrEqual(280);
      expect(p.y).toBeGreaterThanOrEqual(20); expect(p.y).toBeLessThanOrEqual(180);
    }
    expect(pts[1]!.y).toBeLessThan(pts[0]!.y); // further north is higher
    expect(pts[1]!.x).toBeGreaterThan(pts[0]!.x); // further east is to the right
  });
  it('centres a single point and handles an empty list', () => {
    expect(project([{ latitude: 30, longitude: 31 }], box)).toEqual([{ x: 150, y: 100 }]);
    expect(project([], box)).toEqual([]);
  });
  it('measures distance', () => {
    expect(Math.round(metresBetween({ latitude: 30, longitude: 31 }, { latitude: 30.01, longitude: 31 }))).toBe(1112);
  });
});
