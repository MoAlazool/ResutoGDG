// In-browser fixture implementing the floor API contract (MODULE_CONTRACTS.md §8,
// producer Agent B1) for Floor Studio specs when B1's floor module is not present
// in this worktree. It is a test double for the *HTTP contract only* — it never
// pretends to be the real service, and specs that use it say so in their titles.
import type { Page, Route } from '@playwright/test';

export interface MockTable {
  id: string; label: string; capacity: number; zone: string | null; shape: string; cx: number; cy: number; width: number; height: number;
  rotation: number; features: string[]; reservable: boolean; minSpendMinor: number | null; premium: boolean; internalNotes: string | null;
  status: string; version: number;
}

export interface FloorMockState {
  revision: number;
  width: number;
  height: number;
  background: Record<string, unknown>;
  zones: any[];
  objects: any[];
  tables: MockTable[];
  puts: Array<{ baseRevision: number; key: string; tables: number }>;
  visits: Map<string, { id: string; partySize: number; openedAt: string }>;
}

export function seedFloor(): FloorMockState {
  const table = (n: number, cx: number, cy: number, shape = 'square', capacity = 4): MockTable => ({
    id: `00000000-0000-4000-8000-00000000000${n}`, label: `T${n}`, capacity, zone: 'Main Room', shape, cx, cy, width: 100, height: 100, rotation: 0,
    features: [], reservable: true, minSpendMinor: null, premium: false, internalNotes: null, status: 'available', version: 1,
  });
  return {
    revision: 4, width: 1200, height: 800,
    background: { image: null, opacity: 0.4, locked: true, x: 0, y: 0, width: 1200, height: 800 },
    zones: [{ id: 'z-main', type: 'zone', label: 'Main Room', x: 600, y: 300, width: 1080, height: 470, rotation: 0, color: '#e9e6dc' }],
    objects: [
      { id: 'o-wall', type: 'wall', label: 'North wall', x: 600, y: 46, width: 1120, height: 16, rotation: 0 },
      { id: 'o-door', type: 'door', label: 'Entrance', x: 110, y: 742, width: 110, height: 35, rotation: 0 },
    ],
    tables: [table(1, 250, 220, 'round', 2), table(2, 520, 220), table(3, 790, 220)],
    puts: [],
    visits: new Map(),
  };
}

const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', headers: cors(), body: JSON.stringify(body) });

/** Routes `/v1/o/:orgId/floor/**`, visits and table cleaning for one org to the in-memory state. */
export async function mockFloorApi(page: Page, apiUrl: string, orgId: string, state: FloorMockState) {
  const layout = (branchId: string) => ({ branchId, revision: state.revision, schemaVersion: 2, width: state.width, height: state.height,
    background: state.background, zones: state.zones, objects: state.objects, tables: state.tables });
  await page.route(new RegExp(`^${escape(apiUrl)}/v1/o/${orgId}/(floor|visits|tables)(/.*)?$`), async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace(`/v1/o/${orgId}/`, '');
    const parts = path.split('/');
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors() });
    if (parts[0] === 'floor' && parts.length === 2 && req.method() === 'GET') return json(route, 200, layout(parts[1]!));
    if (parts[0] === 'floor' && parts.length === 2 && req.method() === 'PUT') {
      const body = req.postDataJSON();
      if (body.baseRevision !== state.revision) return json(route, 409, { error: { code: 'stale_layout', message: 'The floor was changed by someone else', details: { currentRevision: state.revision } } });
      state.puts.push({ baseRevision: body.baseRevision, key: body.key, tables: body.layout.tables.length });
      state.revision += 1;
      state.background = body.layout.background;
      state.zones = body.layout.zones;
      state.objects = body.layout.objects;
      state.tables = body.layout.tables.map((t: any, i: number) => ({ ...t, id: t.id ?? `10000000-0000-4000-8000-${String(state.revision * 100 + i).padStart(12, '0')}`, status: 'available', version: 1 }));
      return json(route, 200, layout(parts[1]!));
    }
    if (parts[0] === 'floor' && parts[2] === 'live') {
      return json(route, 200, {
        revision: state.revision,
        tables: state.tables.map((t) => {
          const v = state.visits.get(t.id);
          return { ...t, status: v ? 'occupied' : t.status, visit: v ? { ...v, orderCount: 0, dueMinor: 0, paidMinor: 0, requests: [] } : null, nextReservation: null };
        }),
      });
    }
    if (parts[0] === 'floor' && parts[2] === 'qr') {
      return json(route, 200, { items: state.tables.map((t) => ({ tableId: t.id, label: t.label, url: `http://app.test/t/qr-${t.label}`, svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#000"/></svg>' })) });
    }
    if (parts[0] === 'visits' && parts.length === 1 && req.method() === 'POST') {
      const body = req.postDataJSON();
      const id = `20000000-0000-4000-8000-${String(state.visits.size + 1).padStart(12, '0')}`;
      state.visits.set(body.tableId, { id, partySize: body.partySize ?? 2, openedAt: new Date().toISOString() });
      return json(route, 201, { id, tableId: body.tableId });
    }
    if (parts[0] === 'visits' && parts[2] === 'close') {
      for (const [tableId, v] of state.visits) if (v.id === parts[1]) { state.visits.delete(tableId); const t = state.tables.find((x) => x.id === tableId); if (t) t.status = 'cleaning'; }
      return json(route, 200, { closed: true });
    }
    if (parts[0] === 'tables' && parts[2] === 'clean') {
      const t = state.tables.find((x) => x.id === parts[1]);
      if (t) t.status = 'available';
      return json(route, 200, { ok: true });
    }
    return json(route, 404, { error: { code: 'not_found', message: 'Not found' } });
  });
}

/** Simulates another manager saving the floor (bumps the revision). */
export function concurrentSave(state: FloorMockState) {
  state.revision += 1;
  state.tables = state.tables.map((t) => (t.label === 'T3' ? { ...t, cx: t.cx + 40 } : t));
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const cors = () => ({ 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE' });
