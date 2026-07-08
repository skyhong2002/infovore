import { h, logo, toDataUri, truncate, textFont, renderCard, titleFontSize, MAX_TITLE_LINES } from './render.js';
import type { SourceSnapshot } from '../data/types.js';
import type { StatsfmAlbum, StatsfmArtist, StatsfmExtra } from '../sources/statsfm.js';

// stats.fm's app UI: near-black background, soft dark panels, Spotify
// green, uppercase gray section labels, their own Statsfm Sans typeface.
const C = {
  bg: '#111112',
  panel: '#1c1c1f',
  text: '#ffffff',
  dim: '#9a9aa0',
  accent: '#1ed761',
  border: '#26262b',
};

const ALBUM_ROW_H = 140; // 84 cover + three text lines
const ARTIST_ROW_H = 140; // 84 avatar + two text lines, same footprint as an album tile

function albumTile(a: StatsfmAlbum, img: string, rank: number, last: boolean) {
  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', width: 84, marginRight: last ? 0 : 12 } },
    img
      ? h('img', { src: img, width: 84, height: 84, style: { borderRadius: 8, objectFit: 'cover' } })
      : h('div', { style: { width: 84, height: 84, backgroundColor: C.panel, borderRadius: 8, display: 'flex' } }),
    h(
      'div',
      { style: { display: 'flex', alignItems: 'baseline', marginTop: 6 } },
      h('span', { style: { fontSize: 12, fontWeight: 700, color: C.accent } }, `#${rank}`),
      h('span', { style: { fontSize: 10, color: C.dim, marginLeft: 5 } }, `${a.streams} streams`)
    ),
    h('span', { style: { fontSize: titleFontSize(a.name), fontWeight: 700, color: C.text, marginTop: 2, lineHeight: 1.25, wordBreak: 'break-word', display: 'block', lineClamp: MAX_TITLE_LINES, fontFamily: textFont(a.name, 'Statsfm Sans') } }, a.name),
    h('span', { style: { fontSize: 10, color: C.dim, marginTop: 1, fontFamily: textFont(a.artist, 'Statsfm Sans'), whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' } }, truncate(a.artist, 15))
  );
}

function artistTile(a: StatsfmArtist, img: string, rank: number, last: boolean) {
  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', width: 84, marginRight: last ? 0 : 12 } },
    img
      ? h('img', { src: img, width: 84, height: 84, style: { borderRadius: 42, objectFit: 'cover' } })
      : h('div', { style: { width: 84, height: 84, backgroundColor: C.panel, borderRadius: 42, display: 'flex' } }),
    h(
      'div',
      { style: { display: 'flex', alignItems: 'baseline', marginTop: 6 } },
      h('span', { style: { fontSize: 12, fontWeight: 700, color: C.accent } }, `#${rank}`),
      h('span', { style: { fontSize: 10, color: C.dim, marginLeft: 5 } }, `${a.streams} streams`)
    ),
    h('span', { style: { fontSize: titleFontSize(a.name), fontWeight: 700, color: C.text, marginTop: 2, lineHeight: 1.25, wordBreak: 'break-word', textAlign: 'center', display: 'block', lineClamp: MAX_TITLE_LINES, fontFamily: textFont(a.name, 'Statsfm Sans') } }, a.name)
  );
}

function rows<T>(items: T[], render: (item: T, index: number, last: boolean) => Record<string, unknown>) {
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < items.length; i += 5) {
    out.push(
      h(
        'div',
        { style: { display: 'flex', marginTop: i === 0 ? 0 : 12 } },
        ...items.slice(i, i + 5).map((item, j) => render(item, i + j, j === 4))
      )
    );
  }
  return out;
}

function sectionLabel(title: string, sub: string) {
  return h(
    'div',
    { style: { display: 'flex', alignItems: 'baseline', marginBottom: 10 } },
    h('span', { style: { fontSize: 12, fontWeight: 700, color: C.dim, letterSpacing: 1.5 } }, title),
    h('span', { style: { fontSize: 11, color: C.dim, marginLeft: 10 } }, sub)
  );
}

