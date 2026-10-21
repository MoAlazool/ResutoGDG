// The demo restaurant's room architecture (gallery PAR-01): legacy drew every Olive Room floor inside its walls, with
// the window strip on the north wall, the brown service-bar counter and the framed entrance
// (tools/legacy-migration/fixtures/olive-room.legacy-state.json → state.floor.objects). The first loaders only seeded
// the north wall and the door, so the landing hero, the overview live floor and the floor page showed tables on a bare
// canvas. These objects are drawn by the shared renderer (apps/web/components/floor/FloorScene.tsx), which already
// handles every legacy kind; only the data was missing.
//
// Geometry follows the demo layout (1200 x 800; zones 100..1100 wide; north wall y=40 and the entrance at y=760 already
// stored), so walls frame both rooms the way legacy framed its room. Labels are the standard ones the web app
// translates (studio.floor.label.*), so Arabic pages show Arabic captions.
//
// Pure: no database or network. The loader adds the missing objects through the floor API (PUT /floor/:branch).

const wall = (id, label, x, y, width, height) => ({ id, type: 'wall', label, x, y, width, height, rotation: 0 });

/** Shared envelope: the walls and the entrance every demo branch sits inside. */
const ENVELOPE = [
  wall('wall-top', 'North wall', 600, 40, 1100, 10),
  wall('wall-left', 'West wall', 50, 400, 10, 730),
  wall('wall-right', 'East wall', 1150, 400, 10, 730),
  wall('wall-bottom', 'South wall', 600, 760, 1110, 10),
  { id: 'door', type: 'door', label: 'Entrance', x: 120, y: 760, width: 90, height: 20, rotation: 0 },
];

export const FLOOR_ARCHITECTURE = {
  // The Zamalek dining room: windows on the north wall and the service bar along the east side of the main room.
  main: [
    ...ENVELOPE,
    { id: 'window-north', type: 'window', label: 'Windows', x: 600, y: 40, width: 440, height: 12, rotation: 0 },
    { id: 'counter-bar', type: 'counter', label: 'Service & bar', x: 1060, y: 220, width: 50, height: 240, rotation: 0 },
  ],
  // Smash & Co: a street-front window and the pickup counter between the seats and the entrance.
  burger: [
    ...ENVELOPE,
    { id: 'window-north', type: 'window', label: 'Windows', x: 600, y: 40, width: 600, height: 12, rotation: 0 },
    { id: 'counter-pickup', type: 'counter', label: 'Counter', x: 600, y: 620, width: 520, height: 50, rotation: 0 },
  ],
};

/**
 * The stored objects plus any architecture object that is missing (matched by id). Objects already on the floor are
 * kept exactly as stored, so a demo user's edits (a moved wall, a renamed bar) survive every refresh; a removed
 * fixture comes back only if its id is gone. Returns { objects, added } with added = ids appended (empty: no change).
 */
export function withArchitecture(objects, branchCode) {
  const want = FLOOR_ARCHITECTURE[branchCode] ?? [];
  const have = new Set((objects ?? []).map((o) => o?.id));
  const missing = want.filter((o) => !have.has(o.id));
  return { objects: [...(objects ?? []), ...missing.map((o) => ({ ...o }))], added: missing.map((o) => o.id) };
}

const table = (label, cx, cy, zone, extra = {}) => ({ label, capacity: 4, zone, shape: 'square', cx, cy, width: 100, height: 100, rotation: 0,
  features: [], reservable: true, minSpendMinor: 0, premium: false, internalNotes: '', ...extra });

/** The demo floors as first loaded: tables and zones per branch code (the architecture above frames them). */
export const DEMO_FLOORS = {
  main: {
    tables: [
      table('T1', 250, 220, 'Main room', { shape: 'round', capacity: 2, width: 90, height: 90 }), table('T2', 500, 220, 'Main room'), table('T3', 750, 220, 'Main room'),
      table('T4', 250, 560, 'Terrace', { shape: 'round', capacity: 6, width: 120, height: 120, features: ['Outdoor'] }), table('T5', 500, 560, 'Terrace', { features: ['Outdoor'] }),
      table('T6', 750, 560, 'Terrace', { shape: 'rect', capacity: 8, width: 180, height: 90, features: ['Outdoor'], premium: true }),
    ],
    zones: [
      { id: 'zone-main', type: 'zone', label: 'Main room', x: 600, y: 220, width: 1000, height: 300, rotation: 0, color: '#e9efe5' },
      { id: 'zone-terrace', type: 'zone', label: 'Terrace', x: 600, y: 560, width: 1000, height: 300, rotation: 0, color: '#f3ead8' },
    ],
  },
  burger: {
    tables: [table('S1', 300, 300, 'Counter'), table('S2', 600, 300, 'Counter'), table('S3', 900, 300, 'Counter')],
    zones: [{ id: 'zone-counter', type: 'zone', label: 'Counter', x: 600, y: 300, width: 1000, height: 400, rotation: 0, color: '#f0e6e0' }],
  },
};

/** Axis-aligned bounds of a floor object or table ({x,y} or {cx,cy} centre, unrotated). */
export function boxOf(o) {
  const x = o.cx ?? o.x, y = o.cy ?? o.y;
  return { left: x - o.width / 2, right: x + o.width / 2, top: y - o.height / 2, bottom: y + o.height / 2 };
}
