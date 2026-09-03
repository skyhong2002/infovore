import type { SourceSnapshot } from '../data/types.js';
import type { YoutubeExtra } from '../sources/youtube.js';
import { h, renderCard, textFont, toDataUri, truncate } from './render.js';
import { hours } from './pages.js';

const C = {
  bg: '#101114',
  panel: '#191b20',
  line: '#2a2d34',
  text: '#f7f7f7',
  dim: '#9ca0aa',
  red: '#ff3b30',
  cyan: '#63d8e6',
  yellow: '#f2c14e',
};

type YoutubeSnapshot = SourceSnapshot<YoutubeExtra>;

function compact(value: number): string {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function cardShell(title: string, subtitle: string, body: unknown[], height: number) {
  const node = h('div', {
    style: {
      backgroundColor: C.bg, border: `1px solid ${C.line}`, borderRadius: 8,
      color: C.text, display: 'flex', flexDirection: 'column', fontFamily: 'Inter',
      height: '100%', padding: '20px 22px', width: '100%',
    },
  },
  h('div', { style: { alignItems: 'center', display: 'flex', marginBottom: 18 } },
    h('div', { style: { backgroundColor: C.red, borderRadius: 5, height: 24, marginRight: 9, width: 34 } }),
    h('span', { style: { fontSize: 18, fontWeight: 700 } }, 'YouTube'),
    h('span', { style: { color: C.dim, fontSize: 11, marginLeft: 'auto' } }, 'last 28 days')),
  h('span', { style: { color: C.dim, fontSize: 11, marginBottom: 4, textTransform: 'uppercase' } }, title),
  h('span', { style: { color: C.text, fontSize: 22, fontWeight: 700, marginBottom: 16 } }, subtitle),
  ...body);
  const ensureDisplay = (value: any): any => {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(ensureDisplay);
    const children = ensureDisplay(value.props?.children);
    const style = value.type === 'div' && !value.props?.style?.display
      ? { ...value.props.style, display: 'flex' }
      : value.props?.style;
    return { ...value, props: { ...value.props, style, children } };
  };
  return renderCard(ensureDisplay(node), 520, height);
}

export async function buildYoutubeOverviewCard(snapshot: YoutubeSnapshot): Promise<string> {
  const { recent } = snapshot.extra;
  const videos = snapshot.extra.topVideos.slice(0, 3);
  const images = await Promise.all(videos.map((video) => toDataUri(video.thumbnailUrl)));
  const body = [
    h('span', { style: { color: C.dim, fontSize: 10, marginBottom: 8, textTransform: 'uppercase' } }, 'Most watched'),
    h('div', { style: { display: 'flex', gap: 10 } }, ...videos.map((video, index) =>
      h('div', { style: { display: 'flex', flexDirection: 'column', width: 150 } },
        images[index]
          ? h('img', { src: images[index], height: 84, width: 150, style: { objectFit: 'cover' } })
          : h('div', { style: { backgroundColor: C.panel, height: 84, width: 150 } }),
        h('span', { style: { fontFamily: textFont(video.title, 'Inter'), fontSize: 11, fontWeight: 700, lineClamp: 2, marginTop: 7 } }, truncate(video.title, 42)),
        h('span', { style: { color: C.dim, fontSize: 9, marginTop: 3 } }, `${truncate(video.channelTitle, 18)} · ${hours(video.estimatedWatchSeconds)}`)
      )
    )),
  ];
  return cardShell('Viewing volume', `${compact(recent.watchEvents)} plays · ${hours(recent.estimatedWatchSeconds)} estimated`, body, 280);
}

export async function buildYoutubeChannelsCard(snapshot: YoutubeSnapshot): Promise<string> {
  const channels = [...snapshot.extra.topChannels]
    .sort((a, b) =>
      b.estimatedWatchSeconds - a.estimatedWatchSeconds || b.watches - a.watches
    )
    .slice(0, 8);
  const images = await Promise.all(channels.map((channel) => toDataUri(channel.thumbnailUrl)));
  const max = Math.max(1, ...channels.map((channel) => channel.estimatedWatchSeconds));
  const body = channels.map((channel, index) =>
    h('div', { style: { alignItems: 'center', display: 'flex', marginBottom: 8 } },
      h('span', { style: { color: C.dim, fontSize: 10, width: 22 } }, `#${index + 1}`),
      images[index]
        ? h('img', { src: images[index], height: 24, width: 24, style: { borderRadius: 12, marginRight: 7, objectFit: 'cover' } })
        : h('div', { style: { backgroundColor: C.panel, borderRadius: 12, height: 24, marginRight: 7, width: 24 } }),
      h('span', { style: { fontFamily: textFont(channel.name, 'Inter'), fontSize: 11, width: 142 } }, truncate(channel.name, 24)),
      h('div', { style: { backgroundColor: C.panel, display: 'flex', height: 7, width: 190 } },
        h('div', { style: { backgroundColor: C.red, height: 7, width: Math.round(channel.estimatedWatchSeconds / max * 190) } })),
      h('span', { style: { color: C.dim, fontSize: 9, marginLeft: 8, width: 52 } }, hours(channel.estimatedWatchSeconds))
    )
  );
  return cardShell('Top channels', `${compact(snapshot.extra.recent.uniqueChannels)} channels · by estimated time`, body, 360);
}

export async function buildYoutubeTopicsCard(snapshot: YoutubeSnapshot): Promise<string> {
  const topics = snapshot.extra.topics.slice(0, 8);
  const keywords = snapshot.extra.keywords.slice(0, 10);
  const body = [
    h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 7, marginBottom: 18 } }, ...topics.map((topic) =>
      h('div', { style: { alignItems: 'baseline', backgroundColor: C.panel, border: `1px solid ${C.line}`, borderRadius: 5, display: 'flex', padding: '7px 9px' } },
        h('span', { style: { fontFamily: textFont(topic.name, 'Inter'), fontSize: 11, fontWeight: 700 } }, topic.name),
        h('span', { style: { color: C.dim, fontSize: 9, marginLeft: 6 } }, `${topic.watches}`)
      )
    )),
    h('span', { style: { color: C.dim, fontSize: 10, marginBottom: 8, textTransform: 'uppercase' } }, 'Trending keywords'),
    h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } }, ...keywords.map((keyword) =>
      h('span', { style: { backgroundColor: C.panel, borderRadius: 4, color: C.cyan, fontFamily: textFont(keyword.term, 'Inter'), fontSize: 10, padding: '5px 7px' } }, keyword.term)
    )),
  ];
  return cardShell('Topics and keywords', `${topics.length || 'No'} stable topics`, body, 320);
}
