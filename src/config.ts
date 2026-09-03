// Which sources to enable. Empty = all. e.g. SOURCES=kitsu,statsfm
const sources = (process.env.SOURCES ?? '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const knownSources = ['backloggd', 'kitsu', 'statsfm', 'simkl', 'goodreads', 'youtube'] as const;
const port = Number(process.env.PORT ?? 3000);
const maxSourceAgeHours = Number(process.env.MAX_SOURCE_AGE_HOURS ?? 36);
const refreshIntervalMinutes = Number(process.env.REFRESH_INTERVAL_MINUTES ?? 60);
const ingestToken = process.env.INGEST_TOKEN ?? '';
const publicBaseUrl = (process.env.PUBLIC_BASE_URL ?? (process.env.DOMAIN ? `https://${process.env.DOMAIN}` : 'http://localhost:3000')).replace(/\/$/, '');
const youtubePrivateDataKey = process.env.YOUTUBE_PRIVATE_DATA_KEY ?? '';
const youtubeCaptureToken = process.env.YOUTUBE_CAPTURE_TOKEN ?? '';
const youtubeSyncHour = Number(process.env.YOUTUBE_SYNC_HOUR ?? 4);
const aiClassificationEnabled = /^(1|true|yes)$/i.test(
  process.env.AI_CLASSIFICATION_ENABLED ?? ''
);

const invalidSources = sources.filter((source) => !knownSources.includes(source as typeof knownSources[number]));
if (invalidSources.length) throw new Error(`Unknown SOURCES: ${invalidSources.join(', ')}`);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535');
if (!Number.isFinite(maxSourceAgeHours) || maxSourceAgeHours <= 0) throw new Error('MAX_SOURCE_AGE_HOURS must be positive');
if (!Number.isInteger(refreshIntervalMinutes) || refreshIntervalMinutes < 5 || refreshIntervalMinutes > 1440) {
  throw new Error('REFRESH_INTERVAL_MINUTES must be an integer between 5 and 1440');
}
if (ingestToken && ingestToken.length < 32) throw new Error('INGEST_TOKEN must contain at least 32 characters');
if (youtubePrivateDataKey && youtubePrivateDataKey.length < 32) {
  throw new Error('YOUTUBE_PRIVATE_DATA_KEY must contain at least 32 characters');
}
if (youtubeCaptureToken && youtubeCaptureToken.length < 32) {
  throw new Error('YOUTUBE_CAPTURE_TOKEN must contain at least 32 characters');
}
if (!Number.isInteger(youtubeSyncHour) || youtubeSyncHour < 0 || youtubeSyncHour > 23) {
  throw new Error('YOUTUBE_SYNC_HOUR must be an integer from 0 to 23');
}

export const config = {
  port,
  databasePath: process.env.DATABASE_PATH ?? './data/infovore.sqlite',
  publicBaseUrl,
  ingestToken,
  maxSourceAgeHours,
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
  simkl: {
    userId: process.env.SIMKL_USER_ID ?? '8074923',
    clientId: process.env.SIMKL_CLIENT_ID ?? '',
    accessToken: process.env.SIMKL_ACCESS_TOKEN ?? '',
  },
  goodreads: { userId: process.env.GOODREADS_USER_ID ?? '160195773-skychopath' },
  youtube: {
    apiKey: process.env.YOUTUBE_API_KEY ?? '',
    privateDataKey: youtubePrivateDataKey,
    captureToken: youtubeCaptureToken,
    googleClientId: process.env.GOOGLE_DATA_PORTABILITY_CLIENT_ID ?? '',
    googleClientSecret: process.env.GOOGLE_DATA_PORTABILITY_CLIENT_SECRET ?? '',
    googleRedirectUri: process.env.GOOGLE_DATA_PORTABILITY_REDIRECT_URI
      ?? `${publicBaseUrl}/api/ingest/youtube/oauth/callback`,
    syncHour: youtubeSyncHour,
  },
  // YouTube tracking lives in urtube; infovore mirrors its public per-handle
  // aggregates.
  urtube: {
    baseUrl: (process.env.URTUBE_BASE_URL ?? 'https://urtube.observe.tw').replace(/\/$/, ''),
    handle: process.env.URTUBE_HANDLE ?? 'skyhong.tw',
  },
  ai: {
    enabled: aiClassificationEnabled,
    baseUrl: (process.env.AI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, ''),
    apiKey: process.env.AI_API_KEY ?? '',
    model: process.env.AI_MODEL ?? '',
  },
  userAgent:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
};
