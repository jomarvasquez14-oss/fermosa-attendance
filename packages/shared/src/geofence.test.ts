import { describe, expect, it } from 'vitest';
import { checkGeofence, distanceMeters } from './geofence';

// Reference point: SM Trece Martires area, Cavite (approx).
const BRANCH = { lat: 14.2818, lng: 120.8656 };

describe('distanceMeters', () => {
  it('is zero for identical points', () => {
    expect(distanceMeters(BRANCH.lat, BRANCH.lng, BRANCH.lat, BRANCH.lng)).toBe(0);
  });

  it('matches known distance: ~1 degree latitude is ~111 km', () => {
    const d = distanceMeters(14.0, 121.0, 15.0, 121.0);
    expect(d).toBeGreaterThan(110_000);
    expect(d).toBeLessThan(112_000);
  });

  it('is symmetric', () => {
    const a = distanceMeters(14.28, 120.86, 14.29, 120.87);
    const b = distanceMeters(14.29, 120.87, 14.28, 120.86);
    expect(a).toBeCloseTo(b, 6);
  });
});

describe('checkGeofence', () => {
  it('accepts a punch at the branch itself', () => {
    const r = checkGeofence(BRANCH.lat, BRANCH.lng, BRANCH.lat, BRANCH.lng, 100);
    expect(r.inside).toBe(true);
    expect(r.distanceM).toBe(0);
  });

  it('accepts a punch ~50m away with a 100m radius', () => {
    // ~0.00045 deg latitude ≈ 50m
    const r = checkGeofence(BRANCH.lat + 0.00045, BRANCH.lng, BRANCH.lat, BRANCH.lng, 100);
    expect(r.inside).toBe(true);
    expect(r.distanceM).toBeGreaterThan(40);
    expect(r.distanceM).toBeLessThan(60);
  });

  it('rejects a punch ~200m away with a 100m radius', () => {
    // ~0.0018 deg latitude ≈ 200m
    const r = checkGeofence(BRANCH.lat + 0.0018, BRANCH.lng, BRANCH.lat, BRANCH.lng, 100);
    expect(r.inside).toBe(false);
    expect(r.distanceM).toBeGreaterThan(150);
  });

  it('treats exactly-on-boundary as inside', () => {
    const r = checkGeofence(BRANCH.lat, BRANCH.lng, BRANCH.lat, BRANCH.lng, 0);
    expect(r.inside).toBe(true);
  });
});
