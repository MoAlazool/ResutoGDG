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
/** The legacy crop of the recorded sample floor (x, top, bottom), kept as its anchor. */
const SAMPLE_CROP = { x: 140, top: 60, bottom: 740 };
/**
 * The room's shell the crop reaches above and below the tables: walls (and dividers) and the window strip. Doors are
 * left out: FloorScene draws a door's label below it, so reaching a door would bring a cut label into the edge.
 */
const SHELL = new Set(['wall', 'window', 'divider']);
/** The crop grows to reach the shell only while tables keep at least 80% of the legacy size (680 / 850). */
const MAX_SHELL_CROP = 850;
/** Where FloorScene draws a door's or entrance's label: baseline 28 units below the door, .structure-label 22 units. */
const DOOR_LABEL = { baseline: 28, size: 22, halfWidth: 70 };

/** Axis-aligned extent of a (possibly rotated) floor object. */
function extent(o: FloorObject) {
  const r = ((o.rotation || 0) * Math.PI) / 180, c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r));
  const hw = (o.width * c + o.height * s) / 2, hh = (o.width * s + o.height * c) / 2;
  return { left: o.x - hw, right: o.x + hw, top: o.y - hh, bottom: o.y + hh };
}

/**
 * The phone crop of the hero floor. A live floor gets the legacy portrait shape and scale (at least 680 units tall),
 * covering its tables top to bottom and starting at the first column of tables, as legacy did; a narrow room is
 * centred instead of floating in empty canvas. The recorded sample keeps legacy's own crop (140 60 480 680) as its
 * anchor. Either way the crop then reaches the room's shell above and below the tables (walls and the window strip;
 * POL-01), so the phone hero shows a room and not tables on an empty canvas, unless that would shrink the tables below
 * 80% of the legacy size, and its bottom edge never cuts through a door's label (stray glyph fragments).
 */
export function narrowView(f: LandingFloor, pad = 60): string {
  const minX = Math.min(...f.tables.map((t) => t.cx - t.width / 2)), maxX = Math.max(...f.tables.map((t) => t.cx + t.width / 2));
  const minY = Math.min(...f.tables.map((t) => t.cy - t.height / 2)), maxY = Math.max(...f.tables.map((t) => t.cy + t.height / 2));
  let top = f.live ? minY - pad : SAMPLE_CROP.top, bottom = f.live ? maxY + pad : SAMPLE_CROP.bottom;
  // Shell pieces over the tables' columns (the north and south walls, the window); side walls are left out of the
  // vertical reach because they span the whole room anyway.
  const shell = f.objects.filter((o) => SHELL.has(o.type) && !o.hidden).map(extent).filter((e) => e.right > minX && e.left < maxX);
  if (shell.length) {
    const sTop = Math.min(top, ...shell.map((e) => e.top - 8)), sBottom = Math.max(bottom, ...shell.map((e) => e.bottom + 8));
    if (sBottom - sTop <= MAX_SHELL_CROP) { top = sTop; bottom = sBottom; }
  }
  // At least the legacy crop's height, so tables are drawn at the legacy size; centred on the tables and their room.
  let h = Math.min(f.height, Math.max(680, bottom - top));
  const y = Math.min(Math.max(0, (top + bottom) / 2 - h / 2), f.height - h);
  const spanW = maxX - minX + 2 * pad;
  const place = (w: number) => Math.min(Math.max(0, !f.live ? SAMPLE_CROP.x : spanW <= w ? (minX + maxX) / 2 - w / 2 : minX - pad), f.width - w);
  let w = Math.min(f.width, h * PORTRAIT), x = place(w);
  // A door's label hangs below the door; if the bottom edge would cut through one, end the crop just above it, as
  // long as that keeps the tables and every shell piece in the crop whole.
  const whole = Math.max(maxY, ...shell.filter((e) => e.bottom <= y + h).map((e) => e.bottom));
  for (const o of f.objects) {
    if ((o.type !== 'door' && o.type !== 'entrance') || o.hidden || (o.rotation || 0) % 360 !== 0) continue;
    if (o.x + DOOR_LABEL.halfWidth <= x || o.x - DOOR_LABEL.halfWidth >= x + w) continue;
    const labelTop = o.y + DOOR_LABEL.baseline - DOOR_LABEL.size, labelBottom = o.y + DOOR_LABEL.baseline + DOOR_LABEL.size / 3;
    if (labelTop < y + h && y + h < labelBottom && labelTop - 1 >= whole) h = labelTop - 1 - y;
  }
  if (h * PORTRAIT < w) { w = Math.min(f.width, h * PORTRAIT); x = place(w); }
  return `${Math.round(x)} ${Math.round(y)} ${Math.round(w)} ${Math.round(h)}`;
}
