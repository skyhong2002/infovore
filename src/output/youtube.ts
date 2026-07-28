import type { YoutubeDashboardData, YoutubeRange } from '../youtube/types.js';
import { h, renderCard, textFont, toDataUri, truncate } from './render.js';
import { html, shell } from './pages.js';

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

function compact(value: number): string {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function hours(seconds: number | null): string {
  if (seconds === null) return '—';
  return `${Math.round(seconds / 360) / 10}h`;
}

function duration(seconds: number | null): string {
  if (seconds === null) return 'Unknown length';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function rangeLabel(range: YoutubeRange): string {
  return range === 'all' ? 'All time' : `Last ${range.replace('d', ' days')}`;
}

const dashboardStyles = `
  .yt-range{align-items:center;border-bottom:1px solid var(--line);display:flex;gap:4px;margin-bottom:28px;overflow-x:auto;padding-bottom:12px}
  .yt-range a{border-radius:6px;color:var(--muted);font-size:12px;padding:7px 10px;text-decoration:none;white-space:nowrap}.yt-range a[aria-current=page]{background:#f2f4f7;color:#111}
  .yt-stats{border-bottom:1px solid var(--line);border-top:1px solid var(--line);display:grid;grid-template-columns:repeat(5,minmax(0,1fr));margin-bottom:42px}
  .yt-stat{border-left:1px solid var(--line);padding:16px}.yt-stat:first-child{border-left:0;padding-left:0}.yt-stat strong{display:block;font-size:22px}.yt-stat span{color:var(--quiet);font-size:10px;text-transform:uppercase}
  .yt-section{margin-top:42px}.yt-heading{align-items:end;display:flex;justify-content:space-between;margin-bottom:14px}.yt-heading h2{font-size:18px;margin:0}.yt-heading span{color:var(--quiet);font-size:11px}
  .yt-bars{align-items:end;border-bottom:1px solid var(--line);display:flex;gap:3px;height:150px;overflow-x:auto;padding:0 0 1px}.yt-day{background:#ff453a;display:block;flex:1 0 7px;min-height:2px;opacity:.86}.yt-day:hover{opacity:1}
  .yt-columns{display:grid;gap:28px;grid-template-columns:minmax(0,1.25fr) minmax(260px,.75fr)}.yt-table{border-collapse:collapse;width:100%}.yt-table td,.yt-table th{border-bottom:1px solid var(--line);font-size:12px;padding:10px 8px;text-align:right}.yt-table th{color:var(--quiet);font-size:10px;text-transform:uppercase}.yt-table td:first-child,.yt-table th:first-child{text-align:left}.yt-table a{color:var(--text);text-decoration:none}
  .yt-distribution{display:grid;gap:8px}.yt-distribution-row{align-items:center;display:grid;gap:10px;grid-template-columns:70px minmax(0,1fr) 34px}.yt-distribution-row span{color:var(--muted);font-size:11px}.yt-distribution-track{background:var(--surface-raised);height:7px}.yt-distribution-track i{background:#63d8e6;display:block;height:100%}
  .yt-taxonomy{display:grid;gap:22px;grid-template-columns:1fr 1fr}.yt-topic-list{display:flex;flex-wrap:wrap;gap:7px}.yt-topic{border:1px solid var(--line);border-radius:6px;padding:8px 10px}.yt-topic strong{display:block;font-size:12px}.yt-topic span{color:var(--quiet);font-size:10px}.yt-keywords{display:flex;flex-wrap:wrap;gap:6px}.yt-keywords span{background:var(--surface-raised);border-radius:5px;color:#c8cdd5;font-size:11px;padding:6px 8px}
  .yt-recent{display:grid;gap:12px;grid-template-columns:repeat(2,minmax(0,1fr))}.yt-video{align-items:center;border-bottom:1px solid var(--line);color:inherit;display:grid;gap:12px;grid-template-columns:120px minmax(0,1fr);padding:0 0 12px;text-decoration:none}.yt-video img,.yt-video-placeholder{aspect-ratio:16/9;background:#20242a;display:block;object-fit:cover;width:120px}.yt-video h3{font-size:13px;line-height:1.35;margin:0 0 4px}.yt-video p{color:var(--quiet);font-size:10px;margin:0}
  @media(max-width:760px){.yt-stats{grid-template-columns:repeat(2,1fr)}.yt-stat{border-bottom:1px solid var(--line)}.yt-stat:nth-child(odd){border-left:0}.yt-columns,.yt-taxonomy{grid-template-columns:1fr}.yt-recent{grid-template-columns:1fr}}
  @media(max-width:420px){.yt-video{grid-template-columns:96px minmax(0,1fr)}.yt-video img,.yt-video-placeholder{width:96px}}
`;

export function youtubeDashboardPage(
  ownerName: string,
  data: YoutubeDashboardData,
  sort: 'watches' | 'duration' = 'watches',
): string {
  const ranges: YoutubeRange[] = ['7d', '28d', '90d', 'all'];
  const rangeNav = `<nav class="yt-range" aria-label="Time range">${ranges.map((range) =>
    `<a href="/platforms/youtube?range=${range}&sort=${sort}"${range === data.range ? ' aria-current="page"' : ''}>${rangeLabel(range)}</a>`
  ).join('')}</nav>`;
  const stats = `<div class="yt-stats">
    <div class="yt-stat"><strong>${compact(data.stats.watchEvents)}</strong><span>watch events</span></div>
    <div class="yt-stat"><strong>${compact(data.stats.uniqueVideos)}</strong><span>different videos</span></div>
    <div class="yt-stat"><strong>${compact(data.stats.uniqueChannels)}</strong><span>channels</span></div>
    <div class="yt-stat"><strong>${hours(data.stats.openedDurationSeconds)}</strong><span>opened duration</span></div>
    <div class="yt-stat"><strong>${hours(data.stats.actualWatchedSeconds)}</strong><span>measured watch time</span></div>
  </div>`;
  const maxDay = Math.max(1, ...data.daily.map((day) => day.watches));
  const bars = `<section class="yt-section"><div class="yt-heading"><h2>Daily volume</h2><span>${data.daily.length} active days</span></div>
    <div class="yt-bars">${data.daily.map((day) =>
      `<i class="yt-day" style="height:${Math.max(2, Math.round(day.watches / maxDay * 100))}%" title="${html(day.day)} · ${day.watches} videos"></i>`
    ).join('')}</div></section>`;
  const channels = [...data.topChannels].sort((a, b) =>
    sort === 'duration' ? b.durationSeconds - a.durationSeconds : b.watches - a.watches
  );
  const channelTable = `<section><div class="yt-heading"><h2>Top channels</h2><span><a href="?range=${data.range}&sort=watches">plays</a> · <a href="?range=${data.range}&sort=duration">duration</a></span></div>
    <table class="yt-table"><thead><tr><th>Channel</th><th>Plays</th><th>Duration</th></tr></thead><tbody>${channels.map((channel) =>
      `<tr><td>${channel.channelId ? `<a href="https://www.youtube.com/channel/${html(channel.channelId)}">${html(channel.name)}</a>` : html(channel.name)}</td><td>${channel.watches}</td><td>${hours(channel.durationSeconds)}</td></tr>`
    ).join('')}</tbody></table></section>`;
  const maxLength = Math.max(1, ...data.lengthBuckets.map((bucket) => bucket.videos));
  const distribution = `<section><div class="yt-heading"><h2>Length mix</h2><span>unique videos</span></div><div class="yt-distribution">${data.lengthBuckets.map((bucket) =>
    `<div class="yt-distribution-row"><span>${html(bucket.label)}</span><div class="yt-distribution-track"><i style="width:${Math.round(bucket.videos / maxLength * 100)}%"></i></div><span>${bucket.videos}</span></div>`
  ).join('')}</div></section>`;
  const taxonomy = `<section class="yt-section"><div class="yt-taxonomy"><div><div class="yt-heading"><h2>Stable topics</h2><span>AI-classified</span></div>
    <div class="yt-topic-list">${data.topics.length ? data.topics.map((topic) =>
      `<div class="yt-topic"><strong>${html(topic.name)}</strong><span>${topic.watches} watches · ${hours(topic.durationSeconds)}</span></div>`
    ).join('') : '<span class="muted">Topic classification is pending.</span>'}</div></div>
    <div><div class="yt-heading"><h2>Trending keywords</h2><span>public metadata only</span></div>
    <div class="yt-keywords">${data.keywords.map((keyword) => `<span>${html(keyword.term)} · ${keyword.videos}</span>`).join('')}</div></div></div></section>`;
  const recent = `<section class="yt-section"><div class="yt-heading"><h2>Recently watched</h2><span>10 different videos</span></div><div class="yt-recent">${data.recent.map((video) =>
    `<a class="yt-video" href="${html(video.url)}">${video.thumbnailUrl ? `<img src="${html(video.thumbnailUrl)}" alt="" loading="lazy">` : '<span class="yt-video-placeholder"></span>'}<div><h3>${html(video.title)}</h3><p>${html(video.channelTitle)} · ${duration(video.durationSeconds)}${video.watchCount > 1 ? ` · ${video.watchCount} plays` : ''}</p></div></a>`
  ).join('')}</div></section>`;
  const intro = `<style>${dashboardStyles}</style><section class="page-intro"><div><div class="eyebrow">YouTube · attention archive</div><h1>YouTube</h1><p>${html(ownerName)}'s viewing patterns, channels, topics, and recent videos.</p></div><div class="page-intro-aside">${Math.round(data.stats.metadataCoverage * 100)}% metadata coverage · ${rangeLabel(data.range)}</div></section>
    <div class="context-line"><a href="/">Home</a><span>→</span><a href="/platforms">Platforms</a><span>→</span><strong>YouTube</strong></div>`;
  return shell(`${ownerName} · YouTube`, intro + rangeNav + stats + bars
    + `<section class="yt-section yt-columns">${channelTable}${distribution}</section>` + taxonomy + recent, 'platforms');
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

export async function buildYoutubeOverviewCard(data: YoutubeDashboardData): Promise<string> {
  const recent = data.recent.slice(0, 3);
  const images = await Promise.all(recent.map((video) => toDataUri(video.thumbnailUrl)));
  const body = [
    h('div', { style: { display: 'flex', gap: 10 } }, ...recent.map((video, index) =>
      h('div', { style: { display: 'flex', flexDirection: 'column', width: 150 } },
        images[index]
          ? h('img', { src: images[index], height: 84, width: 150, style: { objectFit: 'cover' } })
          : h('div', { style: { backgroundColor: C.panel, height: 84, width: 150 } }),
        h('span', { style: { fontFamily: textFont(video.title, 'Inter'), fontSize: 11, fontWeight: 700, lineClamp: 2, marginTop: 7 } }, truncate(video.title, 42)),
        h('span', { style: { color: C.dim, fontSize: 9, marginTop: 3 } }, truncate(video.channelTitle, 24))
      )
    )),
  ];
  return cardShell('Viewing volume', `${compact(data.stats.watchEvents)} plays · ${hours(data.stats.openedDurationSeconds)} opened`, body, 280);
}

export async function buildYoutubeChannelsCard(data: YoutubeDashboardData): Promise<string> {
  const max = Math.max(1, ...data.topChannels.slice(0, 8).map((channel) => channel.watches));
  const body = data.topChannels.slice(0, 8).map((channel, index) =>
    h('div', { style: { alignItems: 'center', display: 'flex', marginBottom: 8 } },
      h('span', { style: { color: C.dim, fontSize: 10, width: 22 } }, `#${index + 1}`),
      h('span', { style: { fontFamily: textFont(channel.name, 'Inter'), fontSize: 11, width: 170 } }, truncate(channel.name, 28)),
      h('div', { style: { backgroundColor: C.panel, display: 'flex', height: 7, width: 220 } },
        h('div', { style: { backgroundColor: C.red, height: 7, width: Math.round(channel.watches / max * 220) } })),
      h('span', { style: { color: C.dim, fontSize: 10, marginLeft: 8 } }, `${channel.watches}`)
    )
  );
  return cardShell('Top channels', `${compact(data.stats.uniqueChannels)} channels in the mix`, body, 360);
}

export async function buildYoutubeTopicsCard(data: YoutubeDashboardData): Promise<string> {
  const topics = data.topics.slice(0, 8);
  const keywords = data.keywords.slice(0, 10);
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
