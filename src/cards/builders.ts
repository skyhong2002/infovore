import { h, cardShell, statBlock, theme, renderCard } from './render.js';
import type { BackloggdStats } from '../fetchers/backloggd.js';
import type { KitsuStats } from '../fetchers/kitsu.js';
import type { StatsfmStats } from '../fetchers/statsfm.js';
import type { SimklStats } from '../fetchers/simkl.js';
import { config } from '../config.js';

// Satori can't fetch remote images itself in all environments, so we inline
// covers as data URIs. Called once per refresh cycle, not per request.
async function toDataUri(url: string): Promise<string> {
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
  const covers = await Promise.all(
    data.recentlyPlayed.slice(0, 5).map((g) => toDataUri(g.cover))
  );
  const body = h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', flex: 1 } },
    h(
      'div',
      { style: { display: 'flex' } },
      statBlock(String(data.gamesPlayed), 'Games Played'),
      statBlock(String(data.playedThisYear), `Played in ${new Date().getFullYear()}`),
      statBlock(String(data.backlog), 'Backlog')
    ),
    coverRow(covers)
  );
  return renderCard(cardShell('Backloggd', `@${data.username}`, body), 480, 260);
}

export async function buildKitsuCard(data: KitsuStats): Promise<string> {
  const covers = await Promise.all(
    data.currentlyWatching.slice(0, 5).map((a) => toDataUri(a.poster))
  );
  const body = h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', flex: 1 } },
    h(
      'div',
      { style: { display: 'flex' } },
      statBlock(String(data.animeCompleted), 'Anime Completed'),
      statBlock(String(data.episodesWatched), 'Episodes'),
      statBlock(`${Math.round(data.animeMinutesWatched / 60)}h`, 'Watched')
    ),
    coverRow(covers)
  );
  return renderCard(cardShell('Kitsu', `@${data.slug}`, body), 480, 260);
}

export async function buildStatsfmCard(data: StatsfmStats): Promise<string> {
  const nowPlaying = data.currentTrack
    ? h(
        'div',
        { style: { display: 'flex', alignItems: 'center', marginTop: 16 } },
        h('span', { style: { fontSize: 14, color: theme.accent, marginRight: 8 } }, '▶'),
        h(
          'span',
          { style: { fontSize: 14, color: theme.text } },
          `${data.currentTrack.name} — ${data.currentTrack.artist}`
        )
      )
    : h(
        'div',
        { style: { display: 'flex', marginTop: 16 } },
        h(
          'span',
          { style: { fontSize: 14, color: theme.subtext } },
          `Top artists: ${data.topArtists.map((a) => a.name).join(', ')}`
        )
      );
  const body = h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', flex: 1 } },
    h(
      'div',
      { style: { display: 'flex' } },
      statBlock(String(data.weeklyStreams), 'Streams (4w)'),
      statBlock(`${Math.round(data.weeklyMinutes / 60)}h`, 'Listened'),
      statBlock(String(data.weeklyUniqueArtists), 'Artists')
    ),
    nowPlaying
  );
  return renderCard(cardShell('stats.fm', `@${data.username}`, body), 480, 200);
}

export async function buildSimklCard(data: SimklStats): Promise<string> {
  const body = h(
    'div',
    { style: { display: 'flex', flex: 1 } },
    statBlock(String(data.showsCompleted), 'Shows Completed'),
    statBlock(String(data.showsWatching), 'Watching'),
    statBlock(String(data.moviesCompleted), 'Movies'),
    statBlock(`${Math.round(data.totalMinutes / 60)}h`, 'Total Time')
  );
  return renderCard(cardShell('Simkl', `#${data.userId}`, body), 480, 160);
}
