import { h, logo, toDataUri, truncate, renderCard } from './render.js';
import type { StatsfmStats } from '../fetchers/statsfm.js';

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

export async function buildStatsfmCard(data: StatsfmStats): Promise<string> {
  const nAlbums = data.topAlbums.length;
  const [avatar, mark, nowImg, ...images] = await Promise.all([
    toDataUri(data.avatar),
    Promise.resolve(logo('statsfm')),
    data.currentTrack ? toDataUri(data.currentTrack.albumImage) : Promise.resolve(''),
    ...data.topAlbums.map((a) => toDataUri(a.image)),
    ...data.topArtists.map((a) => toDataUri(a.image)),
  ]);
  const albumImgs = images.slice(0, nAlbums);
  const artistImgs = images.slice(nAlbums);

  const tiles = data.topAlbums.map((a, i) =>
    h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', width: 84, marginRight: i < 4 ? 12 : 0 } },
      albumImgs[i]
        ? h('img', { src: albumImgs[i], width: 84, height: 84, style: { borderRadius: 8, objectFit: 'cover' } })
        : h('div', { style: { width: 84, height: 84, backgroundColor: C.panel, borderRadius: 8, display: 'flex' } }),
      h(
        'div',
        { style: { display: 'flex', alignItems: 'baseline', marginTop: 6 } },
        h('span', { style: { fontSize: 12, fontWeight: 700, color: C.accent } }, `#${i + 1}`),
        h('span', { style: { fontSize: 10, color: C.dim, marginLeft: 5 } }, `${a.streams} streams`)
      ),
      h('span', { style: { fontSize: 11, fontWeight: 700, color: C.text, marginTop: 2, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' } }, truncate(a.name, 14)),
      h('span', { style: { fontSize: 10, color: C.dim, marginTop: 1, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' } }, truncate(a.artist, 15))
    )
  );

  const artistTiles = data.topArtists.map((a, i) =>
    h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', width: 84, marginRight: i < 4 ? 12 : 0 } },
      artistImgs[i]
        ? h('img', { src: artistImgs[i], width: 64, height: 64, style: { borderRadius: 32, objectFit: 'cover' } })
        : h('div', { style: { width: 64, height: 64, backgroundColor: C.panel, borderRadius: 32, display: 'flex' } }),
      h(
        'div',
        { style: { display: 'flex', alignItems: 'baseline', marginTop: 6 } },
        h('span', { style: { fontSize: 12, fontWeight: 700, color: C.accent } }, `#${i + 1}`),
        h('span', { style: { fontSize: 10, color: C.dim, marginLeft: 5 } }, `${a.streams} streams`)
      ),
      h('span', { style: { fontSize: 11, fontWeight: 700, color: C.text, marginTop: 2, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden', maxWidth: 84 } }, truncate(a.name, 14))
    )
  );

  const nowPlaying = data.currentTrack
    ? h(
        'div',
        {
          style: {
            display: 'flex', alignItems: 'center', marginTop: 14,
            backgroundColor: C.panel, borderRadius: 10, padding: '8px 12px',
          },
        },
        nowImg
          ? h('img', { src: nowImg, width: 36, height: 36, style: { borderRadius: 6, marginRight: 10 } })
          : h('span', { style: { fontSize: 13, color: C.accent, marginRight: 8 } }, '▶'),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column' } },
          h('span', { style: { fontSize: 12, fontWeight: 700, color: C.text } }, truncate(data.currentTrack.name, 40)),
          h('span', { style: { fontSize: 11, color: C.dim } }, data.currentTrack.artist)
        ),
        h('span', { style: { fontSize: 10, fontWeight: 700, color: C.accent, marginLeft: 'auto', letterSpacing: 1 } }, 'NOW PLAYING')
      )
    : h('div', { style: { display: 'flex' } });

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
        h('span', { style: { fontSize: 14, fontWeight: 700, color: C.text } }, data.displayName)
      )
    ),
    h(
      'div',
      { style: { display: 'flex', alignItems: 'baseline', marginBottom: 10 } },
      h('span', { style: { fontSize: 12, fontWeight: 700, color: C.dim, letterSpacing: 1.5 } }, 'TOP ALBUMS'),
      h('span', { style: { fontSize: 11, color: C.dim, marginLeft: 10 } },
        `last 4 weeks · ${data.weeklyStreams} streams · ${Math.round(data.weeklyMinutes / 60)}h`)
    ),
    h('div', { style: { display: 'flex' } }, ...tiles),
    h(
      'div',
      { style: { display: 'flex', alignItems: 'baseline', marginTop: 16, marginBottom: 10 } },
      h('span', { style: { fontSize: 12, fontWeight: 700, color: C.dim, letterSpacing: 1.5 } }, 'TOP ARTISTS'),
      h('span', { style: { fontSize: 11, color: C.dim, marginLeft: 10 } }, 'last 4 weeks')
    ),
    h('div', { style: { display: 'flex' } }, ...artistTiles),
    nowPlaying
  );

  return renderCard(node, 520, data.currentTrack ? 462 : 406);
}
