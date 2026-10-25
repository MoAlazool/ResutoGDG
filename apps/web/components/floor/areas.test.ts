import { describe, expect, it } from 'vitest';
import { areaScene, floorAreas } from './areas';
import type { SceneLayout, SceneTable } from './FloorScene';
import { freeingSoon, type LiveTable } from './live';

const tbl = (id: string, zone: string | null, cx: number, cy: number): SceneTable =>
  ({ id, label: id, capacity: 4, zone, shape: 'square', cx, cy, width: 80, height: 80, rotation: 0 } as unknown as SceneTable);
const zone = (label: string, x: number, y: number) => ({ id: `z-${label}`, type: 'zone', label, x, y, width: 400, height: 300, rotation: 0 });
const scene: SceneLayout = {
  width: 1200, height: 800, zones: [zone('Terrace', 900, 600), zone('Main Room', 300, 300), zone('Empty', 900, 200)] as never,
  objects: [{ id: 'bar', type: 'bar', x: 600, y: 100, width: 200, height: 40, rotation: 0 }] as never,
  tables: [tbl('T1', 'Main Room', 250, 250), tbl('T2', 'Main Room', 400, 300), tbl('T3', 'Terrace', 900, 620), tbl('T4', 'Patio', 100, 700), tbl('T5', null, 600, 600)],
};

describe('floor areas (area tabs)', () => {
  it('lists the zones that have tables, layout order first, then other table zones', () => {
    expect(floorAreas(scene)).toEqual([{ label: 'Terrace', tables: 1 }, { label: 'Main Room', tables: 2 }, { label: 'Patio', tables: 1 }]);
  });
  it('crops the map to one area and keeps the whole floor otherwise', () => {
    const main = areaScene(scene, 'Main Room');
    expect(main.layout.tables.map((t) => t.id)).toEqual(['T1', 'T2']);
    expect(main.layout.zones.map((z) => z.label)).toEqual(['Main Room']);
    expect(main.layout.objects).toHaveLength(1); // furniture stays; the view is cropped
    const [x, y, w, h] = main.viewBox!.split(' ').map(Number);
    expect(x).toBeLessThanOrEqual(100);
    expect(x! + w!).toBeGreaterThanOrEqual(500);
    expect(y! + h!).toBeLessThan(800);
    expect(areaScene(scene, null)).toEqual({ layout: scene });
    expect(areaScene(scene, 'Gone')).toEqual({ layout: scene });
  });
});

describe('walk-in: tables closest to free', () => {
  const NOW = Date.parse('2026-10-20T20:00:00Z');
  const live = (label: string, capacity: number, extra: Partial<LiveTable> = {}) =>
    ({ id: label, label, capacity, zone: null, status: 'available', visit: null, nextReservation: null, ...extra } as unknown as LiveTable);
  const v = (x: Partial<NonNullable<LiveTable['visit']>>) => ({ id: 'v', partySize: 2, openedAt: '2026-10-20T19:00:00Z', orderCount: 1, dueMinor: 1000, paidMinor: 0, requests: [], ...x });
  it('orders cleaning, paid, paying, part paid; only tables that fit', () => {
    const tables = [
      live('A', 4, { visit: v({ paidMinor: 400, dueMinor: 600 }) }), live('B', 4, { visit: v({ requests: ['bill'] }) }), live('C', 6, { status: 'cleaning' }),
      live('D', 4, { visit: v({ paidMinor: 1000, dueMinor: 0, totalMinor: 1000 }) }), live('E', 2, { status: 'cleaning' }), live('F', 4, { visit: v({}) }), live('G', 4),
    ];
    expect(freeingSoon(tables, 3, NOW).map((x) => [x.table.label, x.key])).toEqual([['C', 'cleaning'], ['D', 'paid'], ['B', 'payment'], ['A', 'partiallyPaid']]);
    expect(freeingSoon(tables, 2, NOW).map((x) => x.table.label)).toEqual(['E', 'C', 'D', 'B', 'A']);
  });
});
