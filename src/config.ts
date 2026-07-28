// Which sources to enable. Empty = all. e.g. SOURCES=kitsu,statsfm
const sources = (process.env.SOURCES ?? '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const knownSources = ['backloggd', 'kitsu', 'statsfm', 'simkl', 'goodreads'] as const;
const port = Number(process.env.PORT ?? 3000);
const maxSourceAgeHours = Number(process.env.MAX_SOURCE_AGE_HOURS ?? 36);
const refreshIntervalMinutes = Number(process.env.REFRESH_INTERVAL_MINUTES ?? 60);
const ingestToken = process.env.INGEST_TOKEN ?? '';

const invalidSources = sources.filter((source) => !knownSources.includes(source as typeof knownSources[number]));
if (invalidSources.length) throw new Error(`Unknown SOURCES: ${invalidSources.join(', ')}`);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535');
if (!Number.isFinite(maxSourceAgeHours) || maxSourceAgeHours <= 0) throw new Error('MAX_SOURCE_AGE_HOURS must be positive');
if (!Number.isInteger(refreshIntervalMinutes) || refreshIntervalMinutes < 5 || refreshIntervalMinutes > 1440) {
  throw new Error('REFRESH_INTERVAL_MINUTES must be an integer between 5 and 1440');
}
if (ingestToken && ingestToken.length < 32) throw new Error('INGEST_TOKEN must contain at least 32 characters');

export const config = {
  port,
  databasePath: process.env.DATABASE_PATH ?? './data/infovore.sqlite',
  publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? (process.env.DOMAIN ? `https://${process.env.DOMAIN}` : 'http://localhost:3000')).replace(/\/$/, ''),
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
  userAgent:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
};
