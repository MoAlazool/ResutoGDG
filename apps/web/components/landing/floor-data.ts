// The landing hero and closing banner draw the demo restaurant's saved floor (GET /v1/public/floor/<demo>/main), as
// the legacy page drew /api/public, "rendered from the same data the real product uses" (audit VP-12). The recorded
// SAMPLE floor is only the fallback when that endpoint is unavailable. Pure parsing, unit tested in floor-data.test.ts.
import type { FloorObject } from '../floor/model';
import { SAMPLE, type SampleTable } from './sample-data';

export interface LandingFloor { width: number; height: number; zones: FloorObject[]; objects: FloorObject[]; tables: SampleTable[]; live: boolean }

export const SAMPLE_FLOOR: LandingFloor = { ...SAMPLE.floor, live: false };

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Accepts the public floor payload; anything malformed (or a room without tables) falls back to the sample. */
export function landingFloorFrom(body: unknown): LandingFloor {
  const b = body as Partial<{ width: number; height: number; zones: unknown[]; objects: unknown[]; tables: unknown[] }> | null;
  if (!b || !num(b.width) || !num(b.height) || !Array.isArray(b.tables) || !b.tables.length) return SAMPLE_FLOOR;
  const tables = b.tables.filter((t): t is SampleTable => {
    const x = t as SampleTable;
    return !!x && typeof x.id === 'string' && typeof x.label === 'string' && num(x.cx) && num(x.cy) && num(x.width) && num(x.height) && num(x.capacity);
  }).map((t) => ({
    id: t.id, label: t.label, capacity: t.capacity, zone: t.zone ?? null, shape: t.shape ?? 'square', cx: t.cx, cy: t.cy,
    width: t.width, height: t.height, rotation: num(t.rotation) ? t.rotation : 0, features: Array.isArray(t.features) ? t.features : [],
    reservable: t.reservable !== false, premium: !!t.premium,
  })) as SampleTable[];
  if (!tables.length) return SAMPLE_FLOOR;
  const shapes = (xs: unknown[] | undefined) => (Array.isArray(xs) ? xs.filter((o): o is FloorObject => !!o && typeof (o as FloorObject).id === 'string' && num((o as FloorObject).x) && num((o as FloorObject).y)) : []);
  return { width: b.width, height: b.height, zones: shapes(b.zones), objects: shapes(b.objects), tables, live: true };
}

/**
 * The phone crop of the hero floor. The recorded sample keeps the legacy portrait crop; a live floor is cropped to its
 * tables (legacy tightView) so a small room stays readable instead of floating in empty canvas.
 */
export function narrowView(f: LandingFloor, pad = 60): string {
  if (!f.live) return '140 60 480 680';
  const xs = f.tables.map((t) => t.cx - t.width / 2), xe = f.tables.map((t) => t.cx + t.width / 2);
  const ys = f.tables.map((t) => t.cy - t.height / 2), ye = f.tables.map((t) => t.cy + t.height / 2);
  const x = Math.max(0, Math.min(...xs) - pad), y = Math.max(0, Math.min(...ys) - pad);
  const w = Math.min(f.width, Math.max(...xe) + pad) - x, h = Math.min(f.height, Math.max(...ye) + pad) - y;
  return `${Math.round(x)} ${Math.round(y)} ${Math.round(w)} ${Math.round(h)}`;
}
