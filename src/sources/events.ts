import * as cheerio from 'cheerio';
import type { ActivityVisibility, MediaEntry } from '../data/types.js';

export interface EventInput {
  id?: string;
  title?: string;
  startAt?: string;
  image?: string;
  venue?: string;
  organizer?: string;
  platform?: string;
  url?: string;
  status?: 'ticketed' | 'upcoming' | 'attended';
  visibility?: ActivityVisibility;
}

const allowedHosts = new Set(['www.opentix.life', 'opentix.life', 'kktix.com', 'www.kktix.com', 'www.accupass.com', 'accupass.com']);

function jsonLdObjects(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(jsonLdObjects);
  if (!value || typeof value !== 'object') return [];
  const object = value as Record<string, unknown>;
  return [object, ...jsonLdObjects(object['@graph'])];
}

export async function enrichPublicEvent(urlText: string): Promise<Partial<EventInput>> {
  const url = new URL(urlText);
  if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname.toLowerCase())) {
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

export function normalizeEvent(input: EventInput): MediaEntry {
  if (!input.title?.trim()) throw new Error('Event title is required');
  if (!input.startAt || Number.isNaN(new Date(input.startAt).getTime())) throw new Error('Event startAt must be an ISO date/time');
  // Time passing is not proof of attendance. Only an explicit confirmation
  // may set `attended`; otherwise a past purchase remains `ticketed`.
  const status = input.status ?? (new Date(input.startAt).getTime() > Date.now() ? 'upcoming' : 'ticketed');
  const extra: Record<string, string | number> = {};
  for (const [key, value] of Object.entries({ venue: input.venue, organizer: input.organizer, platform: input.platform, url: input.url })) {
    if (value) extra[key] = value;
  }
  return {
    sourceItemId: input.id || input.url || undefined,
    visibility: input.visibility ?? 'public', source: 'events', kind: 'event',
    title: input.title.trim(), image: input.image ?? '', status,
    activityAt: new Date(input.startAt).toISOString(), rating: null, extra,
  };
}
