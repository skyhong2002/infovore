import { publicBaseUrl as basePublicUrl } from './seo.js';
import { parsePlacesConfig } from './location/zones.js';

// Which sources to enable. Empty = all. e.g. SOURCES=kitsu,statsfm
// `goodreads` is accepted as a legacy name for `hardcover`: Goodreads shut
// down its RSS feeds in 2026 and the book source moved to Hardcover, so an
// older SOURCES line keeps booting instead of failing on an unknown source.
const sources = [...new Set((process.env.SOURCES ?? '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean)
  .map((s) => (s === 'goodreads' ? 'hardcover' : s)))];

const knownSources = ['backloggd', 'kitsu', 'statsfm', 'simkl', 'hardcover', 'youtube', 'health', 'dayflow', 'computai', 'places', 'pocketlog'] as const;
const port = Number(process.env.PORT ?? 3000);
const maxSourceAgeHours = Number(process.env.MAX_SOURCE_AGE_HOURS ?? 36);
const refreshIntervalMinutes = Number(process.env.REFRESH_INTERVAL_MINUTES ?? 60);
// Device-pushed sources can be called delayed sooner than fetched ones: the
// Android app pushes Health several times a day, so a day without a push means
// the phone's sync has stopped (often because the app is not running at all,
// which the phone itself cannot report). Dayflow and AI agents are pushed from
// computers that may stay off for a weekend, so they keep MAX_SOURCE_AGE_HOURS
// unless set. Override as PUSHED_DELAY_HOURS=health:24,dayflow:36,computai:36.
export const PUSHED_SOURCES = ['health', 'dayflow', 'computai'] as const;
export function parsePushedDelayHours(text: string, fallbackHours: number): Record<string, number> {
  const hours: Record<string, number> = { health: Math.min(24, fallbackHours), dayflow: fallbackHours, computai: fallbackHours };
  for (const part of text.split(',').map((item) => item.trim()).filter(Boolean)) {
    const [name, value] = part.split(':').map((item) => item.trim());
    const parsed = Number(value);
    if (!name || !(PUSHED_SOURCES as readonly string[]).includes(name) || !value || !Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`PUSHED_DELAY_HOURS: expected source:hours for ${PUSHED_SOURCES.join(', ')}, got "${part}"`);
    }
    hours[name] = parsed;
  }
  return hours;
}
const ingestToken = process.env.INGEST_TOKEN ?? '';
const dayflowToken = process.env.DAYFLOW_TOKEN ?? '';
if (dayflowToken && dayflowToken.length < 32) throw new Error('DAYFLOW_TOKEN must contain at least 32 characters');
const computaiToken = process.env.COMPUTAI_TOKEN ?? '';
if (computaiToken && computaiToken.length < 32) throw new Error('COMPUTAI_TOKEN must contain at least 32 characters');
const healthConnectToken = process.env.HEALTH_CONNECT_TOKEN ?? ingestToken;
// The Android companion uploads location with the token it already holds for Health Connect.
const locationToken = process.env.LOCATION_TOKEN ?? healthConnectToken;
if (locationToken && locationToken.length < 32) throw new Error('LOCATION_TOKEN must contain at least 32 characters');
// Fog of World: a read-only Dropbox app mirrors its sync folder (src/fog). All three or none.
const fogDropboxParts = [process.env.FOG_DROPBOX_APP_KEY, process.env.FOG_DROPBOX_APP_SECRET, process.env.FOG_DROPBOX_REFRESH_TOKEN];
if (fogDropboxParts.some(Boolean) && !fogDropboxParts.every(Boolean)) {
  throw new Error('FOG_DROPBOX_APP_KEY, FOG_DROPBOX_APP_SECRET and FOG_DROPBOX_REFRESH_TOKEN must be set together');
}
const fogIntervalMinutes = Number(process.env.FOG_SYNC_INTERVAL_MINUTES ?? 30);
if (!Number.isInteger(fogIntervalMinutes) || fogIntervalMinutes < 5 || fogIntervalMinutes > 1440) {
  throw new Error('FOG_SYNC_INTERVAL_MINUTES must be an integer between 5 and 1440');
}
const fogDropbox = fogDropboxParts.every(Boolean) ? {
  appKey: process.env.FOG_DROPBOX_APP_KEY!, appSecret: process.env.FOG_DROPBOX_APP_SECRET!,
  refreshToken: process.env.FOG_DROPBOX_REFRESH_TOKEN!,
  path: process.env.FOG_DROPBOX_PATH || '/Apps/Fog of World/Sync', intervalMinutes: fogIntervalMinutes,
} : null;
// PocketLog (src/pocketlog): phone activity read with a journal device key. Both or neither.
const pocketlogUrl = (process.env.POCKETLOG_URL ?? '').replace(/\/+$/, '');
const pocketlogToken = process.env.POCKETLOG_TOKEN ?? '';
if (Boolean(pocketlogUrl) !== Boolean(pocketlogToken)) throw new Error('POCKETLOG_URL and POCKETLOG_TOKEN must be set together');
if (pocketlogUrl && !/^https?:\/\/[^/?#@]+$/.test(pocketlogUrl)) throw new Error('POCKETLOG_URL must be an http(s) origin without a path');
if (pocketlogToken && !/^[0-9a-f]{64}$/i.test(pocketlogToken)) throw new Error('POCKETLOG_TOKEN must be a 64-character hexadecimal device key');
const pocketlogInterval = Number(process.env.POCKETLOG_SYNC_INTERVAL_MINUTES ?? 15);
if (!Number.isInteger(pocketlogInterval) || pocketlogInterval < 5 || pocketlogInterval > 1440) {
  throw new Error('POCKETLOG_SYNC_INTERVAL_MINUTES must be an integer between 5 and 1440');
}
const pocketlog = pocketlogUrl ? { baseUrl: pocketlogUrl, token: pocketlogToken, intervalMinutes: pocketlogInterval } : null;
// The public Places page (src/location/public.ts): on with at least one privacy zone.
const places = locationToken ? parsePlacesConfig(process.env) : null;
const publicBaseUrl = basePublicUrl(process.env);
const qualityBaseUrl = (process.env.DAYFLOW_AI_BASE_URL ?? '').replace(/\/+$/, '');
const qualityApiKey = process.env.DAYFLOW_AI_API_KEY ?? '';
if (qualityBaseUrl && !/^https?:\/\//.test(qualityBaseUrl)) throw new Error('DAYFLOW_AI_BASE_URL must use HTTP or HTTPS');
const dayflowQuality = qualityBaseUrl && qualityApiKey ? {
  baseUrl: qualityBaseUrl, apiKey: qualityApiKey, model: process.env.DAYFLOW_AI_MODEL || 'sky-quality',
} : null;

const invalidSources = sources.filter((source) => !knownSources.includes(source as typeof knownSources[number]));
if (invalidSources.length) throw new Error(`Unknown SOURCES: ${invalidSources.join(', ')}`);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535');
if (!Number.isFinite(maxSourceAgeHours) || maxSourceAgeHours <= 0) throw new Error('MAX_SOURCE_AGE_HOURS must be positive');
const pushedDelayHours = parsePushedDelayHours(process.env.PUSHED_DELAY_HOURS ?? '', maxSourceAgeHours);
if (!Number.isInteger(refreshIntervalMinutes) || refreshIntervalMinutes < 5 || refreshIntervalMinutes > 1440) {
  throw new Error('REFRESH_INTERVAL_MINUTES must be an integer between 5 and 1440');
}
if (ingestToken && ingestToken.length < 32) throw new Error('INGEST_TOKEN must contain at least 32 characters');
if (healthConnectToken && healthConnectToken.length < 32) {
  throw new Error('HEALTH_CONNECT_TOKEN must contain at least 32 characters');
}

export const config = {
  port,
  databasePath: process.env.DATABASE_PATH ?? './data/infovore.sqlite',
  publicBaseUrl,
  ingestToken,
  healthConnect: { token: healthConnectToken },
  location: { token: locationToken },
  fog: { dropbox: fogDropbox },
  places,
  pocketlog,
  dayflow: { token: dayflowToken, quality: dayflowQuality },
  computai: { token: computaiToken },
  maxSourceAgeHours,
  // After how many hours without a successful sync a source is shown as
  // delayed: MAX_SOURCE_AGE_HOURS, or its PUSHED_DELAY_HOURS for device-pushed sources.
  delayAfterHours: (source: string): number => pushedDelayHours[source] ?? maxSourceAgeHours,
  refreshIntervalMinutes,
  ownerName: process.env.OWNER_NAME ?? 'Sky Hong',
  sources,
  sourceEnabled: (name: string) => sources.length === 0 || sources.includes(name),
  backloggd: { username: process.env.BACKLOGGD_USERNAME ?? 'skychopath' },
  kitsu: {
    slug: process.env.KITSU_SLUG ?? 'skyhong2002',
    userId: process.env.KITSU_USER_ID ?? '1366093',
  },
  statsfm: { username: process.env.STATSFM_USERNAME ?? 'skyhong2002' },
  // The owner's wallpaper collection (afterimage). Only the MCP wallpaper tools read it.
  wallpapers: {
    catalogUrl: process.env.WALLPAPER_CATALOG_URL ?? 'https://afterimage.skyhong.tw/api/wallpapers.json',
  },
  simkl: {
    userId: process.env.SIMKL_USER_ID ?? '8074923',
    clientId: process.env.SIMKL_CLIENT_ID ?? '',
    accessToken: process.env.SIMKL_ACCESS_TOKEN ?? '',
  },
  // Personal API token from https://hardcover.app/account/api.
  hardcover: {
    username: process.env.HARDCOVER_USERNAME ?? 'skyhong.tw',
    token: (process.env.HARDCOVER_TOKEN ?? '').trim(),
  },
  // YouTube tracking lives in urtube; infovore mirrors its public per-handle
  // aggregates.
  urtube: {
    baseUrl: (process.env.URTUBE_BASE_URL ?? 'https://urtube.observe.tw').replace(/\/$/, ''),
    handle: process.env.URTUBE_HANDLE ?? 'skyhong.tw',
    // Dashboard token for the private intervals feed (exact watch times with
    // measured or estimated seconds). Without it only public aggregates sync.
    dashboardToken: process.env.URTUBE_DASHBOARD_TOKEN ?? '',
    publicRecent: process.env.URTUBE_PUBLIC_RECENT === 'true',
  },
  userAgent:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
};
