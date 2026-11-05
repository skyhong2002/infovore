import { config } from '../config.js';
import type { MediaEntry, SourceSnapshot } from '../data/types.js';

// Hardcover's GraphQL API (https://docs.hardcover.app/api/getting-started/).
// The token belongs to the account being shown; `me` resolves to that user.
const API = 'https://api.hardcover.app/v1/graphql';

const QUERY = `{
  me {
    username
    name
    image { url }
    user_books(order_by: { updated_at: desc }, limit: 500) {
      id
      status_id
      rating
      date_added
      last_read_date
      book {
        id
        slug
        title
        pages
        image { url }
        contributions { author { name } }
      }
      edition { title pages image { url } }
      user_book_reads(order_by: { id: desc }) { started_at finished_at }
    }
  }
}`;

// Hardcover's user_book_statuses, mapped to the labels the rest of infovore
// already understands (see src/data/status.ts). 6 = "Ignored" is skipped.
const STATUS: Record<number, string> = { 1: 'to-read', 2: 'reading', 3: 'read', 4: 'paused', 5: 'dnf' };

interface HardcoverRead { started_at: string | null; finished_at: string | null }
export interface HardcoverUserBook {
  id: number;
  status_id: number;
  rating: number | null;
  date_added: string | null;
  last_read_date: string | null;
  book: {
    id: number;
    slug: string;
    title: string;
    pages: number | null;
    image: { url: string } | null;
    contributions: { author: { name: string } | null }[];
  };
  edition: { title: string | null; pages: number | null; image: { url: string } | null } | null;
  user_book_reads: HardcoverRead[];
}

function firstDate(...values: (string | null | undefined)[]): string {
  return values.find((v) => v) ?? '';
}

export function parseHardcoverBooks(books: HardcoverUserBook[]): MediaEntry[] {
  const entries: MediaEntry[] = [];
  for (const ub of books) {
    const status = STATUS[ub.status_id];
    if (!status) continue;
    const read = ub.user_book_reads.find((r) => r.finished_at) ?? null;
    const started = ub.user_book_reads.find((r) => r.started_at) ?? null;
    // Finished books are dated by when they were finished, in-progress ones by
    // when they were started, and the queue by when the book was shelved.
    const activityAt = status === 'read'
      ? firstDate(read?.finished_at, ub.last_read_date, ub.date_added)
      : status === 'reading'
      ? firstDate(started?.started_at, ub.date_added)
      : firstDate(ub.date_added);
    const pages = ub.edition?.pages || ub.book.pages || 0;
    const authors = ub.book.contributions.map((c) => c.author?.name).filter(Boolean);
    const extra: MediaEntry['extra'] = { author: authors[0] ?? '', url: `https://hardcover.app/books/${ub.book.slug}` };
    // Page count feeds the reading-time estimate in Repository.timeSpent().
    if (pages > 0) extra.pages = pages;
    entries.push({
      sourceItemId: String(ub.book.id),
      source: 'hardcover',
      kind: 'book',
      title: ub.edition?.title || ub.book.title,
      image: ub.edition?.image?.url || ub.book.image?.url || '',
      status,
      activityAt,
      rating: ub.rating && ub.rating > 0 ? { value: ub.rating, scale: 5 } : null,
      extra,
    });
  }
  const byDate = (a: MediaEntry, b: MediaEntry) => (Date.parse(b.activityAt) || 0) - (Date.parse(a.activityAt) || 0);
  return entries.sort(byDate);
}

export async function fetchHardcover(): Promise<SourceSnapshot> {
  const { token } = config.hardcover;
  if (!token) throw new Error('hardcover: HARDCOVER_TOKEN is not set');
  const res = await fetch(API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'infovore (+https://github.com/skyhong2002/infovore)',
      // The token page shows it with or without the scheme; accept both.
      Authorization: token.startsWith('Bearer ') ? token : `Bearer ${token}`,
    },
    body: JSON.stringify({ query: QUERY }),
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`hardcover: HTTP ${res.status}`);
  const body = await res.json() as { data?: { me?: any[] }; errors?: { message: string }[] };
  if (body.errors?.length) throw new Error(`hardcover: ${body.errors.map((e) => e.message).join('; ')}`);
  const me = body.data?.me?.[0];
  if (!me) throw new Error('hardcover: token did not resolve to a user');

  const entries = parseHardcoverBooks(me.user_books ?? []);
  const count = (status: string) => entries.filter((e) => e.status === status).length;
  const reading = entries.filter((e) => e.status === 'reading');
  const read = entries.filter((e) => e.status === 'read');
  const queued = entries.filter((e) => e.status === 'to-read');

  return {
    source: 'hardcover',
    profile: {
      id: me.username,
      name: me.name || me.username,
      avatar: me.image?.url ?? '',
      url: `https://hardcover.app/@${me.username}`,
    },
    stats: {
      readCount: count('read'),
      currentlyReadingCount: reading.length,
      toReadCount: queued.length,
    },
    // Same budget the Goodreads feeds had: 20 reading, 100 read, 20 queued.
    entries: [...reading.slice(0, 20), ...read.slice(0, 100), ...queued.slice(0, 20)],
    extra: {},
  };
}
