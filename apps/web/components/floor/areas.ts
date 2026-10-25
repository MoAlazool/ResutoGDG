// Floor areas (21-OPS "area tabs"): the zones a branch's tables belong to (Main Room, Terrace …), and the live map
// cropped to one of them. Pure, so it is unit tested without a browser. Layout data keeps its stored labels; the
// caller translates them for display.
import { tightView } from './model';
import type { SceneLayout } from './FloorScene';

export interface FloorArea { label: string; tables: number }

/** The areas that have tables, in the order of the layout's zone objects, then any other table zone (A-Z). */
export function floorAreas(layout: Pick<SceneLayout, 'zones' | 'tables'>): FloorArea[] {
  const counts = new Map<string, number>();
  for (const t of layout.tables) if (t.zone) counts.set(t.zone, (counts.get(t.zone) ?? 0) + 1);
  const ordered = layout.zones.map((z) => z.label).filter((l): l is string => !!l && counts.has(l));
  const rest = [...counts.keys()].filter((l) => !ordered.includes(l)).sort((a, b) => a.localeCompare(b));
  return [...new Set([...ordered, ...rest])].map((label) => ({ label, tables: counts.get(label)! }));
}

/**
 * The scene for one area: its tables and its zone outline (other tables are not drawn), the view cropped to them. null (or an area that is
 * no longer on the floor) = the entire floor, uncropped.
 */
export function areaScene(scene: SceneLayout, area: string | null): { layout: SceneLayout; viewBox?: string } {
  if (!area || !scene.tables.some((t) => t.zone === area)) return { layout: scene };
  const layout: SceneLayout = {
    ...scene,
    zones: scene.zones.filter((z) => z.label === area),
    tables: scene.tables.filter((t) => t.zone === area),
  };
  // Walls, the bar and other furniture stay; the view is cropped to the area's tables and outline.
  return { layout, viewBox: tightView({ ...layout, objects: [] }) };
}
