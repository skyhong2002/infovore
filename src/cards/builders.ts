import { h, cardShell, statBlock, themes, renderCard } from './render.js';
import type { BackloggdStats } from '../fetchers/backloggd.js';
import type { KitsuStats } from '../fetchers/kitsu.js';
import type { StatsfmStats } from '../fetchers/statsfm.js';
import type { SimklStats } from '../fetchers/simkl.js';
import { config } from '../config.js';

// Satori can't fetch remote images itself in all environments, so we inline
// covers as data URIs. Called once per refresh cycle, not per request.
async function toDataUri(url: string): Promise<string> {
  if (!url) return '';
  try {
    const res = await fetch(url, { headers: { 'User-Agent': config.userAgent } });
    if (!res.ok) return '';
    const type = res.headers.get('content-type') ?? 'image/jpeg';
    const buf = Buffer.from(await res.arrayBuffer());
    return `data:${type};base64,${buf.toString('base64')}`;
  } catch {
    return '';
  }
}

function coverRow(images: string[], coverWidth = 56, coverHeight = 75) {
  return h(
    'div',
    { style: { display: 'flex', marginTop: 16 } },
    ...images
      .filter(Boolean)
      .map((src) =>
        h('img', {
          src,
          width: coverWidth,
          height: coverHeight,
          style: { borderRadius: 6, marginRight: 10, objectFit: 'cover' },
        })
      )
  );
}

export async function buildBackloggdCard(data: BackloggdStats): Promise<string> {
  const t = themes.backloggd;
  const covers = await Promise.all(
    data.recentlyPlayed.slice(0, 5).map((g) => toDataUri(g.cover))
  );
  const body = h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', flex: 1 } },
    h(
      'div',
      { style: { display: 'flex' } },
      statBlock(t, String(data.gamesPlayed), 'Games Played'),
      statBlock(t, String(data.playedThisYear), `Played in ${new Date().getFullYear()}`),
      statBlock(t, String(data.backlog), 'Backlog')
    ),
    coverRow(covers)
  );
  return renderCard(cardShell(t, 'Backloggd', `@${data.username}`, body), 480, 260);
}

export async function buildKitsuCard(data: KitsuStats): Promise<string> {
  const t = themes.kitsu;
  const covers = await Promise.all(
    data.currentlyWatching.slice(0, 5).map((a) => toDataUri(a.poster))
  );
  const body = h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', flex: 1 } },
    h(
      'div',
      { style: { display: 'flex' } },
      statBlock(t, String(data.animeCompleted), 'Anime Completed'),
      statBlock(t, String(data.episodesWatched), 'Episodes'),
      statBlock(t, `${Math.round(data.animeMinutesWatched / 60)}h`, 'Watched')
    ),
    coverRow(covers)
  );
  return renderCard(cardShell(t, 'Kitsu', `@${data.slug}`, body), 480, 260);
}

export async function buildStatsfmCard(data: StatsfmStats): Promise<string> {
  const t = themes.statsfm;
  const artistImgs = await Promise.all(
    data.topArtists.slice(0, 3).map((a) => toDataUri(a.image))
  );
  const albumImg = data.currentTrack ? await toDataUri(data.currentTrack.albumImage) : '';

  const nowPlaying = data.currentTrack
    ? h(
        'div',
        { style: { display: 'flex', alignItems: 'center', marginTop: 16 } },
        albumImg
          ? h('img', {
              src: albumImg,
              width: 44,
              height: 44,
              style: { borderRadius: 6, marginRight: 12 },
            })
          : h('span', { style: { fontSize: 14, color: t.accent, marginRight: 8 } }, '▶'),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column' } },
          h('span', { style: { fontSize: 14, fontWeight: 700, color: t.text } }, data.currentTrack.name),
          h('span', { style: { fontSize: 13, color: t.subtext } }, data.currentTrack.artist)
        )
      )
    : h(
        'div',
        { style: { display: 'flex', alignItems: 'center', marginTop: 16 } },
        ...artistImgs
          .filter(Boolean)
          .map((src) =>
            h('img', {
              src,
              width: 44,
              height: 44,
              style: { borderRadius: 22, marginRight: 10, objectFit: 'cover' },
            })
          ),
        h(
          'span',
          { style: { fontSize: 13, color: t.subtext, marginLeft: 4 } },
          data.topArtists.map((a) => a.name).join(' · ')
        )
      );

  const body = h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', flex: 1 } },
    h(
      'div',
      { style: { display: 'flex' } },
      statBlock(t, String(data.weeklyStreams), 'Streams (4w)'),
      statBlock(t, `${Math.round(data.weeklyMinutes / 60)}h`, 'Listened'),
      statBlock(t, String(data.weeklyUniqueArtists), 'Artists')
    ),
    nowPlaying
  );
  return renderCard(cardShell(t, 'stats.fm', `@${data.username}`, body), 480, 230);
}

export async function buildSimklCard(data: SimklStats): Promise<string> {
  const t = themes.simkl;
  const poster = data.lastWatched ? await toDataUri(data.lastWatched.poster) : '';
  const body = h(
    'div',
    { style: { display: 'flex', flex: 1, alignItems: 'center' } },
    poster
      ? h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', marginRight: 20 } },
          h('img', {
            src: poster,
            width: 72,
            height: 106,
            style: { borderRadius: 6, objectFit: 'cover' },
          }),
          h(
            'span',
            { style: { fontSize: 11, color: t.subtext, marginTop: 6, maxWidth: 90, textAlign: 'center' } },
            data.lastWatched!.title
          )
        )
      : h('div', { style: { display: 'flex' } }),
    h(
      'div',
      { style: { display: 'flex', flex: 1 } },
      statBlock(t, String(data.showsCompleted), 'Shows', 30),
      statBlock(t, String(data.showsWatching), 'Watching', 30),
      statBlock(t, String(data.moviesCompleted), 'Movies', 30),
      statBlock(t, `${Math.round(data.totalMinutes / 60)}h`, 'Total', 30)
    )
  );
  return renderCard(cardShell(t, 'Simkl', `#${data.userId}`, body), 480, 220);
}
