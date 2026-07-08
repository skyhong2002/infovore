import { config } from '../config.js';

export interface GoodreadsBook {
  title: string;
  author: string;
  cover: string;
  rating: number | null; // user rating out of 5
  readAt: string; // ISO-ish date or ''
}

export interface GoodreadsStats {
  userId: string;
  name: string;
  avatar: string;
  readCount: number;
  currentlyReadingCount: number;
  toReadCount: number;
  currentlyReading: GoodreadsBook[];
  recentlyRead: GoodreadsBook[];
}

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

function parseRss(xml: string, limit: number): GoodreadsBook[] {
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
  return items.slice(0, limit).map((it) => {
    const rating = Number(field(it, 'user_rating'));
    const readAt = field(it, 'user_read_at') || field(it, 'pubDate');
    return {
      title: field(it, 'title'),
      author: field(it, 'author_name'),
      cover: field(it, 'book_large_image_url') || field(it, 'book_medium_image_url'),
      rating: rating > 0 ? rating : null,
      readAt: readAt ? new Date(readAt).toISOString() : '',
    };
  });
}

export async function fetchGoodreads(): Promise<GoodreadsStats> {
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
    userId,
    name,
    avatar,
    readCount: shelfCount('read'),
    currentlyReadingCount: shelfCount('currently-reading'),
    toReadCount: shelfCount('to-read'),
    currentlyReading: parseRss(currentXml, 2),
    recentlyRead: parseRss(readXml, 5),
  };
}
