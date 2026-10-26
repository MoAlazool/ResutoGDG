// Pure floor-plan model and geometry, ported from legacy/public/floor-shared.js,
// floor-model.js and floor-editor.js. No DOM or React here so it can be unit
// tested and reused by the editor, the live floor, previews and the landing demos.
// Shapes follow the floor API contract (MODULE_CONTRACTS.md §8, producer B1).

export const LAYOUT_WIDTH = 1200;
export const LAYOUT_HEIGHT = 800;

export type TableShape = 'square' | 'round' | 'rect' | 'booth' | 'bar';
export type ObjectType =
  | 'zone' | 'wall' | 'divider' | 'door' | 'entrance' | 'window' | 'counter' | 'bar' | 'kitchen' | 'text' | 'chair' | 'plant' | string;

export interface FloorObject {
  id: string;
  type: ObjectType;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  color?: string;
  material?: 'stone' | 'wood' | 'garden';
  locked?: boolean;
  hidden?: boolean;
}

export interface FloorTable {
  id: string;
  label: string;
  capacity: number;
  zone: string | null;
  shape: TableShape;
  cx: number;
  cy: number;
  width: number;
  height: number;
  rotation: number;
  features: string[];
  reservable: boolean;
  minSpendMinor: number | null;
  premium: boolean;
  internalNotes: string | null;
  status?: string;
  version?: number;
  /** Editor-only lock (not part of the API contract). */
  locked?: boolean;
}

export interface FloorBackground {
  image: string | null;
  opacity: number;
  locked: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FloorLayout {
  branchId?: string;
  revision: number;
  schemaVersion?: 2;
  width: number;
  height: number;
  background: FloorBackground;
  zones: FloorObject[];
  objects: FloorObject[];
  tables: FloorTable[];
}

export type FloorItem = FloorTable | FloorObject;
export const isTable = (o: FloorItem): o is FloorTable => (o as FloorTable).capacity !== undefined;
export const getX = (o: FloorItem) => (isTable(o) ? o.cx : o.x);
export const getY = (o: FloorItem) => (isTable(o) ? o.cy : o.y);
export function put(o: FloorItem, x: number, y: number) {
  if (isTable(o)) { o.cx = x; o.cy = y; } else { o.x = x; o.y = y; }
}

export const TABLE_FEATURES = [
  'Smoking', 'Non-smoking', 'Window side', 'Quiet area', 'Terrace', 'Near entrance', 'Far from entrance', 'Center', 'Outdoor', 'Booth',
  'Accessible', 'High chair compatible', 'Near bar',
] as const;

export const BACKGROUND_MAX_BYTES = 700_000;
export const BACKGROUND_TYPES = ['image/png', 'image/jpeg'];

export const emptyBackground = (): FloorBackground => ({ image: null, opacity: 0.4, locked: true, x: 0, y: 0, width: LAYOUT_WIDTH, height: LAYOUT_HEIGHT });

/** Normalises any API/legacy layout into a complete editable document. */
export function normalizeLayout(raw: Partial<FloorLayout> & Record<string, any>): FloorLayout {
  const bg = { ...emptyBackground(), ...(raw.background ?? {}) };
  return {
    branchId: raw.branchId,
    revision: Number(raw.revision ?? 0),
    schemaVersion: 2,
    width: Number(raw.width ?? LAYOUT_WIDTH),
    height: Number(raw.height ?? LAYOUT_HEIGHT),
    background: bg,
    zones: (raw.zones ?? []).map((z: any) => ({ ...z, type: 'zone', x: Number(z.x), y: Number(z.y), width: Number(z.width), height: Number(z.height), rotation: Number(z.rotation ?? 0) })),
    objects: (raw.objects ?? []).map((o: any) => ({ ...o, x: Number(o.x), y: Number(o.y), width: Number(o.width), height: Number(o.height), rotation: Number(o.rotation ?? 0) })),
    tables: (raw.tables ?? []).map((t: any) => ({
      ...t,
      shape: t.shape === 'rectangle' ? 'rect' : t.shape ?? 'square',
      zone: t.zone ?? null,
      cx: Number(t.cx), cy: Number(t.cy), width: Number(t.width), height: Number(t.height), rotation: Number(t.rotation ?? 0),
      capacity: Number(t.capacity),
      features: Array.isArray(t.features) ? t.features : [],
      reservable: t.reservable !== false,
      minSpendMinor: t.minSpendMinor ?? (t.minimumSpend ? Number(t.minimumSpend) : null),
      premium: !!t.premium,
      internalNotes: t.internalNotes ?? null,
    })),
  };
}

// --- Geometry -----------------------------------------------------------------
export interface Bounds { left: number; right: number; top: number; bottom: number }

/** Axis-aligned bounds of a rotated rectangle centred on (x, y). */
export function bounds(o: FloorItem): Bounds {
  const x = getX(o), y = getY(o), r = ((o.rotation || 0) * Math.PI) / 180;
  const w = Math.abs(Math.cos(r)) * o.width + Math.abs(Math.sin(r)) * o.height;
  const h = Math.abs(Math.sin(r)) * o.width + Math.abs(Math.cos(r)) * o.height;
  return { left: x - w / 2, right: x + w / 2, top: y - h / 2, bottom: y + h / 2 };
}

export type GeometryErrorCode = 'invalid_dimensions' | 'outside_canvas';
/** Legacy geometry validation: finite numbers, minimum size 4, rotation 0–359, fully inside the canvas. */
export function geometryError(o: FloorItem, f: { width: number; height: number } = { width: LAYOUT_WIDTH, height: LAYOUT_HEIGHT }): GeometryErrorCode | null {
  const values = [getX(o), getY(o), o.width, o.height, o.rotation];
  if (!values.every(Number.isFinite) || o.width < 4 || o.height < 4 || o.rotation < 0 || o.rotation >= 360) return 'invalid_dimensions';
  const b = bounds(o);
  // A small epsilon absorbs floating-point noise from rotated bounds.
  const e = 1e-6;
  if (b.left < -e || b.top < -e || b.right > f.width + e || b.bottom > f.height + e) return 'outside_canvas';
  return null;
}

/** Pairs of overlapping furniture (tables and counters), as label pairs. */
export function overlaps(f: Pick<FloorLayout, 'tables' | 'objects'>): string[] {
  const items: FloorItem[] = [...f.tables, ...f.objects.filter((o) => o.type === 'counter')];
  const pairs: string[] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = bounds(items[i]!), b = bounds(items[j]!);
      if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) pairs.push(`${items[i]!.label} / ${items[j]!.label}`);
    }
  }
  return pairs;
}

