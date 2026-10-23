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

/** The legacy phone crop of the hero floor: a portrait window (480 x 680) so tables stay large enough to tap. */
const PORTRAIT = 480 / 680;
/** The room's shell: what legacy's phone crop showed above and below the tables (the north wall, its window strip). */
const SHELL = new Set(['wall', 'window', 'door', 'divider']);
/** The crop grows to reach the shell only while tables keep at least 80% of the legacy size (680 / 850). */
const MAX_SHELL_CROP = 850;

/** Axis-aligned extent of a (possibly rotated) floor object. */
function extent(o: FloorObject) {
  const r = ((o.rotation || 0) * Math.PI) / 180, c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r));
  const hw = (o.width * c + o.height * s) / 2, hh = (o.width * s + o.height * c) / 2;
  return { left: o.x - hw, right: o.x + hw, top: o.y - hh, bottom: o.y + hh };
}

/**
 * The phone crop of the hero floor. The recorded sample keeps the legacy crop. A live floor gets the same portrait
 * shape and scale (at least 680 units tall), covering its tables top to bottom and starting at the first column of
 * tables, as legacy did; a narrow room is centred instead of floating in empty canvas. The crop also reaches the
 * room's shell above and below those tables (walls, the window strip, an entrance; POL-01), so the phone hero shows a
 * room and not tables on an empty canvas, unless that would shrink the tables below 80% of the legacy size.
 */
export function narrowView(f: LandingFloor, pad = 60): string {
  if (!f.live) return '140 60 480 680';
  const minX = Math.min(...f.tables.map((t) => t.cx - t.width / 2)), maxX = Math.max(...f.tables.map((t) => t.cx + t.width / 2));
  const minY = Math.min(...f.tables.map((t) => t.cy - t.height / 2)), maxY = Math.max(...f.tables.map((t) => t.cy + t.height / 2));
  let top = minY - pad, bottom = maxY + pad;
  // Shell pieces over the tables' columns (the north and south walls, the window); side walls are left out of the
  // vertical reach because they span the whole room anyway.
  const shell = f.objects.filter((o) => SHELL.has(o.type) && !o.hidden).map(extent).filter((e) => e.right > minX && e.left < maxX);
  if (shell.length) {
    const sTop = Math.min(top, ...shell.map((e) => e.top - 8)), sBottom = Math.max(bottom, ...shell.map((e) => e.bottom + 8));
    if (sBottom - sTop <= MAX_SHELL_CROP) { top = sTop; bottom = sBottom; }
  }
  // At least the legacy crop's height, so tables are drawn at the legacy size; centred on the tables and their room.
  const h = Math.min(f.height, Math.max(680, bottom - top));
  const y = Math.min(Math.max(0, (top + bottom) / 2 - h / 2), f.height - h);
  const w = Math.min(f.width, h * PORTRAIT);
  const spanW = maxX - minX + 2 * pad;
  const left = spanW <= w ? (minX + maxX) / 2 - w / 2 : minX - pad;
  const x = Math.min(Math.max(0, left), f.width - w);
  return `${Math.round(x)} ${Math.round(y)} ${Math.round(w)} ${Math.round(h)}`;
}
