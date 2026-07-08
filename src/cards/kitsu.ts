import { h, logo, toDataUri, truncate, timeAgo, renderCard, textFont } from './render.js';
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

const ROW_H = 178; // poster 118 + three text lines

function statusLabel(e: KitsuEntry, unit: 'Ep' | 'Ch'): string {
  if (e.status === 'completed') return 'Completed';
  if (e.status === 'on_hold') return 'On Hold';
  if (e.status === 'dropped') return 'Dropped';
  return `${unit} ${e.progress}`;
}

function tile(e: KitsuEntry, poster: string, unit: 'Ep' | 'Ch', last: boolean) {
  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', width: 84, marginRight: last ? 0 : 12 } },
    poster
      ? h('img', { src: poster, width: 84, height: 118, style: { borderRadius: 6, objectFit: 'cover' } })
      : h('div', { style: { width: 84, height: 118, backgroundColor: C.panel, borderRadius: 6, display: 'flex' } }),
    h('span', { style: { fontSize: 11, fontWeight: 700, color: C.text, marginTop: 6, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden', fontFamily: textFont(e.title, 'Open Sans') } }, truncate(e.title, 14)),
    h('span', { style: { fontSize: 10, color: C.accent, marginTop: 2 } }, statusLabel(e, unit)),
    h(
      'div',
      { style: { display: 'flex', alignItems: 'baseline', marginTop: 1 } },
      h('span', { style: { fontSize: 10, color: C.dim } }, timeAgo(e.progressedAt)),
      e.rating !== null
        ? h('span', { style: { fontSize: 10, fontWeight: 700, color: '#e9b873', marginLeft: 5 } }, `★ ${Math.round(e.rating * 10) / 10}`)
        : h('div', { style: { display: 'flex' } })
    )
  );
}

function tileRows(entries: KitsuEntry[], posters: string[], unit: 'Ep' | 'Ch') {
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < entries.length; i += 5) {
    rows.push(
      h(
        'div',
        { style: { display: 'flex', marginTop: i === 0 ? 0 : 12 } },
        ...entries.slice(i, i + 5).map((e, j) => tile(e, posters[i + j], unit, j === 4))
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

function shell(data: KitsuStats, avatar: string, mark: string, body: Record<string, unknown>[], height: number) {
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
    ...body
  );
  return renderCard(node, 520, height);
}

function animeSub(data: KitsuStats): string {
  return `${data.anime.completed} completed · ${data.anime.episodes} episodes · ${data.anime.hours}h watched`;
}
function mangaSub(data: KitsuStats): string {
  return `${data.manga.completed} completed · ${data.manga.chapters} chapters read`;
}

async function postersFor(entries: KitsuEntry[]): Promise<string[]> {
  return Promise.all(entries.map((e) => toDataUri(e.poster)));
}

// Single-medium card: 10 recent entries in two rows.
async function buildSingle(data: KitsuStats, kind: 'anime' | 'manga'): Promise<string> {
  const section = kind === 'anime' ? data.anime : data.manga;
  const entries = section.recent.slice(0, 10);
  const [avatar, mark, posters] = await Promise.all([
    toDataUri(data.avatar),
    Promise.resolve(logo('kitsu')),
    postersFor(entries),
  ]);
  const rows = Math.max(1, Math.ceil(entries.length / 5));
  const body = [
    sectionHeader(kind === 'anime' ? 'Recent Anime' : 'Recent Manga', kind === 'anime' ? animeSub(data) : mangaSub(data)),
    ...tileRows(entries, posters, kind === 'anime' ? 'Ep' : 'Ch'),
  ];
  return shell(data, avatar, mark, body, 118 + rows * ROW_H + (rows - 1) * 12);
}

// Combined card: 5 recent anime + 5 recent manga.
async function buildBoth(data: KitsuStats): Promise<string> {
  const anime = data.anime.recent.slice(0, 5);
  const manga = data.manga.recent.slice(0, 5);
  const [avatar, mark, animePosters, mangaPosters] = await Promise.all([
    toDataUri(data.avatar),
    Promise.resolve(logo('kitsu')),
    postersFor(anime),
    postersFor(manga),
  ]);
  const body = [
    sectionHeader('Recent Anime', animeSub(data)),
    ...tileRows(anime, animePosters, 'Ep'),
    h('div', { style: { display: 'flex', marginTop: 16 } }),
    sectionHeader('Recent Manga', mangaSub(data)),
    ...tileRows(manga, mangaPosters, 'Ch'),
  ];
  return shell(data, avatar, mark, body, 118 + 2 * (ROW_H + 26) + 16);
}

export const buildKitsuCard = (d: KitsuStats) => buildBoth(d);
export const buildKitsuAnimeCard = (d: KitsuStats) => buildSingle(d, 'anime');
export const buildKitsuMangaCard = (d: KitsuStats) => buildSingle(d, 'manga');