export interface LayoutError { id: string | null; label: string; code: GeometryErrorCode | 'background_outside' | 'invalid_capacity' | 'empty_label' | 'duplicate_label' }

/** Every blocking validation error in a draft (save is disabled while any exist). */
export function layoutErrors(f: FloorLayout): LayoutError[] {
  const errs: LayoutError[] = [];
  for (const o of allItems(f)) {
    const code = geometryError(o, f);
    if (code) errs.push({ id: o.id, label: o.label, code });
    if (!String(o.label ?? '').trim()) errs.push({ id: o.id, label: o.label, code: 'empty_label' });
  }
  const seen = new Map<string, string>();
  for (const t of f.tables) {
    if (!Number.isInteger(t.capacity) || t.capacity < 1 || t.capacity > 50) errs.push({ id: t.id, label: t.label, code: 'invalid_capacity' });
    const key = t.label.trim().toLowerCase();
    if (key && seen.has(key)) errs.push({ id: t.id, label: t.label, code: 'duplicate_label' });
    seen.set(key, t.id);
  }
  const bg = f.background;
  if (![bg.x, bg.y, bg.width, bg.height].every(Number.isFinite) || bg.x < 0 || bg.y < 0 || bg.width <= 0 || bg.height <= 0
    || bg.x + bg.width > f.width || bg.y + bg.height > f.height) errs.push({ id: null, label: 'Background', code: 'background_outside' });
  return errs;
}

export const allItems = (f: Pick<FloorLayout, 'tables' | 'objects' | 'zones'>): FloorItem[] => [...f.tables, ...f.objects, ...f.zones];
export const normalizeRotation = (a: number) => ((Math.round(a) % 360) + 360) % 360;
export const quantize = (n: number, snap: boolean, step = 10) => (snap ? Math.round(n / step) * step : Math.round(n));

// --- Arrangement ------------------------------------------------------------------
export type ArrangeAction = 'align-left' | 'align-center' | 'align-right' | 'align-top' | 'align-middle' | 'align-bottom' | 'space-x' | 'space-y';

/**
 * Aligns (≥2 objects) or distributes with equal gaps (≥3 objects) in place —
 * the legacy maths: alignment uses rotated bounds; distribution keeps the two
 * outermost objects fixed and spreads the free space evenly.
 * Returns false when there are too few objects.
 */
