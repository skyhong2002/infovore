// Which sources to enable. Empty = all. e.g. SOURCES=kitsu,statsfm
const sources = (process.env.SOURCES ?? '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// Daily refresh schedule, as HH:MM in GMT+8 (fixed offset, no DST). e.g.
// REFRESH_TIMES=06:00,18:00
const refreshTimes = (process.env.REFRESH_TIMES ?? '06:00,18:00')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const knownSources = ['backloggd', 'kitsu', 'statsfm', 'simkl', 'goodreads'] as const;
const port = Number(process.env.PORT ?? 3000);
const maxSourceAgeHours = Number(process.env.MAX_SOURCE_AGE_HOURS ?? 36);

const invalidSources = sources.filter((source) => !knownSources.includes(source as typeof knownSources[number]));
if (invalidSources.length) throw new Error(`Unknown SOURCES: ${invalidSources.join(', ')}`);
if (!refreshTimes.length || refreshTimes.some((time) => !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time))) {
  throw new Error('REFRESH_TIMES must be comma-separated HH:MM values in GMT+8');
}
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535');
if (!Number.isFinite(maxSourceAgeHours) || maxSourceAgeHours <= 0) throw new Error('MAX_SOURCE_AGE_HOURS must be positive');

export const config = {
  port,
  databasePath: process.env.DATABASE_PATH ?? './data/infovore.sqlite',
  maxSourceAgeHours,
  refreshTimes,
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