function shell(name: string, avatar: string, mark: string, body: unknown[], height: number) {
  const node = h(
    'div',
    {
      style: {
        width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
        backgroundColor: C.bg, borderRadius: 14, border: `1px solid ${C.border}`,
        padding: '20px 24px', fontFamily: 'Statsfm Sans',
      },
    },
    h(
      'div',
      { style: { display: 'flex', alignItems: 'center', marginBottom: 14 } },
      h('img', { src: mark, width: 26, height: 26, style: { borderRadius: 6, marginRight: 8 } }),
      h('span', { style: { fontSize: 18, fontWeight: 700, color: C.text } }, 'stats.fm'),
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', marginLeft: 'auto' } },
        avatar
          ? h('img', { src: avatar, width: 30, height: 30, style: { borderRadius: 15, marginRight: 8 } })
          : h('div', { style: { display: 'flex' } }),
        h('span', { style: { fontSize: 14, fontWeight: 700, color: C.text } }, name)
      )
    ),
    ...body.filter(Boolean)
  );
  return renderCard(node, 520, height);
}

function statsSub(stats: Record<string, number>): string {
  return `last 4 weeks · ${stats.weeklyStreams} streams · ${Math.round(stats.weeklyMinutes / 60)}h`;
}

// Combined card: top 5 albums + top 5 artists.
async function buildCombined(data: SourceSnapshot<StatsfmExtra>): Promise<string> {
  const albums = data.extra.topAlbums.slice(0, 5);
  const artists = data.extra.topArtists.slice(0, 5);
  const [avatar, mark, albumImgs, artistImgs] = await Promise.all([
    toDataUri(data.profile.avatar),
    Promise.resolve(logo('statsfm')),
    Promise.all(albums.map((a) => toDataUri(a.image))),
    Promise.all(artists.map((a) => toDataUri(a.image))),
  ]);
  const body = [
    sectionLabel('TOP ALBUMS', statsSub(data.stats)),
    ...rows(albums, (a, i, last) => albumTile(a, albumImgs[i], i + 1, last)),
    h('div', { style: { display: 'flex', marginTop: 16 } }),
    sectionLabel('TOP ARTISTS', 'last 4 weeks'),
    ...rows(artists, (a, i, last) => artistTile(a, artistImgs[i], i + 1, last)),
  ];
  const height = 112 + ALBUM_ROW_H + 26 + 16 + ARTIST_ROW_H + 26;
  return shell(data.profile.name, avatar, mark, body, height);
}

// Top 10 albums, two rows.
async function buildAlbums(data: SourceSnapshot<StatsfmExtra>): Promise<string> {
  const albums = data.extra.topAlbums.slice(0, 10);
  const [avatar, mark, albumImgs] = await Promise.all([
    toDataUri(data.profile.avatar),
    Promise.resolve(logo('statsfm')),
    Promise.all(albums.map((a) => toDataUri(a.image))),
  ]);
  const nRows = Math.max(1, Math.ceil(albums.length / 5));
  const body = [
    sectionLabel('TOP ALBUMS', statsSub(data.stats)),
    ...rows(albums, (a, i, last) => albumTile(a, albumImgs[i], i + 1, last)),
  ];
  const height = 112 + nRows * ALBUM_ROW_H + (nRows - 1) * 12 + 26;
  return shell(data.profile.name, avatar, mark, body, height);
}

// Top 10 artists, two rows.
async function buildArtists(data: SourceSnapshot<StatsfmExtra>): Promise<string> {
  const artists = data.extra.topArtists.slice(0, 10);
  const [avatar, mark, artistImgs] = await Promise.all([
    toDataUri(data.profile.avatar),
    Promise.resolve(logo('statsfm')),
    Promise.all(artists.map((a) => toDataUri(a.image))),
  ]);
  const nRows = Math.max(1, Math.ceil(artists.length / 5));
  const body = [
    sectionLabel('TOP ARTISTS', statsSub(data.stats)),
    ...rows(artists, (a, i, last) => artistTile(a, artistImgs[i], i + 1, last)),
  ];
  const height = 112 + nRows * ARTIST_ROW_H + (nRows - 1) * 12 + 26;
  return shell(data.profile.name, avatar, mark, body, height);
}

export const buildStatsfmCard = (d: SourceSnapshot<StatsfmExtra>) => buildCombined(d);
export const buildStatsfmAlbumsCard = (d: SourceSnapshot<StatsfmExtra>) => buildAlbums(d);
export const buildStatsfmArtistsCard = (d: SourceSnapshot<StatsfmExtra>) => buildArtists(d);
