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

  const tile = (g: (typeof data.recent)[number], i: number, last: boolean) =>
    h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', width: 84, marginRight: last ? 0 : 12 } },
      covers[i]
        ? h('img', {
            src: covers[i],
            width: 84,
            height: 112,
            style: { borderRadius: 4, objectFit: 'cover', border: `1px solid ${C.border}` },
          })
        : h('div', { style: { width: 84, height: 112, backgroundColor: C.border, borderRadius: 4, display: 'flex' } }),
      h('span', { style: { fontSize: 11, fontWeight: 700, color: C.text, marginTop: 6, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' } }, truncate(g.title, 14)),
      h('span', { style: { fontSize: 10, color: C.accent, marginTop: 2 } }, g.lastPlayed)
    );

  const tileRows: Record<string, unknown>[] = [];
  for (let i = 0; i < data.recent.length; i += 5) {
    tileRows.push(
      h(
        'div',
        { style: { display: 'flex', marginTop: i === 0 ? 0 : 12 } },
        ...data.recent.slice(i, i + 5).map((g, j) => tile(g, i + j, j === 4))
      )
    );
  }

  const node = h(
    'div',
    {
      style: {
        width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
        backgroundColor: C.bg, borderRadius: 10, border: `1px solid ${C.border}`,
        padding: '20px 24px', fontFamily: 'Roboto',
      },
    },
    // Header: wordmark left (like the site navbar), avatar + username right.
    h(
      'div',
      { style: { display: 'flex', alignItems: 'center', marginBottom: 14 } },
      h('img', { src: wordmark, width: 26, height: 26, style: { borderRadius: 4, marginRight: 8 } }),
      h('span', { style: { fontSize: 18, fontWeight: 700, color: '#ffffff' } }, 'Backloggd'),
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', marginLeft: 'auto' } },
        avatar
          ? h('img', { src: avatar, width: 30, height: 30, style: { borderRadius: 4, marginRight: 8 } })
          : h('div', { style: { display: 'flex' } }),
        h('span', { style: { fontSize: 14, fontWeight: 700, color: '#ffffff' } }, data.username)
      )
    ),
    // Stats row, big white numbers like the profile page.
    h(
      'div',
      { style: { display: 'flex' } },
      stat(data.gamesPlayed, 'Games Played'),
      stat(data.playedThisYear, `Played in ${new Date().getFullYear()}`),
      stat(data.backlog, 'Backlog')
    ),
    h(
      'div',
      { style: { display: 'flex', justifyContent: 'center', paddingBottom: 10, borderBottom: `1px solid ${C.border}`, marginBottom: 12 } },
      data.yearExtras
        ? h('span', { style: { fontSize: 10, color: C.dim, marginTop: 6 } }, data.yearExtras)
        : h('div', { style: { display: 'flex' } })
    ),
    h('span', { style: { fontSize: 14, fontWeight: 700, color: C.header, marginBottom: 8 } }, 'Recently Played'),
    ...tileRows
  );

  // Header + stats ≈ 216; each tile row ≈ 149 (cover 112 + title + date).
  const nRows = Math.max(1, Math.ceil(data.recent.length / 5));
  return renderCard(node, 520, 216 + nRows * 149 + (nRows - 1) * 12);
}
