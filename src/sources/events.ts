import * as cheerio from 'cheerio';
import type { ActivityVisibility, MediaEntry } from '../data/types.js';

export interface EventInput {
  id?: string;
  title?: string;
  startAt?: string;
  image?: string;
  tags?: string[];
  venue?: string;
  organizer?: string;
  platform?: string;
  url?: string;
  status?: 'ticketed' | 'upcoming' | 'attended';
  visibility?: ActivityVisibility;
}

const allowedHosts = new Set(['www.opentix.life', 'opentix.life', 'kktix.com', 'www.kktix.com', 'www.accupass.com', 'accupass.com']);

export function canEnrichPublicEvent(urlText: string): boolean {
  try {
    const url = new URL(urlText);
    return url.protocol === 'https:' && allowedHosts.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function jsonLdObjects(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(jsonLdObjects);
  if (!value || typeof value !== 'object') return [];
  const object = value as Record<string, unknown>;
  return [object, ...jsonLdObjects(object['@graph'])];
}

export async function enrichPublicEvent(urlText: string): Promise<Partial<EventInput>> {
  const url = new URL(urlText);
  if (!canEnrichPublicEvent(urlText)) {
    throw new Error('Event enrichment URL must be a supported public OPENTIX, KKTIX, or Accupass page');
  }
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(12_000), headers: { 'User-Agent': 'infovore/0.1 event metadata enrichment' } });
  if (!response.ok) throw new Error(`Event page returned HTTP ${response.status}`);
  return parseEventMetadata(await response.text(), url.toString());
}

export function parseEventMetadata(source: string, urlText: string): Partial<EventInput> {
  const url = new URL(urlText);
  const $ = cheerio.load(source);
  const result: Partial<EventInput> = {
    title: $('meta[property="og:title"]').attr('content')?.trim(),
    image: $('meta[property="og:image"]').attr('content')?.trim(),
    url: url.toString(), platform: url.hostname,
  };
  $('script[type="application/ld+json"]').each((_, element) => {
    try {
      const objects = jsonLdObjects(JSON.parse($(element).text()));
      const event = objects.find((item) => String(item['@type']).toLowerCase().includes('event'));
      if (!event) return;
      result.title ||= String(event.name ?? '');
      result.startAt ||= String(event.startDate ?? '');
      result.image ||= Array.isArray(event.image) ? String(event.image[0] ?? '') : String(event.image ?? '');
      const location = event.location as Record<string, unknown> | undefined;
      result.venue ||= String(location?.name ?? '');
      const organizer = event.organizer as Record<string, unknown> | undefined;
      result.organizer ||= String(organizer?.name ?? '');
    } catch { /* ignore malformed third-party JSON-LD */ }
  });
  return result;
}

function requiredHttpsUrl(value: string | undefined, field: string): string {
  if (!value?.trim()) throw new Error(`Event ${field} is required`);
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') throw new Error();
    return url.toString();
  } catch {
    throw new Error(`Event ${field} must be a public HTTPS URL`);
  }
}

function normalizeStartAt(value: string | undefined): string {
  if (!value) throw new Error('Event startAt must be an ISO date or date/time');
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
      throw new Error('Event startAt must be an ISO date or date/time');
    }
    return value;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error('Event startAt must be an ISO date or date/time');
  return parsed.toISOString();
}

function isFuture(startAt: string): boolean {
  const comparison = /^\d{4}-\d{2}-\d{2}$/.test(startAt)
    ? new Date(`${startAt}T23:59:59+08:00`).getTime()
    : new Date(startAt).getTime();
  return comparison > Date.now();
}

export function normalizeEvent(input: EventInput): MediaEntry {
  if (!input.title?.trim()) throw new Error('Event title is required');
  const activityAt = normalizeStartAt(input.startAt);
  const image = requiredHttpsUrl(input.image, 'image');
  const url = input.url ? requiredHttpsUrl(input.url, 'url') : undefined;
  const tags = [...new Set((input.tags ?? []).map((tag) => tag.trim()).filter(Boolean))];
  if (tags.length > 12 || tags.some((tag) => tag.length > 40)) {
    throw new Error('Event tags must contain at most 12 labels of 40 characters each');
  }
  // Time passing is not proof of attendance. Only an explicit confirmation
  // may set `attended`; otherwise a past purchase remains `ticketed`.
  const status = input.status ?? (isFuture(activityAt) ? 'upcoming' : 'ticketed');
  const extra: MediaEntry['extra'] = {};
  for (const [key, value] of Object.entries({ venue: input.venue, organizer: input.organizer, platform: input.platform, url })) {
    if (value) extra[key] = value;
  }
  if (tags.length) extra.tags = tags;
  return {
    sourceItemId: input.id || url || undefined,
    visibility: input.visibility ?? 'public', source: 'events', kind: 'event',
    title: input.title.trim(), image, status,
    activityAt, rating: null, extra,
  };
}
