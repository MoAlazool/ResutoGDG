import { withinOpeningHours, type OpeningHour } from '../reservations/availability';

/**
 * FT-09 pure rules: is a branch open at an instant (its own time zone), and which delivery zone covers a point.
 * No I/O; ServiceAreaService loads the rows and the pricing engine applies the result.
 */
export interface LatLng { latitude: number; longitude: number }
export interface ZoneRow {
  id: string; name: string; name_ar: string | null; kind: 'radius' | 'polygon' | 'area'; radius_m: number | null;
  polygon: Array<[number, number]> | null; fee_minor: number | string; min_order_minor: number | string; eta_min: number | null; sort_order: number;
}

const EARTH_M = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in metres (haversine). */
export function distanceM(a: LatLng, b: LatLng): number {
  const dLat = rad(b.latitude - a.latitude), dLng = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Ray casting on [lat, lng] pairs (planar; fine at city scale). Points on an edge count as inside. */
export function inPolygon(p: LatLng, ring: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i]!, [yj, xj] = ring[j]!;
    const onEdge = Math.abs((xj - xi) * (p.latitude - yi) - (yj - yi) * (p.longitude - xi)) < 1e-12
      && p.longitude >= Math.min(xi, xj) && p.longitude <= Math.max(xi, xj) && p.latitude >= Math.min(yi, yj) && p.latitude <= Math.max(yi, yj);
    if (onEdge) return true;
    if ((yi > p.latitude) !== (yj > p.latitude) && p.longitude < ((xj - xi) * (p.latitude - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Zones whose geometry covers the point, cheapest first then by sort order. Area zones never match a point. */
export function zonesCovering(zones: ZoneRow[], branch: LatLng | null, p: LatLng): ZoneRow[] {
  return zones.filter((z) => {
    if (z.kind === 'polygon') return !!z.polygon && inPolygon(p, z.polygon);
    if (z.kind === 'radius') return !!branch && z.radius_m !== null && distanceM(branch, p) <= z.radius_m;
    return false;
  }).sort((a, b) => Number(a.fee_minor) - Number(b.fee_minor) || a.sort_order - b.sort_order);
}

/** Local day of week (0 = Sunday) and minutes after midnight of `at` in `timeZone`. */
export function localClock(at: Date, timeZone: string): { dow: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const get = (t: string) => parts.find((x) => x.type === t)?.value ?? '';
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { dow, minute: Number(get('hour')) * 60 + Number(get('minute')) };
}

/** Empty hours mean "always open" (the restaurant has not set hours). */
export function openAt(hours: OpeningHour[] | null | undefined, timeZone: string, at: Date): boolean {
  const list = Array.isArray(hours) ? hours : [];
  if (!list.length) return true;
  const { dow, minute } = localClock(at, timeZone);
  return withinOpeningHours(list, dow, minute, 1);
}

/** The next instant (to the minute, within 8 days) the branch opens, or null when it never does. */
export function nextOpening(hours: OpeningHour[] | null | undefined, timeZone: string, from: Date): Date | null {
  if (!Array.isArray(hours) || !hours.length) return from;
  const start = new Date(Math.ceil(from.getTime() / 60_000) * 60_000);
  // Step by 15 minutes, then refine to the minute.
  for (let t = start.getTime(); t < start.getTime() + 8 * 86_400_000; t += 15 * 60_000) {
    if (openAt(hours, timeZone, new Date(t))) {
      for (let u = Math.max(start.getTime(), t - 15 * 60_000); u <= t; u += 60_000) if (openAt(hours, timeZone, new Date(u))) return new Date(u);
    }
  }
  return null;
}
