import { createHash } from 'node:crypto';
import { unzipSync, type UnzipFileInfo } from 'fflate';
import { encryptPrivateValue } from './crypto.js';
import type { YoutubeParsedArchive, YoutubeSearchInput, YoutubeWatchInput } from './types.js';

const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 250 * 1024 * 1024;
const WATCH_SUFFIX = '/history/watch-history.json';
const SEARCH_SUFFIX = '/history/search-history.json';

export interface YoutubeArchiveLimits {
  maxArchiveBytes?: number;
  maxUncompressedBytes?: number;
}

interface TakeoutSubtitle { name?: unknown; url?: unknown }
interface TakeoutActivity {
  header?: unknown;
  title?: unknown;
  titleUrl?: unknown;
  subtitles?: unknown;
  time?: unknown;
  products?: unknown;
  activityControls?: unknown;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function validTime(value: unknown): string | null {
  const raw = text(value);
  const date = new Date(raw);
  return raw && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

function videoIdFromUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.hostname === 'youtu.be') return url.pathname.slice(1) || null;
    if (url.hostname.endsWith('youtube.com')) return url.searchParams.get('v');
  } catch {
    return null;
  }
  return null;
}

function channelIdFromUrl(value: string): string | null {
  try {
    const match = new URL(value).pathname.match(/^\/channel\/([^/]+)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function stableId(kind: string, identity: string, time: string): string {
  return createHash('sha256').update(`${kind}\u001f${identity}\u001f${time}`).digest('hex');
}

function subtitles(value: unknown): TakeoutSubtitle[] {
  return Array.isArray(value) ? value.filter((item): item is TakeoutSubtitle => Boolean(item && typeof item === 'object')) : [];
}

export function parseWatchActivities(items: unknown[]): YoutubeWatchInput[] {
  const watches: YoutubeWatchInput[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as TakeoutActivity;
    const watchedAt = validTime(item.time);
    const rawTitle = text(item.title);
    const controls = Array.isArray(item.activityControls) ? item.activityControls.map(text) : [];
    const activityType = /^Watched\s+/i.test(rawTitle)
      ? 'video'
      : /^Viewed\s+/i.test(rawTitle) || /\/post\//.test(text(item.titleUrl))
      ? 'post'
      : 'other';
    if (!watchedAt || (!controls.includes('YouTube watch history') && activityType === 'other')) continue;
    const url = text(item.titleUrl);
    const videoId = activityType === 'video' ? videoIdFromUrl(url) : null;
    const subtitle = subtitles(item.subtitles)[0];
    const channelTitle = text(subtitle?.name) || null;
    const channelUrl = text(subtitle?.url) || null;
    const title = rawTitle.replace(/^(Watched|Viewed)\s+/i, '').trim()
      || (activityType === 'video' ? 'Unavailable video' : 'YouTube activity');
    watches.push({
      eventId: stableId('watch', videoId ?? (url || title), watchedAt),
      videoId,
      title,
      url,
      channelId: channelUrl ? channelIdFromUrl(channelUrl) : null,
      channelTitle,
      channelUrl,
      watchedAt,
      actualWatchedSeconds: null,
      activityType,
    });
  }
  return watches;
}

export function parseSearchActivities(items: unknown[], secret: string): YoutubeSearchInput[] {
  const searches: YoutubeSearchInput[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as TakeoutActivity;
    const searchedAt = validTime(item.time);
    const rawTitle = text(item.title);
    const controls = Array.isArray(item.activityControls) ? item.activityControls.map(text) : [];
    const activityType = /^Searched for\s+/i.test(rawTitle)
      ? 'search'
      : /^Visited\s+/i.test(rawTitle)
      ? 'visit'
      : 'other';
    if (!searchedAt || (!controls.includes('YouTube search history') && activityType === 'other')) continue;
    const query = rawTitle.replace(/^Searched for\s+/i, '').trim();
    if (!query) continue;
    searches.push({
      eventId: stableId('search', query, searchedAt),
      searchedAt,
      queryCiphertext: encryptPrivateValue(query, secret),
      activityType,
    });
  }
  return searches;
}

function parseJson(bytes: Uint8Array, name: string): unknown[] {
  const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`${name} must contain a JSON array`);
  return parsed;
}

function safeArchiveEntry(name: string): boolean {
  if (name.startsWith('/') || name.includes('\\') || name.split('/').includes('..')) {
    throw new Error(`Unsafe archive entry: ${name}`);
  }
  const lower = `/${name.toLocaleLowerCase('en-US')}`;
  return lower.endsWith(WATCH_SUFFIX)
    || lower.endsWith(SEARCH_SUFFIX)
    || (lower.includes('/my activity/youtube/') && lower.endsWith('.json'));
}

export function parseYoutubeArchive(
  archive: Uint8Array,
  secret: string,
  source: YoutubeParsedArchive['source'] = 'takeout',
  limits: YoutubeArchiveLimits = {},
): YoutubeParsedArchive {
  if (secret.length < 32) throw new Error('YOUTUBE_PRIVATE_DATA_KEY must contain at least 32 characters');
  const maxArchiveBytes = limits.maxArchiveBytes ?? MAX_ARCHIVE_BYTES;
  const maxUncompressedBytes = limits.maxUncompressedBytes ?? MAX_UNCOMPRESSED_BYTES;
  if (archive.byteLength > maxArchiveBytes) throw new Error('YouTube archive exceeds compressed size limit');
  let declaredBytes = 0;
  const files = unzipSync(archive, {
    filter(file: UnzipFileInfo) {
      if (!safeArchiveEntry(file.name)) return false;
      declaredBytes += file.originalSize;
      if (declaredBytes > maxUncompressedBytes) throw new Error('YouTube archive exceeds uncompressed size limit');
      return true;
    },
  });
  let watches: YoutubeWatchInput[] = [];
  let searches: YoutubeSearchInput[] = [];
  for (const [name, bytes] of Object.entries(files)) {
    const lower = `/${name.toLocaleLowerCase('en-US')}`;
    const items = parseJson(bytes, name);
    if (lower.endsWith(WATCH_SUFFIX)) watches = watches.concat(parseWatchActivities(items));
    else if (lower.endsWith(SEARCH_SUFFIX)) searches = searches.concat(parseSearchActivities(items, secret));
    else {
      watches = watches.concat(parseWatchActivities(items));
      searches = searches.concat(parseSearchActivities(items, secret));
    }
  }
  if (!watches.length && !searches.length) {
    throw new Error('Archive contains no recognized YouTube watch or search history');
  }
  return {
    archiveHash: createHash('sha256').update(archive).digest('hex'),
    source,
    watches,
    searches,
  };
}
