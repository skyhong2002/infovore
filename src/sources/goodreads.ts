import { config } from '../config.js';
import type { MediaEntry, SourceSnapshot } from '../data/types.js';

async function getText(url: string, attempt = 0): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': config.userAgent },
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) throw new Error(`goodreads: HTTP ${res.status} for ${url}`);
    return res.text();
  } catch (err) {
    // Goodreads occasionally stalls a request from datacenter IPs; one retry
    // clears the transient timeout that would otherwise blank the card.
    if (attempt < 1) {
      await new Promise((r) => setTimeout(r, 2000));
      return getText(url, attempt + 1);
    }
    throw err;
  }
}

function field(item: string, tag: string): string {
  const m = item.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`));
  return m ? m[1].trim() : '';
}

export function parseGoodreadsRss(xml: string, limit: number, status: 'reading' | 'read'): MediaEntry[] {
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
  return items.slice(0, limit).map((it) => {
    const rating = Number(field(it, 'user_rating'));
    const readAt = field(it, 'user_read_at') || field(it, 'pubDate');
    return {
      sourceItemId: field(it, 'book_id') || field(it, 'guid'),
      source: 'goodreads',
      kind: 'book',
      title: field(it, 'title'),
      image: field(it, 'book_large_image_url') || field(it, 'book_medium_image_url'),
      status,
      activityAt: readAt ? new Date(readAt).toISOString() : '',
      rating: rating > 0 ? { value: rating, scale: 5 } : null,
      extra: { author: field(it, 'author_name') },
    };
  });
}

export async function fetchGoodreads(): Promise<SourceSnapshot> {
  const { userId } = config.goodreads;
  const [profileHtml, readXml, currentXml] = await Promise.all([
    getText(`https://www.goodreads.com/user/show/${userId}`),
    getText(`https://www.goodreads.com/review/list_rss/${userId}?shelf=read`),
    getText(`https://www.goodreads.com/review/list_rss/${userId}?shelf=currently-reading`),
  ]);

  const avatar = profileHtml.match(/<img[^>]*src="(https:\/\/images\.gr-assets\.com\/users\/[^"]+)"/)?.[1] ?? '';
  const name = profileHtml.match(/<h1[^>]*>([^<]+)<\/h1>/)?.[1].trim() ?? 'Goodreads';
  const shelfCount = (shelf: string): number => {
    const m = profileHtml.match(new RegExp(`shelf=${shelf}[^>]*>[^(]*\\((\\d+)\\)`));
    return m ? Number(m[1]) : 0;
  };

  return {
    source: 'goodreads',
    profile: {
      id: userId,
      name,
      avatar,
      url: `https://www.goodreads.com/user/show/${userId}`,
    },
    stats: {
      readCount: shelfCount('read'),
      currentlyReadingCount: shelfCount('currently-reading'),
      toReadCount: shelfCount('to-read'),
    },
    entries: [...parseGoodreadsRss(currentXml, 2, 'reading'), ...parseGoodreadsRss(readXml, 5, 'read')],
    extra: {},
  };
}
