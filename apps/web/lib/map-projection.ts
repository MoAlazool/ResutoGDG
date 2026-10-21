/**
 * FT-14: a schematic map without tiles (no paid or third-party tile servers, nothing extra in the CSP). Points are
 * projected equirectangularly (longitude scaled by cos(latitude)) into a viewBox with padding, keeping proportions.
 */
export interface GeoPoint { latitude: number; longitude: number }
export interface Projected { x: number; y: number }

export function project(points: GeoPoint[], size: { width: number; height: number; pad: number }): Projected[] {
  if (!points.length) return [];
  const midLat = points.reduce((s, p) => s + p.latitude, 0) / points.length;
  const k = Math.cos((midLat * Math.PI) / 180);
  const xs = points.map((p) => p.longitude * k), ys = points.map((p) => -p.latitude);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  // A single point (or identical points) sits in the middle; at least ~200 m of span keeps close points apart.
  const span = Math.max(maxX - minX, maxY - minY, 0.002);
  const w = size.width - 2 * size.pad, h = size.height - 2 * size.pad;
  const scale = Math.min(w, h) / span;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const r = (v: number) => Math.round(v * 10) / 10;
  return points.map((_, i) => ({ x: r(size.width / 2 + (xs[i]! - cx) * scale), y: r(size.height / 2 + (ys[i]! - cy) * scale) }));
}

/** Straight-line distance in metres (haversine), for the map's scale note. */
export function metresBetween(a: GeoPoint, b: GeoPoint): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(b.latitude - a.latitude) / 2) ** 2 + Math.cos(r(a.latitude)) * Math.cos(r(b.latitude)) * Math.sin(r(b.longitude - a.longitude) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}
