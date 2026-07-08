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

export const config = {
  port: Number(process.env.PORT ?? 3000),
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
