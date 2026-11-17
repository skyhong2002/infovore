// Privacy zones and delays for the public Places projection (src/location/public.ts).
// The zones (home, dorm, …) are set only in the server's environment, never in
// the repository: LOCATION_PRIVACY_ZONES="lat,lng,radiusMetres;lat,lng,radiusMetres".
// Nothing public is derived from inside a zone; without at least one zone the
// public projection stays off.

export interface PrivacyZone { lat: number; lng: number; radiusM: number }

export interface PlacesConfig {
  zones: PrivacyZone[];
  /** Public statistics, regions and the fog map lag this far behind. */
  delayHours: number;
  /** The "last seen around" line on Now lags this far behind. */
  nowDelayHours: number;
  /**
   * Regions (English names, as on the page) that Fog of World alone does not
   * make visited: its history has no dates, so a corridor ridden through by
   * train cannot be told from a trip (PLACES_FOG_IGNORE_REGIONS, comma-separated).
   */
  fogIgnoreRegions: string[];
  /** Places visited before any recording, one point each (PLACES_EXTRA="lat,lng;lat,lng"): their regions count. */
  extraPlaces: Array<{ lat: number; lng: number }>;
}

const MIN_RADIUS_M = 500;
const MAX_RADIUS_M = 20_000;

export function parsePrivacyZones(text: string): PrivacyZone[] {
  return text.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const [lat, lng, radius] = part.split(',').map((value) => Number(value.trim()));
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 85 || Math.abs(lng) > 180
      || !Number.isFinite(radius) || radius < MIN_RADIUS_M || radius > MAX_RADIUS_M) {
      throw new Error(`LOCATION_PRIVACY_ZONES: expected lat,lng,radius (${MIN_RADIUS_M}–${MAX_RADIUS_M} m) separated by ";"`);
    }
    return { lat, lng, radiusM: radius };
  });
}

function hours(value: string | undefined, fallback: number, name: string): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed < 12 || parsed > 24 * 60) throw new Error(`${name} must be between 12 and 1440 hours`);
  return parsed;
}

export function parsePlacesConfig(env: NodeJS.ProcessEnv): PlacesConfig | null {
  const zones = parsePrivacyZones(env.LOCATION_PRIVACY_ZONES ?? '');
  const delayHours = hours(env.LOCATION_PUBLIC_DELAY_HOURS, 72, 'LOCATION_PUBLIC_DELAY_HOURS');
  const nowDelayHours = hours(env.LOCATION_NOW_DELAY_HOURS, 24, 'LOCATION_NOW_DELAY_HOURS');
  const fogIgnoreRegions = (env.PLACES_FOG_IGNORE_REGIONS ?? '').split(',').map((name) => name.trim()).filter(Boolean);
  const extraPlaces = (env.PLACES_EXTRA ?? '').split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const [lat, lng] = part.split(',').map((value) => Number(value.trim()));
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 85 || Math.abs(lng) > 180) {
      throw new Error('PLACES_EXTRA: expected lat,lng pairs separated by ";"');
    }
    return { lat, lng };
  });
  return zones.length ? { zones, delayHours, nowDelayHours, fogIgnoreRegions, extraPlaces } : null;
}

const EARTH_M = 6_371_008.8;

/** Whether a point lies inside any zone (equirectangular distance; zones are a few km). */
export function inPrivacyZone(zones: readonly PrivacyZone[], lat: number, lng: number): boolean {
  const rad = Math.PI / 180;
  return zones.some((zone) => {
    const x = (lng - zone.lng) * rad * Math.cos(((lat + zone.lat) / 2) * rad) * EARTH_M;
    const y = (lat - zone.lat) * rad * EARTH_M;
    return x * x + y * y <= zone.radiusM * zone.radiusM;
  });
}
