import type { YoutubeKeyword } from './types.js';

const STOP_WORDS = new Set([
  'about', 'after', 'again', 'also', 'and', 'are', 'but', 'can', 'for', 'from',
  'at', 'by', 'how', 'in', 'into', 'is', 'it', 'its', 'new', 'not', 'now', 'of', 'on', 'or', 'our', 'out',
  'the', 'this', 'to', 'video', 'what', 'when', 'why', 'with', 'you', 'your',
  '一個', '一起', '以及', '什麼', '今天', '可以', '如何', '就是', '我們', '我的',
  '這個', '這些', 'その', 'これ', 'して', 'する', 'です', 'ます', 'から', 'まで',
  'youtube', 'official', 'episode', 'part', 'shorts',
]);

function normalize(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, '');
}

function tokens(value: string): string[] {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
  const withoutUrls = value.replace(/(?:https?:\/\/|www\.)\S+/giu, ' ');
  return [...segmenter.segment(withoutUrls)]
    .filter((segment) => segment.isWordLike)
    .map((segment) => normalize(segment.segment))
    .filter((token) => token && token.length <= 40 && !STOP_WORDS.has(token) && !/^\d+$/.test(token));
}

function termsForVideo(row: { title: string; description: string | null; tags_json: string | null }): Set<string> {
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(row.tags_json ?? '[]');
    if (Array.isArray(parsed)) tags = parsed.filter((value): value is string => typeof value === 'string');
  } catch {
    tags = [];
  }
  const titleTokens = tokens(row.title);
  const tokenizedTags = tags.map(tokens);
  const tagTokens = tokenizedTags.flat();
  const descriptionTokens = tokens((row.description ?? '').slice(0, 600));
  const base = [...titleTokens, ...tagTokens, ...descriptionTokens];
  const phrases = [titleTokens, ...tokenizedTags].flatMap((list) =>
    list.slice(0, 40).flatMap((token, index) =>
      index + 1 < list.length ? [`${token} ${list[index + 1]}`] : []
    )
  );
  return new Set([...base, ...phrases].filter((term) => term.length >= 2));
}

export function extractYoutubeKeywords(
  rows: Array<{ title: string; description: string | null; tags_json: string | null }>,
  limit = 16,
): YoutubeKeyword[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const term of termsForVideo(row)) counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  const total = Math.max(1, rows.length);
  const minimumVideos = total >= 10 ? 2 : 1;
  return [...counts.entries()]
    .filter(([, videos]) => videos >= minimumVideos)
    .map(([term, videos]) => ({
      term,
      videos,
      score: Math.round(videos * (term.includes(' ') ? 1.25 : 1) * 1000 / total) / 1000,
    }))
    .sort((a, b) => b.score - a.score || b.videos - a.videos || a.term.localeCompare(b.term))
    .slice(0, limit);
}
