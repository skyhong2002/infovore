import { h, logo, toDataUri, timeAgo, renderCard, textFont, titleFontSize, MAX_TITLE_LINES } from './render.js';
import type { SourceSnapshot, MediaEntry } from '../data/types.js';

// Simkl's dark UI: charcoal background with their sky-blue accent,
// system-sans typography (Roboto stands in).
const C = {
  bg: '#0f1214',
  panel: '#1a2026',
  text: '#eef2f4',
  dim: '#8b979e',
  accent: '#00b9ff',
  border: '#232a2f',
};

const ROW_H = 178; // poster 118 + three text lines

function detail(it: MediaEntry, kind: 'movies' | 'shows'): string {
  if (kind === 'shows' && it.extra.watchedEpisodes && it.extra.totalEpisodes) {
    return `${it.extra.watchedEpisodes}/${it.extra.totalEpisodes} eps`;
  }
  return it.extra.year ? String(it.extra.year) : '';
}

function tile(it: MediaEntry, poster: string, kind: 'movies' | 'shows', last: boolean) {
  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', width: 84, marginRight: last ? 0 : 12 } },
    poster
      ? h('img', { src: poster, width: 84, height: 118, style: { borderRadius: 4, objectFit: 'cover' } })
      : h('div', { style: { width: 84, height: 118, backgroundColor: C.panel, borderRadius: 4, display: 'flex' } }),
    h('span', { style: { fontSize: titleFontSize(it.title), fontWeight: 700, color: C.text, marginTop: 6, lineHeight: 1.25, wordBreak: 'break-word', display: 'block', lineClamp: MAX_TITLE_LINES, fontFamily: textFont(it.title, 'Roboto') } }, it.title),
    h(
      'div',
      { style: { display: 'flex', alignItems: 'baseline', marginTop: 2 } },
      h('span', { style: { fontSize: 10, color: C.accent } }, timeAgo(it.activityAt)),
      it.rating !== null
        ? h('span', { style: { fontSize: 10, fontWeight: 700, color: '#e9b873', marginLeft: 5 } }, `★ ${it.rating.value}`)
        : h('div', { style: { display: 'flex' } })
    ),
    h('span', { style: { fontSize: 10, color: C.dim, marginTop: 1 } }, detail(it, kind))
  );
}

function tileRows(items: MediaEntry[], posters: string[], kind: 'movies' | 'shows') {
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < items.length; i += 5) {
    rows.push(
      h(
        'div',
        { style: { display: 'flex', marginTop: i === 0 ? 0 : 12 } },
        ...items.slice(i, i + 5).map((it, j) => tile(it, posters[i + j], kind, j === 4))
      )
    );
  }
  return rows;
}

function sectionHeader(title: string, sub: string) {
  return h(
    'div',
    { style: { display: 'flex', alignItems: 'baseline', marginBottom: 10 } },
    h('span', { style: { fontSize: 15, fontWeight: 700, color: C.text } }, title),
    h('span', { style: { fontSize: 11, color: C.dim, marginLeft: 10 } }, sub)
  );
}

function shell(name: string, avatar: string, mark: string, body: Record<string, unknown>[], height: number) {
  const node = h(
    'div',
    {
      style: {
        width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
        backgroundColor: C.bg, borderRadius: 10, border: `1px solid ${C.border}`,
        padding: '20px 24px', fontFamily: 'Roboto',
      },
    },
    h(
      'div',
      { style: { display: 'flex', alignItems: 'center', marginBottom: 14 } },
      h(
        'div',
        { style: { display: 'flex', backgroundColor: '#ffffff', borderRadius: 6, padding: 3, marginRight: 8 } },
        h('img', { src: mark, width: 22, height: 22, style: { borderRadius: 4 } })
      ),
      h('span', { style: { fontSize: 18, fontWeight: 700, color: C.text } }, 'Simkl'),
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', marginLeft: 'auto' } },
        avatar
          ? h('img', { src: avatar, width: 30, height: 30, style: { borderRadius: 15, marginRight: 8 } })
          : h('div', { style: { display: 'flex' } }),
        h('span', { style: { fontSize: 14, fontWeight: 700, color: C.text } }, name)
      )
    ),
    ...body
  );
  return renderCard(node, 520, height);
}

function showsSub(stats: Record<string, number>): string {
  return `${stats.showsWatching} watching · ${stats.showsCompleted} completed`;
}
function moviesSub(stats: Record<string, number>): string {
  return `${stats.moviesCompleted} movies watched`;
}

async function postersFor(items: MediaEntry[]): Promise<string[]> {
  return Promise.all(items.map((it) => toDataUri(it.image)));
}

// Single-medium card: 10 recent items in two rows.
async function buildSingle(data: SourceSnapshot, kind: 'movies' | 'shows'): Promise<string> {
  const entryKind = kind === 'movies' ? 'movie' : 'show';
  const items = data.entries.filter((e) => e.kind === entryKind).slice(0, 10);
  const [avatar, mark, posters] = await Promise.all([
    toDataUri(data.profile.avatar),
    Promise.resolve(logo('simkl')),
    postersFor(items),
  ]);
  const rows = Math.max(1, Math.ceil(items.length / 5));
  const body = [
    sectionHeader(
      kind === 'movies' ? 'Recently Watched Movies' : 'Recently Watched TV & Anime',
      kind === 'movies' ? moviesSub(data.stats) : showsSub(data.stats)
    ),
    ...tileRows(items, posters, kind),
  ];
  return shell(data.profile.name, avatar, mark, body, 118 + rows * ROW_H + (rows - 1) * 12);
}

// Combined card: 5 recent shows + 5 recent movies.
async function buildBoth(data: SourceSnapshot): Promise<string> {
  const shows = data.entries.filter((e) => e.kind === 'show').slice(0, 5);
  const movies = data.entries.filter((e) => e.kind === 'movie').slice(0, 5);
  const [avatar, mark, showPosters, moviePosters] = await Promise.all([
    toDataUri(data.profile.avatar),
    Promise.resolve(logo('simkl')),
    postersFor(shows),
    postersFor(movies),
  ]);
  const body = [
    sectionHeader('Recently Watched TV & Anime', showsSub(data.stats)),
    ...tileRows(shows, showPosters, 'shows'),
    h('div', { style: { display: 'flex', marginTop: 16 } }),
    sectionHeader('Recently Watched Movies', moviesSub(data.stats)),
    ...tileRows(movies, moviePosters, 'movies'),
  ];
  return shell(data.profile.name, avatar, mark, body, 118 + 2 * (ROW_H + 26) + 16);
}

export const buildSimklCard = (d: SourceSnapshot) => buildBoth(d);
export const buildSimklMoviesCard = (d: SourceSnapshot) => buildSingle(d, 'movies');
export const buildSimklShowsCard = (d: SourceSnapshot) => buildSingle(d, 'shows');
