import { z } from 'zod';

// Location history pushed by the Android companion: its own fixes ("live")
// and records parsed from a Google Maps Timeline export ("timeline"). It is
// private: nothing here reaches the public pages, feeds, cards or MCP.

export const LOCATION_SOURCES = ['live', 'timeline'] as const;
export type LocationSource = typeof LOCATION_SOURCES[number];

const instant = z.string().max(40).refine((value) => Number.isFinite(Date.parse(value)), 'Invalid timestamp');
const latitude = z.number().finite().min(-90).max(90);
const longitude = z.number().finite().min(-180).max(180);
const optionalNumber = (min: number, max: number) => z.number().finite().min(min).max(max).nullish();
const label = z.string().trim().max(200).nullish();

export const locationPointSchema = z.object({
  time: instant,
  lat: latitude,
  lng: longitude,
  accuracy: optionalNumber(0, 100_000),
  altitude: optionalNumber(-1_000, 20_000),
  speed: optionalNumber(0, 1_000),
});

export const locationVisitSchema = z.object({
  start: instant,
  end: instant,
  lat: latitude,
  lng: longitude,
  placeId: z.string().max(200).nullish(),
  semanticType: label,
  name: label,
  probability: optionalNumber(0, 1),
});

export const locationActivitySchema = z.object({
  start: instant,
  end: instant,
  startLat: latitude.nullish(),
  startLng: longitude.nullish(),
  endLat: latitude.nullish(),
  endLng: longitude.nullish(),
  distanceMeters: optionalNumber(0, 50_000_000),
  mode: label,
  probability: optionalNumber(0, 1),
});

// One request holds at most 2,000 records of each kind (about 300 KB of JSON
// for points), so a whole day of one-per-minute fixes fits in one batch.
export const locationBatchSchema = z.object({
  deviceId: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  source: z.enum(LOCATION_SOURCES),
  points: z.array(locationPointSchema).max(2_000).default([]),
  visits: z.array(locationVisitSchema).max(2_000).default([]),
  activities: z.array(locationActivitySchema).max(2_000).default([]),
}).refine((batch) => batch.points.length + batch.visits.length + batch.activities.length > 0, 'Empty batch');

export type LocationBatch = z.infer<typeof locationBatchSchema>;

export interface LocationPoint {
  time: string;
  lat: number;
  lng: number;
  accuracy: number | null;
  source: LocationSource;
}

export interface LocationVisit {
  start: string;
  end: string;
  lat: number;
  lng: number;
  placeId: string | null;
  semanticType: string | null;
  name: string | null;
  source: LocationSource;
}

export interface LocationActivity {
  start: string;
  end: string;
  startLat: number | null;
  startLng: number | null;
  endLat: number | null;
  endLng: number | null;
  distanceMeters: number | null;
  mode: string | null;
  source: LocationSource;
}

export interface LocationStatus {
  points: number;
  visits: number;
  activities: number;
  latest: LocationPoint | null;
  lastLiveAt: string | null;
  lastReceivedAt: string | null;
  timelineRange: { from: string; to: string } | null;
}

export interface LocationDay {
  day: string;
  points: LocationPoint[];
  /** True when the day had more points than returned (evenly thinned). */
  thinned: boolean;
  visits: LocationVisit[];
  activities: LocationActivity[];
  distanceMeters: number;
  latest: LocationPoint | null;
}
