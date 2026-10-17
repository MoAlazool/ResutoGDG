import { describe, expect, it } from 'vitest';
import { estimateTravelSeconds, googleMapsDirectionsUrl, haversineMeters, nearestNeighbourSequencer } from './index';

describe('maps baseline', () => {
  it('computes great-circle distances', () => {
    // Cairo Tower → Giza pyramids (~11.5 km straight line)
    const d = haversineMeters({ latitude: 30.0459, longitude: 31.2243 }, { latitude: 29.9792, longitude: 31.1342 });
    expect(d).toBeGreaterThan(11_000);
    expect(d).toBeLessThan(12_000);
    expect(haversineMeters({ latitude: 24.7, longitude: 46.7 }, { latitude: 24.7, longitude: 46.7 })).toBe(0);
  });

  it('estimates travel time from the documented speed baseline', () => {
    // 5 km × 1.35 road factor at 25 km/h = 972 s
    expect(estimateTravelSeconds(5000, 'motorbike')).toBe(972);
    expect(estimateTravelSeconds(5000, 'on_foot')).toBeGreaterThan(estimateTravelSeconds(5000, 'car'));
    expect(() => estimateTravelSeconds(-1)).toThrow();
  });

  it('sequences multiple drops nearest-first', () => {
    const origin = { latitude: 30.0, longitude: 31.0 };
    const plan = nearestNeighbourSequencer.sequence({
      origin,
      stops: [
        { id: 'far', location: { latitude: 30.1, longitude: 31.1 } },
        { id: 'near', location: { latitude: 30.01, longitude: 31.0 } },
        { id: 'mid', location: { latitude: 30.05, longitude: 31.05 } },
      ],
    });
    expect(plan.order).toEqual(['near', 'mid', 'far']);
    expect(plan.legs[2]!.arrivalOffsetSeconds).toBeGreaterThan(plan.legs[0]!.arrivalOffsetSeconds);
    expect(plan.algorithm).toBe('nearest_neighbour_v1');
    expect(nearestNeighbourSequencer.sequence({ origin, stops: [] }).order).toEqual([]);
  });

  it('builds key-less Google Maps links', () => {
    expect(googleMapsDirectionsUrl({ latitude: 30.05, longitude: 31.23 })).toBe('https://www.google.com/maps/dir/?api=1&destination=30.05%2C31.23&travelmode=driving');
    expect(googleMapsDirectionsUrl('12 Nile St, Cairo')).toContain('destination=12+Nile+St%2C+Cairo');
  });
});
