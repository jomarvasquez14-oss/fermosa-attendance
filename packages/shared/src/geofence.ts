/**
 * Geofence math shared by the mobile app (instant UX feedback) and tests.
 * The server independently recomputes this in SQL — the client result is
 * advisory only and never trusted for the official record.
 */

const EARTH_RADIUS_M = 6_371_000;

/** Great-circle distance between two coordinates in meters (haversine). */
export function distanceMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

export interface GeofenceCheck {
  inside: boolean;
  distanceM: number;
}

export function checkGeofence(
  employeeLat: number,
  employeeLng: number,
  branchLat: number,
  branchLng: number,
  radiusM: number,
): GeofenceCheck {
  const distanceM = distanceMeters(employeeLat, employeeLng, branchLat, branchLng);
  return { inside: distanceM <= radiusM, distanceM };
}
