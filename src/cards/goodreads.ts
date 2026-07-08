import { h, logo, toDataUri, truncate, timeAgo, renderCard, textFont } from './render.js';
import type { GoodreadsStats, GoodreadsBook } from '../fetchers/goodreads.js';

// Goodreads' signature light UI: warm beige paper, dark brown ink,
// teal links, orange rating stars, Merriweather serif headings.
const C = {
  bg: '#f4f1ea',
  panel: '#ffffff',
  text: '#382110',
  dim: '#767676',
  accent: '#00635d',
  stars: '#e87400',
  border: '#dcd6c6',
};

function starString(rating: number): string {
  return '★'.repeat(rating) + '☆'.repeat(5 - rating);
}

export async function buildGoodreadsCard(data: GoodreadsStats): Promise<string> {
  const nCurrent = data.currentlyReading.length;
  const [avatar, mark, ...covers] = await Promise.all([
    toDataUri(data.avatar),
    Promise.resolve(logo('goodreads')),
    ...data.currentlyReading.map((b) => toDataUri(b.cover)),
    ...data.recentlyRead.map((b) => toDataUri(b.cover)),
  ]);
  const currentCovers = covers.slice(0, nCurrent);
  const readCovers = covers.slice(nCurrent);

  const currentRows = data.currentlyReading.map((b, i) =>
    h(
      'div',
      {
        style: {
          display: 'flex', alignItems: 'center', backgroundColor: C.panel,
          border: `1px solid ${C.border}`, borderRadius: 6, padding: '8px 12px',
          marginBottom: 8,
        },
      },
      currentCovers[i]
        ? h('img', { src: currentCovers[i], width: 32, height: 48, style: { borderRadius: 3, marginRight: 12, objectFit: 'cover' } })
        : h('div', { style: { display: 'flex' } }),
      h(
        'div',
        { style: { display: 'flex', flexDirection: 'column' } },
        h('span', { style: { fontSize: 13, fontWeight: 700, color: C.text, fontFamily: textFont(b.title, 'Merriweather') } }, truncate(b.title, 48)),
        h('span', { style: { fontSize: 11, color: C.dim, marginTop: 2 } }, b.author)
      ),
      h('span', { style: { fontSize: 10, fontWeight: 700, color: C.accent, marginLeft: 'auto', letterSpacing: 1 } }, 'READING')
    )
  );

  const tiles = data.recentlyRead.map((b, i) =>
    h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', width: 84, marginRight: i < 4 ? 12 : 0 } },
      readCovers[i]
        ? h('img', { src: readCovers[i], width: 84, height: 122, style: { borderRadius: 3, objectFit: 'cover', border: `1px solid ${C.border}` } })
        : h('div', { style: { width: 84, height: 122, backgroundColor: '#e8e2d4', borderRadius: 3, display: 'flex' } }),
      h('span', { style: { fontSize: 11, fontWeight: 700, color: C.text, marginTop: 6, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden', fontFamily: textFont(b.title, 'Merriweather') } }, truncate(b.title, 14)),
      h('span', { style: { fontSize: 10, color: C.dim, marginTop: 2, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden', fontFamily: textFont(b.author, 'Merriweather') } }, truncate(b.author, 16)),
      b.rating !== null
        ? h('span', { style: { fontSize: 10, color: C.stars, marginTop: 2, letterSpacing: 1 } }, starString(b.rating))
        : h('span', { style: { fontSize: 10, color: C.dim, marginTop: 2 } }, b.readAt ? timeAgo(b.readAt) : '')
    )
  );

  const node = h(
    'div',
    {
      style: {
        width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
        backgroundColor: C.bg, borderRadius: 8, border: `1px solid ${C.border}`,
        padding: '20px 24px', fontFamily: 'Merriweather',
      },
    },
    h(
      'div',
      { style: { display: 'flex', alignItems: 'center', marginBottom: 12 } },
      h('img', { src: mark, width: 28, height: 28, style: { borderRadius: 6, marginRight: 8 } }),
      h('span', { style: { fontSize: 19, fontWeight: 700, color: C.text } }, 'goodreads'),
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
      'span',
      { style: { fontSize: 11, color: C.dim, marginBottom: 12 } },
      `${data.readCount} read · ${data.currentlyReadingCount} reading · ${data.toReadCount} to-read`
    ),
    ...currentRows,
    h('span', { style: { fontSize: 13, fontWeight: 700, color: C.text, marginTop: 6, marginBottom: 8 } }, 'Recently Read'),
    h('div', { style: { display: 'flex' } }, ...tiles)
  );

  const height = 320 + data.currentlyReading.length * 74;
  return renderCard(node, 520, height);
}
