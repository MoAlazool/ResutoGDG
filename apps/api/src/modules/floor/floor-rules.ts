import { geometryError, type FloorBackground, type FloorSaveInput, type FloorTableInput } from '@resuto/contracts';
import { DomainError, invalid } from '../../common/errors/domain-error';

/**
 * Schema-v2 save rules ported from legacy floor-domain.saveFloor. Pure: takes
 * the draft and the current tables, returns what to create/update/archive.
 * Operational state (status, visits) is never read from the draft.
 */
export interface CurrentTable {
  id: string; label: string; is_active: boolean; features: string[]; is_reservable: boolean; min_spend_minor: number | null;
  is_premium: boolean; internal_notes: string | null;
}

export interface PlannedTable {
  clientId: string | null;
  current: CurrentTable | null;
  values: {
    label: string; capacity: number; zone: string; shape: string; cx: number; cy: number; width: number; height: number; rotation: number;
    features: string[]; reservable: boolean; minSpendMinor: number | null; premium: boolean; internalNotes: string | null;
  };
}

const geometryInvalid = (path: string, message: string) => new DomainError('invalid_geometry', message, 422, { path });

export function validateBackground(bg: FloorBackground, canvas: { width: number; height: number }) {
  if (bg.x + bg.width > canvas.width || bg.y + bg.height > canvas.height) throw geometryInvalid('layout.background', 'Background must stay inside the canvas.');
  const image = bg.image;
  if (image !== null && !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(image) && !/^https:\/\/[^\s"'<>]{1,1990}$/.test(image)) {
    throw invalid('invalid_background', 'Choose a PNG or JPEG under 700 KB.', { path: 'layout.background.image' });
  }
}

export function planFloorSave(layout: FloorSaveInput['layout'], currentTables: CurrentTable[]): PlannedTable[] {
  const canvas = { width: layout.width, height: layout.height };
  const ids = new Set<string>();
  const claim = (id: string, path: string) => {
    if (ids.has(id)) throw invalid('duplicate_id', 'Objects must have unique identifiers.', { path });
    ids.add(id);
  };
  layout.zones.forEach((z, i) => {
    claim(z.id, `layout.zones.${i}.id`);
    const err = geometryError(z, canvas);
    if (err) throw geometryInvalid(`layout.zones.${i}`, `${z.label}: ${err}`);
  });
  layout.objects.forEach((o, i) => {
    claim(o.id, `layout.objects.${i}.id`);
    const err = geometryError(o, canvas);
    if (err) throw geometryInvalid(`layout.objects.${i}`, `${o.label}: ${err}`);
  });
  validateBackground(layout.background, canvas);

  const byId = new Map(currentTables.map((t) => [t.id, t]));
  const labels = new Set<string>();
  return layout.tables.map((t: FloorTableInput, i) => {
    const path = `layout.tables.${i}`;
    const isNew = !t.id || t.id.startsWith('new-');
    if (t.id) claim(t.id, `${path}.id`);
    const current = isNew ? null : byId.get(t.id!) ?? null;
    if (!isNew && !current) throw invalid('unknown_table', 'Unknown table identity. Tables are created without an id.', { path: `${path}.id` });
    if (current && !current.is_active) throw new DomainError('table_archived', 'Archived tables cannot be restored through a stale draft.', 409, { tableId: current.id });
    if ((t.shape === 'round' || t.shape === 'square') && t.width !== t.height) {
      throw geometryInvalid(path, `${t.label}: round and square tables need equal width and height.`);
    }
    const err = geometryError({ cx: t.cx, cy: t.cy, width: t.width, height: t.height, rotation: t.rotation }, canvas);
    if (err) throw geometryInvalid(path, `${t.label}: ${err}`);
    const key = t.label.trim().toLowerCase();
    if (labels.has(key)) throw invalid('duplicate_label', `Two tables are labelled ${t.label}.`, { path: `${path}.label` });
    labels.add(key);
    return {
      clientId: t.id ?? null,
      current,
      values: {
        label: t.label.trim(), capacity: t.capacity, zone: t.zone.trim(), shape: t.shape, cx: t.cx, cy: t.cy, width: t.width, height: t.height,
        rotation: t.rotation,
        features: t.features ?? current?.features ?? [],
        reservable: t.reservable ?? current?.is_reservable ?? true,
        minSpendMinor: t.minSpendMinor !== undefined ? t.minSpendMinor : current?.min_spend_minor ?? null,
        premium: t.premium ?? current?.is_premium ?? false,
        internalNotes: t.internalNotes !== undefined ? (t.internalNotes?.trim().slice(0, 5000) || null) : current?.internal_notes ?? null,
      },
    };
  });
}
