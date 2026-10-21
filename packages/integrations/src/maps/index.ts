// Maps utilities for ResutoDriver. Owner: Agent D2.
//
// Baseline (always available, no provider): distances are great-circle (haversine) and ETAs
// are a documented speed baseline. INT-29 adds an optional provider behind the same interface:
// Google Routes with the restaurant's own key (./google-routes) through the RoutingEngine
// (./routing), which caches, enforces the daily cap and falls back to this labelled baseline. Navigation links open Google Maps through
// its public URL scheme (https://developers.google.com/maps/documentation/urls),
// which needs no API key.
//
// Route sequencing exposes a small interface (`RouteSequencer`) so the
// research-grade optimiser owned by Agent E1 (apps/ai-service) can replace the
// nearest-neighbour baseline without changing callers.
import type { ProviderDescriptor } from '../core';

export interface RoutePoint {
  latitude: number;
  longitude: number;
}

export type DeliveryVehicle = 'motorbike' | 'car' | 'bicycle' | 'scooter' | 'on_foot' | 'van';

const EARTH_RADIUS_M = 6_371_008.8; // IUGG mean Earth radius

/** Great-circle distance in metres (haversine formula). */
export function haversineMeters(a: RoutePoint, b: RoutePoint): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * ETA baseline (documented assumptions, not measured data):
 * - road distance ≈ great-circle distance × ROAD_FACTOR (1.35, a common urban
 *   detour factor for grid-and-ring cities such as Cairo and Riyadh);
 * - average urban speeds in km/h per vehicle type below (congested-city values);
 * - no traffic, signals or parking time beyond the speed average.
 * Replace with a routing provider or E1's model when measured data exists.
 */
export const ROAD_FACTOR = 1.35;
export const VEHICLE_SPEED_KMH: Record<DeliveryVehicle, number> = {
  motorbike: 25, scooter: 22, car: 20, van: 18, bicycle: 14, on_foot: 4.5,
};

export function estimateTravelSeconds(straightLineMeters: number, vehicle: DeliveryVehicle = 'motorbike'): number {
  if (!Number.isFinite(straightLineMeters) || straightLineMeters < 0) throw new RangeError('distance must be a non-negative number');
  const metresPerSecond = (VEHICLE_SPEED_KMH[vehicle] * 1000) / 3600;
  return Math.round((straightLineMeters * ROAD_FACTOR) / metresPerSecond);
}

export interface RouteStop {
  id: string;
  location: RoutePoint;
}

export interface RouteLeg {
  stopId: string;
  /** Straight-line distance from the previous point (origin or stop). */
  distanceM: number;
  /** Baseline travel time for this leg. */
  travelSeconds: number;
  /** Cumulative seconds from the origin to arrival at this stop. */
  arrivalOffsetSeconds: number;
}

export interface RoutePlan {
  algorithm: string;
  order: string[];
  legs: RouteLeg[];
  totalDistanceM: number;
  totalSeconds: number;
}

export interface RouteSequenceInput {
  origin: RoutePoint;
  stops: RouteStop[];
  vehicle?: DeliveryVehicle;
  /** Fixed handling time per stop (parking, handover), seconds. Default 180. */
  serviceSecondsPerStop?: number;
}

/** Replaceable sequencing strategy (E1 may provide an optimiser with this signature). */
export interface RouteSequencer {
  readonly id: string;
  sequence(input: RouteSequenceInput): RoutePlan;
}

/**
 * Greedy nearest-neighbour baseline: from the current point always visit the
 * closest remaining stop. O(n²); good enough for the handful of drops one
 * driver carries; not optimal (no 2-opt, no time windows).
 */
export const nearestNeighbourSequencer: RouteSequencer = {
  id: 'nearest_neighbour_v1',
  sequence({ origin, stops, vehicle = 'motorbike', serviceSecondsPerStop = 180 }) {
    const remaining = [...stops];
    const legs: RouteLeg[] = [];
    let here = origin;
    let elapsed = 0;
    let total = 0;
    while (remaining.length) {
      let best = 0;
      let bestD = Infinity;
      remaining.forEach((s, i) => {
        const d = haversineMeters(here, s.location);
        // ties broken by id for determinism
        if (d < bestD || (d === bestD && s.id < remaining[best]!.id)) { best = i; bestD = d; }
      });
      const stop = remaining.splice(best, 1)[0]!;
      const travel = estimateTravelSeconds(bestD, vehicle);
      elapsed += travel;
      legs.push({ stopId: stop.id, distanceM: Math.round(bestD), travelSeconds: travel, arrivalOffsetSeconds: elapsed });
      elapsed += serviceSecondsPerStop;
      total += bestD;
      here = stop.location;
    }
    return { algorithm: this.id, order: legs.map((l) => l.stopId), legs, totalDistanceM: Math.round(total), totalSeconds: elapsed };
  },
};

/** Google Maps directions link (URL scheme, no API key). Uses coordinates when known, else the address text. */
export function googleMapsDirectionsUrl(destination: RoutePoint | string, origin?: RoutePoint | null): string {
  const fmt = (p: RoutePoint | string) => (typeof p === 'string' ? p : `${p.latitude},${p.longitude}`);
  const params = new URLSearchParams({ api: '1', destination: fmt(destination), travelmode: 'driving' });
  if (origin) params.set('origin', fmt(origin));
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

export const MAPS_PROVIDERS: ProviderDescriptor[] = [{
  id: 'resuto_baseline_maps',
  name: 'Resuto baseline distance & ETA',
  category: 'delivery',
  countries: ['EG', 'SA'],
  authType: 'none',
  readiness: 'simulated',
  activation: ['None: offline haversine distance and speed baseline, used whenever Google Routes (restaurant-owned key) is not connected, over its daily cap or failing.'],
  capabilities: ['distance', 'eta_baseline', 'multi_drop_sequence', 'navigation_link'],
}];

export const mapsAdapters = [nearestNeighbourSequencer] as const;

// INT-29: optional provider + engine (exported last: they import the baseline above).
export * from './google-routes';
export * from './routing';
