import { h, logo, toDataUri, truncate, renderCard } from './render.js';
import type { BackloggdStats } from '../fetchers/backloggd.js';

// Backloggd's dark UI: near-black navy, pale periwinkle section headers,
// pink accent, system-sans typography (Roboto stands in).
const C = {
  bg: '#14171c',
  header: '#c9d6f0',
  text: '#e8eaed',
  dim: '#8a939e',
  accent: '#ea377a',
  border: '#23262e',
};

function stat(value: number, label: string) {
  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 1 } },
    h('span', { style: { fontSize: 34, fontWeight: 700, color: '#ffffff' } }, String(value)),
    h('span', { style: { fontSize: 12, color: C.dim, marginTop: 2 } }, label)
  );
}

export async function buildBackloggdCard(data: BackloggdStats): Promise<string> {
  const [avatar, wordmark, ...covers] = await Promise.all([
    toDataUri(data.avatar),
    Promise.resolve(logo('backloggd')),
    ...data.recent.map((g) => toDataUri(g.cover)),
  ]);

  const tiles = data.recent.map((g, i) =>
    h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', width: 84, marginRight: i < 4 ? 12 : 0 } },
      covers[i]
        ? h('img', {
            src: covers[i],
            width: 84,
            height: 112,
            style: { borderRadius: 4, objectFit: 'cover', border: `1px solid ${C.border}` },
          })
        : h('div', { style: { width: 84, height: 112, backgroundColor: C.border, borderRadius: 4, display: 'flex' } }),
      h('span', { style: { fontSize: 11, fontWeight: 700, color: C.text, marginTop: 6, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' } }, truncate(g.title, 14)),
      h('span', { style: { fontSize: 10, color: C.accent, marginTop: 2 } }, g.lastPlayed),
      h('span', { style: { fontSize: 10, color: C.dim, marginTop: 1, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' } }, truncate(g.platform, 15))
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
    // Header: avatar + username left, wordmark right (like the site navbar).
    h(
      'div',
      { style: { display: 'flex', alignItems: 'center', marginBottom: 14 } },
      avatar
        ? h('img', { src: avatar, width: 34, height: 34, style: { borderRadius: 4, marginRight: 10 } })
        : h('div', { style: { display: 'flex' } }),
      h('span', { style: { fontSize: 17, fontWeight: 700, color: '#ffffff' } }, data.username),
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', marginLeft: 'auto' } },
        h('img', { src: wordmark, width: 22, height: 22, style: { borderRadius: 4, marginRight: 7 } }),
        h('span', { style: { fontSize: 16, fontWeight: 700, color: '#ffffff' } }, 'Backloggd')
      )
    ),
    // Stats row, big white numbers like the profile page.
    h(
      'div',
      { style: { display: 'flex', paddingBottom: 12, borderBottom: `1px solid ${C.border}`, marginBottom: 12 } },
      stat(data.gamesPlayed, 'Games Played'),
      stat(data.playedThisYear, `Played in ${new Date().getFullYear()}`),
      stat(data.backlog, 'Backlog')
    ),
    h('span', { style: { fontSize: 14, fontWeight: 700, color: C.header, marginBottom: 8 } }, 'Recently Played'),
    h('div', { style: { display: 'flex' } }, ...tiles)
  );

  return renderCard(node, 520, 372);
}
