import { h, logo, toDataUri, truncate, timeAgo, renderCard, textFont } from './render.js';
import type { SimklStats, SimklItem } from '../fetchers/simkl.js';

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

function detail(it: SimklItem, kind: 'movies' | 'shows'): string {
  if (kind === 'shows' && it.watchedEpisodes && it.totalEpisodes) {
    return `${it.watchedEpisodes}/${it.totalEpisodes} eps`;
  }
  return it.year ? String(it.year) : '';
}

function tile(it: SimklItem, poster: string, kind: 'movies' | 'shows', last: boolean) {
  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', width: 84, marginRight: last ? 0 : 12 } },
    poster
      ? h('img', { src: poster, width: 84, height: 118, style: { borderRadius: 4, objectFit: 'cover' } })
      : h('div', { style: { width: 84, height: 118, backgroundColor: C.panel, borderRadius: 4, display: 'flex' } }),
    h('span', { style: { fontSize: 11, fontWeight: 700, color: C.text, marginTop: 6, lineHeight: 1.25, wordBreak: 'break-word', fontFamily: textFont(it.title, 'Roboto') } }, it.title),
    h(
      'div',
      { style: { display: 'flex', alignItems: 'baseline', marginTop: 2 } },
      h('span', { style: { fontSize: 10, color: C.accent } }, timeAgo(it.watchedAt)),
      it.rating !== null
        ? h('span', { style: { fontSize: 10, fontWeight: 700, color: '#e9b873', marginLeft: 5 } }, `★ ${it.rating}`)
        : h('div', { style: { display: 'flex' } })
    ),
    h('span', { style: { fontSize: 10, color: C.dim, marginTop: 1 } }, detail(it, kind))
  );
}

function tileRows(items: SimklItem[], posters: string[], kind: 'movies' | 'shows') {
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

function shell(data: SimklStats, avatar: string, mark: string, body: Record<string, unknown>[], height: number) {
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
        h('span', { style: { fontSize: 14, fontWeight: 700, color: C.text } }, data.name)
      )
    ),
    ...body
  );
  return renderCard(node, 520, height);
}

function showsSub(data: SimklStats): string {
  return `${data.showsWatching} watching · ${data.showsCompleted} completed`;
}
function moviesSub(data: SimklStats): string {
  return `${data.moviesCompleted} movies watched`;
}

async function postersFor(items: SimklItem[]): Promise<string[]> {
  return Promise.all(items.map((it) => toDataUri(it.poster)));
}

// Single-medium card: 10 recent items in two rows.
async function buildSingle(data: SimklStats, kind: 'movies' | 'shows'): Promise<string> {
  const items = (kind === 'movies' ? data.recentMovies : data.recentShows).slice(0, 10);
  const [avatar, mark, posters] = await Promise.all([
    toDataUri(data.avatar),
    Promise.resolve(logo('simkl')),
    postersFor(items),
  ]);
  const rows = Math.max(1, Math.ceil(items.length / 5));
  const body = [
    sectionHeader(
      kind === 'movies' ? 'Recently Watched Movies' : 'Recently Watched TV',
      kind === 'movies' ? moviesSub(data) : showsSub(data)
    ),
    ...tileRows(items, posters, kind),
  ];
  return shell(data, avatar, mark, body, 118 + rows * ROW_H + (rows - 1) * 12);
}

// Combined card: 5 recent shows + 5 recent movies.
async function buildBoth(data: SimklStats): Promise<string> {
  const shows = data.recentShows.slice(0, 5);
  const movies = data.recentMovies.slice(0, 5);
  const [avatar, mark, showPosters, moviePosters] = await Promise.all([
    toDataUri(data.avatar),
    Promise.resolve(logo('simkl')),
    postersFor(shows),
    postersFor(movies),
  ]);
  const body = [
    sectionHeader('Recently Watched TV', showsSub(data)),
    ...tileRows(shows, showPosters, 'shows'),
    h('div', { style: { display: 'flex', marginTop: 16 } }),
    sectionHeader('Recently Watched Movies', moviesSub(data)),
    ...tileRows(movies, moviePosters, 'movies'),
  ];
  return shell(data, avatar, mark, body, 118 + 2 * (ROW_H + 26) + 16);
}

export const buildSimklCard = (d: SimklStats) => buildBoth(d);
export const buildSimklMoviesCard = (d: SimklStats) => buildSingle(d, 'movies');
export const buildSimklShowsCard = (d: SimklStats) => buildSingle(d, 'shows');