export function arrange(objs: FloorItem[], action: ArrangeAction): boolean {
  if (objs.length < 2) return false;
  const spacing = action === 'space-x' || action === 'space-y';
  if (spacing && objs.length < 3) return false;
  const bs = objs.map(bounds);
  const left = Math.min(...bs.map((b) => b.left)), right = Math.max(...bs.map((b) => b.right));
  const top = Math.min(...bs.map((b) => b.top)), bottom = Math.max(...bs.map((b) => b.bottom));
  if (spacing) {
    const horizontal = action === 'space-x';
    const sorted = [...objs].sort((a, b) => (horizontal ? bounds(a).left - bounds(b).left : bounds(a).top - bounds(b).top));
    const sizes = sorted.map((o) => { const b = bounds(o); return horizontal ? b.right - b.left : b.bottom - b.top; });
    const gap = ((horizontal ? right - left : bottom - top) - sizes.reduce((a, b) => a + b, 0)) / (objs.length - 1);
    let cursor = horizontal ? left : top;
    sorted.forEach((o, i) => {
      const size = sizes[i]!;
      put(o, horizontal ? cursor + size / 2 : getX(o), horizontal ? getY(o) : cursor + size / 2);
      cursor += size + gap;
    });
    return true;
  }
  for (const o of objs) {
    const b = bounds(o);
    let x = getX(o), y = getY(o);
    if (action === 'align-left') x += left - b.left;
    if (action === 'align-right') x += right - b.right;
    if (action === 'align-center') x = (left + right) / 2;
    if (action === 'align-top') y += top - b.top;
    if (action === 'align-bottom') y += bottom - b.bottom;
    if (action === 'align-middle') y = (top + bottom) / 2;
    put(o, Math.round(x), Math.round(y));
  }
  return true;
}

/** Labels unlocked tables T1…Tn in reading order (top to bottom, then left to right), skipping labels of locked tables. */
export function autoNumber(tables: FloorTable[]) {
  const used = new Set(tables.filter((t) => t.locked).map((t) => t.label));
  let n = 1;
  [...tables].filter((t) => !t.locked).sort((a, b) => a.cy - b.cy || a.cx - b.cx).forEach((t) => {
    while (used.has(`T${n}`)) n++;
    t.label = `T${n++}`;
  });
}

/** Resize from a pointer in layout space: the far corner follows the pointer in the object's rotated frame. */
export function resizeFromPointer(o: FloorItem, origin: FloorItem, p: { x: number; y: number }, snap: boolean) {
  const angle = (-origin.rotation * Math.PI) / 180;
  const dx = p.x - getX(origin), dy = p.y - getY(origin);
  const lx = dx * Math.cos(angle) - dy * Math.sin(angle);
  const ly = dx * Math.sin(angle) + dy * Math.cos(angle);
  const min = isTable(o) ? 40 : 4;
  o.width = Math.max(min, quantize(Math.abs(lx) * 2, snap));
  o.height = Math.max(min, quantize(Math.abs(ly) * 2, snap));
  if (isTable(o) && keepsSquare(o)) o.height = o.width;
}

/** Rotation that points the rotate handle at the pointer, snapped to 15° when snapping. */
export function rotationFromPointer(o: FloorItem, p: { x: number; y: number }, snap: boolean) {
  const a = (Math.atan2(p.y - getY(o), p.x - getX(o)) * 180) / Math.PI + 90;
  return normalizeRotation(snap ? Math.round(a / 15) * 15 : a);
}

/** Round and square tables keep equal sides; rectangles, booths and bars do not. */
export const keepsSquare = (t: FloorTable) => t.shape === 'round' || t.shape === 'square';

// --- Chairs (legacy tableChairs placement) ------------------------------------------
export interface ChairPos { x: number; y: number; rotation: number }
export function chairPositions(t: Pick<FloorTable, 'capacity' | 'width' | 'height' | 'shape'>): ChairPos[] {
  const count = Math.min(20, Math.max(1, t.capacity)), w = t.width, h = t.height;
  if (t.shape === 'round') {
    return Array.from({ length: count }, (_, i) => {
      const a = (360 * i) / count - 90, r = (a * Math.PI) / 180;
      return { x: Math.cos(r) * (w / 2 + 21), y: Math.sin(r) * (h / 2 + 21), rotation: a + 90 };
    });
  }
  const horizontal = Math.max(1, Math.round((count * w) / (2 * (w + h))));
  const vertical = Math.max(1, Math.floor((count - 2 * horizontal) / 2));
  const seats: ChairPos[] = [];
  const push = (n: number, side: 'top' | 'bottom' | 'left' | 'right') => {
    for (let i = 0; i < n; i++) {
      const q = (i + 1) / (n + 1);
      if (side === 'top') seats.push({ x: -w / 2 + q * w, y: -h / 2 - 21, rotation: 0 });
      if (side === 'bottom') seats.push({ x: -w / 2 + q * w, y: h / 2 + 21, rotation: 180 });
      if (side === 'left') seats.push({ x: -w / 2 - 21, y: -h / 2 + q * h, rotation: 90 });
      if (side === 'right') seats.push({ x: w / 2 + 21, y: -h / 2 + q * h, rotation: -90 });
    }
  };
  push(horizontal, 'top'); push(horizontal, 'bottom'); push(vertical, 'left'); push(vertical, 'right');
  while (seats.length < count) seats.push({ x: seats.length % 2 ? -w / 2 - 21 : w / 2 + 21, y: 0, rotation: seats.length % 2 ? 90 : -90 });
  return seats.slice(0, count);
}

