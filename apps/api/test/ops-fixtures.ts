// Shared fixtures for the restaurant-operations tests (Agent B1).
import { auth, type TestApp, type TestTenant } from './helpers';

export const table = (label: string, cx: number, cy: number, extra: Record<string, unknown> = {}) => ({
  label, capacity: 4, zone: 'Main room', shape: 'square', cx, cy, width: 100, height: 100, rotation: 0,
  features: ['Non-smoking', 'Center'], reservable: true, minSpendMinor: 0, premium: false, internalNotes: '', ...extra,
});

export const layout = (tables: unknown[]) => ({
  width: 1200, height: 800,
  background: { image: null, opacity: 0.4, locked: true, x: 0, y: 0, width: 1200, height: 800 },
  zones: [{ id: 'zone-main', type: 'zone', label: 'Main room', x: 600, y: 300, width: 1000, height: 450, rotation: 0, color: '#e9efe5' }],
  objects: [{ id: 'wall-top', type: 'wall', label: 'North wall', x: 600, y: 40, width: 1100, height: 10, rotation: 0 }],
  tables,
});

let keyN = 0;
export const key = (p = 'k') => `${p}-${Date.now().toString(36)}-${++keyN}-${Math.random().toString(36).slice(2, 8)}`;

/** Saves a floor through the API and returns the layout. */
export async function saveFloor(t: TestApp, tenant: TestTenant, tables: unknown[], baseRevision?: number) {
  const current = baseRevision ?? (await t.http.get(`/v1/o/${tenant.orgId}/floor/${tenant.branchId}`).set(auth(tenant.owner))).body.revision;
  const res = await t.http.put(`/v1/o/${tenant.orgId}/floor/${tenant.branchId}`).set(auth(tenant.owner))
    .send({ baseRevision: current, key: key('floor'), layout: layout(tables) });
  if (res.status !== 200) throw new Error(`floor save failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

/** Reads a table's QR token through the print sheet (the only place it is exposed). */
export async function qrTokenFor(t: TestApp, tenant: TestTenant, tableId: string) {
  const sheet = await t.http.get(`/v1/o/${tenant.orgId}/floor/${tenant.branchId}/qr`).set(auth(tenant.owner));
  const item = sheet.body.items.find((i: any) => i.tableId === tableId);
  return item.url.split('/t/')[1] as string;
}
