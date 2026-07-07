import { h, logo, toDataUri, truncate, timeAgo, renderCard } from './render.js';
import type { KitsuStats, KitsuEntry } from '../fetchers/kitsu.js';

// Kitsu's dark UI: deep aubergine background with their signature
// orange-red, Open Sans typography.
const C = {
  bg: '#1c1522',
  panel: '#2a2130',
  text: '#f5f0f5',
  dim: '#a89aa8',
  accent: '#f75239',
  border: '#3a2b3e',
};

function statusLabel(e: KitsuEntry, unit: 'Ep' | 'Ch'): string {
  if (e.status === 'completed') return 'Completed';
  if (e.status === 'planned' || e.progress === 0) return 'Planned';
  if (e.status === 'on_hold') return 'On Hold';
  if (e.status === 'dropped') return 'Dropped';
  return `${unit} ${e.progress}`;
}

async function buildKitsuCard(
  data: KitsuStats,
  kind: 'anime' | 'manga'
): Promise<string> {
  const section = kind === 'anime' ? data.anime : data.manga;
  const unit = kind === 'anime' ? 'Ep' : 'Ch';
  const sectionTitle = kind === 'anime' ? 'Recent Anime' : 'Recent Manga';

  const [avatar, mark, ...posters] = await Promise.all([
    toDataUri(data.avatar),
    Promise.resolve(logo('kitsu')),
    ...section.recent.map((e) => toDataUri(e.poster)),
  ]);

  const tiles = section.recent.map((e, i) =>
    h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', width: 84, marginRight: i < 4 ? 12 : 0 } },
      posters[i]
        ? h('img', {
            src: posters[i],
            width: 84,
            height: 118,
            style: { borderRadius: 6, objectFit: 'cover' },
          })
        : h('div', { style: { width: 84, height: 118, backgroundColor: C.panel, borderRadius: 6, display: 'flex' } }),
      h('span', { style: { fontSize: 11, fontWeight: 700, color: C.text, marginTop: 6, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' } }, truncate(e.title, 14)),
      h('span', { style: { fontSize: 10, color: C.accent, marginTop: 2 } }, statusLabel(e, unit)),
      h(
        'div',
        { style: { display: 'flex', marginTop: 1 } },
        h('span', { style: { fontSize: 10, color: C.dim } }, timeAgo(e.progressedAt)),
        e.rating !== null
          ? h('span', { style: { fontSize: 10, fontWeight: 700, color: '#e9b873', marginLeft: 5 } }, `★${Math.round(e.rating * 10) / 10}`)
          : h('div', { style: { display: 'flex' } })
      )
    )
  );

  const stats =
    kind === 'anime'
      ? `${section.completed} completed · ${data.anime.episodes} episodes · ${data.anime.hours}h watched`
      : `${section.completed} completed · ${data.manga.chapters} chapters read`;

  const node = h(
    'div',
    {
      style: {
        width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
        backgroundColor: C.bg, borderRadius: 10, border: `1px solid ${C.border}`,
        padding: '20px 24px', fontFamily: 'Open Sans',
      },
    },
    h(
      'div',
      { style: { display: 'flex', alignItems: 'center', marginBottom: 14 } },
      h('img', { src: mark, width: 28, height: 28, style: { marginRight: 8 } }),
      h('span', { style: { fontSize: 18, fontWeight: 700, color: C.accent } }, 'Kitsu'),
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

  return renderCard(node, 520, 290);
}

export const buildKitsuAnimeCard = (d: KitsuStats) => buildKitsuCard(d, 'anime');
export const buildKitsuMangaCard = (d: KitsuStats) => buildKitsuCard(d, 'manga');
