import { h, logo, toDataUri, truncate, timeAgo, renderCard } from './render.js';
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

async function buildSimklCard(
  data: SimklStats,
  kind: 'movies' | 'shows'
): Promise<string> {
  const items = kind === 'movies' ? data.recentMovies : data.recentShows;
  const sectionTitle = kind === 'movies' ? 'Recently Watched Movies' : 'Recently Watched TV';
  const stats =
    kind === 'movies'
      ? `${data.moviesCompleted} movies watched`
      : `${data.showsWatching} watching · ${data.showsCompleted} completed`;

  const [avatar, mark, ...posters] = await Promise.all([
    toDataUri(data.avatar),
    Promise.resolve(logo('simkl')),
    ...items.map((it) => toDataUri(it.poster)),
  ]);

  const detail = (it: SimklItem): string => {
    if (kind === 'shows' && it.watchedEpisodes && it.totalEpisodes) {
      return `${it.watchedEpisodes}/${it.totalEpisodes} eps`;
    }
    return it.year ? String(it.year) : '';
  };

  const tiles = items.map((it, i) =>
    h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', width: 84, marginRight: i < 4 ? 12 : 0 } },
      posters[i]
        ? h('img', { src: posters[i], width: 84, height: 118, style: { borderRadius: 4, objectFit: 'cover' } })
        : h('div', { style: { width: 84, height: 118, backgroundColor: C.panel, borderRadius: 4, display: 'flex' } }),
      h('span', { style: { fontSize: 11, fontWeight: 700, color: C.text, marginTop: 6, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' } }, truncate(it.title, 14)),
      h('span', { style: { fontSize: 10, color: C.accent, marginTop: 2 } }, timeAgo(it.watchedAt)),
      h('span', { style: { fontSize: 10, color: C.dim, marginTop: 1 } }, detail(it))
    )
  );

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
      h('img', { src: mark, width: 26, height: 26, style: { borderRadius: 6, marginRight: 8 } }),
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
    h(
      'div',
      { style: { display: 'flex', alignItems: 'baseline', marginBottom: 10 } },
      h('span', { style: { fontSize: 15, fontWeight: 700, color: C.text } }, sectionTitle),
      h('span', { style: { fontSize: 11, color: C.dim, marginLeft: 10 } }, stats)
    ),
    h('div', { style: { display: 'flex' } }, ...tiles)
  );

  return renderCard(node, 520, 268);
}

export const buildSimklMoviesCard = (d: SimklStats) => buildSimklCard(d, 'movies');
export const buildSimklShowsCard = (d: SimklStats) => buildSimklCard(d, 'shows');