/** A viewBox cropped to the furniture (landing previews and small maps). */
export function tightView(f: Pick<FloorLayout, 'tables' | 'objects' | 'zones' | 'width' | 'height'>, pad = 60) {
  const items = allItems(f);
  if (!items.length) return `0 0 ${f.width} ${f.height}`;
  const bs = items.map(bounds);
  const x = Math.max(0, Math.min(...bs.map((b) => b.left)) - pad), y = Math.max(0, Math.min(...bs.map((b) => b.top)) - pad);
  const w = Math.min(f.width, Math.max(...bs.map((b) => b.right)) + pad) - x;
  const h = Math.min(f.height, Math.max(...bs.map((b) => b.bottom)) + pad) - y;
  return `${x} ${y} ${w} ${h}`;
}

// --- Templates ------------------------------------------------------------------------
let seq = 0;
export const draftId = () => `new-${typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${++seq}`}`;
export const isDraftId = (id: string) => id.startsWith('new-');

/** The legacy 12-table example (always a draft: table ids/QR tokens are issued by the server on save). */
/** Zone colours a new zone starts with (stored in the layout, so plain values rather than CSS tokens). */
export const ZONE_COLOR_DEFAULT = '#e7efdc';
export const ZONE_COLOR_GARDEN = '#e0e9d7';

export function demoFloor(revision = 0): FloorLayout {
  const zone = (id: string, label: string, y: number, height: number, color: string): FloorObject => ({ id, type: 'zone', label, x: 600, y, width: 1080, height, rotation: 0, color });
  const slot = (i: number) => (i === 3 ? 11 : i === 11 ? 3 : i === 5 ? 2 : i === 2 ? 5 : i === 8 ? 10 : i === 10 ? 8 : i);
  return {
    revision, schemaVersion: 2, width: LAYOUT_WIDTH, height: LAYOUT_HEIGHT, background: emptyBackground(),
    zones: [zone('demo-main', 'Main Room', 280, 450, '#e9e6dc'), zone('demo-terrace', 'Terrace', 625, 220, ZONE_COLOR_GARDEN)],
    objects: [
      { id: 'demo-wall', type: 'wall', label: 'North wall', x: 600, y: 40, width: 1120, height: 16, rotation: 0 },
      { id: 'demo-window', type: 'window', label: 'Window side', x: 800, y: 52, width: 550, height: 12, rotation: 0 },
      { id: 'demo-entry', type: 'door', label: 'Entrance', x: 110, y: 740, width: 110, height: 35, rotation: 0 },
      { id: 'demo-bar', type: 'counter', label: 'Bar', x: 1090, y: 300, width: 70, height: 250, rotation: 0 },
      ...[180, 600, 1020].map((x, i) => ({ id: `demo-plant-${i}`, type: 'plant', label: 'Plant', x, y: 495, width: 42, height: 42, rotation: 0 })),
    ],
    tables: Array.from({ length: 12 }, (_, i): FloorTable => ({
      id: draftId(), label: `T${i + 1}`, capacity: i === 3 ? 6 : 4, shape: i % 3 === 0 ? 'round' : 'square',
      cx: 230 + (slot(i) % 4) * 230, cy: 160 + Math.floor(slot(i) / 4) * 220, width: 100, height: 100, rotation: 0,
      zone: i === 3 || (i >= 8 && i !== 11) ? 'Terrace' : 'Main Room', reservable: true, minSpendMinor: null, premium: i === 5,
      internalNotes: null,
      features: i === 5 ? ['Non-smoking', 'Window side'] : i === 8 ? ['Smoking', 'Quiet area', 'Far from entrance', 'Terrace']
        : (i >= 8 && i !== 11) || i === 3 ? ['Smoking', 'Terrace'] : ['Non-smoking', 'Center'],
    })),
  };
}

export type AddKind = 'round' | 'square' | 'rect' | 'booth' | 'wall' | 'door' | 'window' | 'counter' | 'text' | 'chair' | 'plant' | 'divider' | 'entrance' | 'kitchen' | 'bar' | 'zone' | 'terrace' | 'outdoor';

/** Creates a new object of a palette kind with the legacy default sizes. */
export function createItem(f: FloorLayout, kind: AddKind, label: (k: string) => string = (k) => k): { item: FloorItem; list: 'tables' | 'objects' | 'zones' } {
  const offset = (allItems(f).length % 7) * 20;
  const x = 520 + offset, y = 360;
  if (kind === 'round' || kind === 'square' || kind === 'rect' || kind === 'booth') {
    const used = new Set(f.tables.map((t) => t.label));
    let n = f.tables.length + 1;
    while (used.has(`T${n}`)) n++;
    const wide = kind === 'rect' || kind === 'booth';
    return {
      list: 'tables',
      item: { id: draftId(), label: `T${n}`, capacity: wide ? 6 : 4, zone: f.zones[0]?.label ?? null, shape: kind, cx: x, cy: y,
        width: wide ? 180 : 110, height: 110, rotation: 0, features: [], reservable: true, minSpendMinor: null, premium: false, internalNotes: null },
    };
  }
  const preset = kind === 'terrace' || kind === 'outdoor' ? kind : null;
  const type = preset ? 'zone' : kind;
  const o: FloorObject = { id: draftId(), type, label: label(kind[0]!.toUpperCase() + kind.slice(1)), x, y, width: 120, height: 70, rotation: 0 };
  if (type === 'wall' || type === 'divider') { o.width = 240; o.height = 10; }
  if (type === 'window') { o.width = 160; o.height = 12; }
  if (type === 'door' || type === 'entrance') { o.width = 90; o.height = 30; }
  if (type === 'text') { o.width = 200; o.height = 40; o.label = label('New label'); }
  if (type === 'chair') { o.width = 34; o.height = 34; }
  if (type === 'plant') { o.width = 42; o.height = 42; }
  if (type === 'zone') {
    o.width = 360; o.height = 230;
    o.label = label(preset === 'terrace' ? 'Terrace' : preset === 'outdoor' ? 'Outdoor' : 'New zone');
    o.color = preset ? ZONE_COLOR_GARDEN : ZONE_COLOR_DEFAULT;
    o.material = preset ? 'garden' : 'stone';
    return { item: o, list: 'zones' };
  }
  return { item: o, list: 'objects' };
}

/** Copies of the given objects offset by 30 units, with fresh draft ids and " copy" labels. */
export function duplicateItems(items: FloorItem[], copySuffix = ' copy'): FloorItem[] {
  return items.map((o) => {
    const c = structuredClone(o) as FloorItem;
    c.id = draftId();
    c.label = `${c.label}${copySuffix}`.slice(0, isTable(c) ? 20 : 80);
    put(c, getX(c) + 30, getY(c) + 30);
    if (isTable(c)) { delete c.status; delete c.version; }
    return c;
  });
}

/** Body for PUT /floor/:branchId — new tables have no id; operational status/version are never sent. */
export function toSaveBody(draft: FloorLayout, key: string) {
  return {
    baseRevision: draft.revision,
    key,
    layout: {
      width: draft.width,
      height: draft.height,
      background: draft.background,
      zones: draft.zones,
      objects: draft.objects,
      tables: draft.tables.map(({ status: _s, version: _v, locked: _l, ...t }) => (isDraftId(t.id) ? { ...t, id: undefined } : t)),
    },
  };
}

/** Structural equality used for "dirty" detection. */
export const sameLayout = (a: FloorLayout, b: FloorLayout) => canonical(strip(a)) === canonical(strip(b));
const strip = (f: FloorLayout) => ({ ...f, branchId: undefined, schemaVersion: undefined });
/** Key-order independent JSON (undefined fields dropped). */
function canonical(v: unknown): string {
  const walk = (x: unknown): unknown =>
    Array.isArray(x) ? x.map(walk)
      : x && typeof x === 'object'
        ? Object.fromEntries(Object.keys(x as object).sort().filter((k) => (x as any)[k] !== undefined).map((k) => [k, walk((x as any)[k])]))
        : x;
  return JSON.stringify(walk(v));
}
