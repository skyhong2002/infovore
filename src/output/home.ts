import type { TimeSpentSummary } from '../data/database.js';
import type { Activity } from '../data/types.js';
import type { StatsfmAlbum, StatsfmArtist } from '../sources/statsfm.js';
import { html, shell, sourceLabel, timeAmount } from './pages.js';

export interface HomepageData {
  ownerName: string;
  handle: string;
  avatar: string;
  profileUrl: string;
  lastUpdated: string | null;
  allActivities: Activity[];
  recentActivities: Activity[];
  sourceHighlights: Activity[];
  timeSpent: TimeSpentSummary | null;
  statsfmStats: Record<string, number>;
  topAlbums: StatsfmAlbum[];
  topArtists: StatsfmArtist[];
  publicActivityCount: number;
  connectedSources: number;
}

const homeStyles = `
  .home-page{max-width:1120px;margin:0 auto}
  .home-profile{align-items:center;border-bottom:1px solid var(--line);display:flex;gap:26px;justify-content:space-between;padding:8px 0 30px}
  .home-profile-main{align-items:center;display:flex;gap:20px;min-width:0}
  .home-avatar,.home-avatar-placeholder{background:var(--surface-raised);border-radius:50%;display:block;flex:0 0 88px;height:88px;object-fit:cover;width:88px}
  .home-avatar-placeholder{align-items:center;color:var(--blue);display:flex;font-size:34px;font-weight:700;justify-content:center}
  .home-kicker{color:var(--blue);font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase}
  .home-profile h1{font-size:38px;line-height:1.05;margin:5px 0 4px}
  .home-handle{color:var(--muted);font-size:14px;margin:0}
  .home-profile-links{display:flex;flex-wrap:wrap;gap:14px;margin-top:12px}
  .home-profile-links a{color:var(--muted);font-size:12px;text-decoration:none}
  .home-profile-links a:hover{color:var(--blue)}
  .home-profile-status{color:var(--quiet);font-size:12px;max-width:190px;text-align:right}
  .home-profile-status strong{color:var(--text);display:block;font-size:13px;margin:4px 0}
  .home-status-line{align-items:center;display:flex;gap:6px;justify-content:flex-end}
  .home-status-dot{background:var(--blue);border-radius:50%;height:6px;width:6px}
  .home-view-nav{border-bottom:1px solid var(--line);display:flex;gap:6px;overflow-x:auto;padding:14px 0}
  .home-view-nav a{border-radius:999px;color:var(--muted);font-size:13px;padding:7px 12px;text-decoration:none;white-space:nowrap}
  .home-view-nav a:hover,.home-view-nav a[aria-current=page]{background:var(--surface);color:var(--text)}
  .home-view-nav a[aria-current=page]{color:var(--blue)}
  .home-metric-grid{display:grid;gap:10px;grid-template-columns:repeat(4,minmax(0,1fr));margin-top:26px}
  .home-metric{background:var(--surface);border:1px solid var(--line);border-radius:10px;min-height:102px;padding:15px}
  .home-metric-label{color:var(--muted);display:block;font-size:11px;font-weight:600;letter-spacing:.8px;text-transform:uppercase}
  .home-metric-value{color:var(--text);display:block;font-size:28px;font-weight:700;line-height:1.1;margin-top:13px}
  .home-metric-note{color:var(--quiet);display:block;font-size:11px;margin-top:5px}
  .home-section{margin-top:42px}
  .home-section-head{align-items:baseline;display:flex;gap:16px;justify-content:space-between;margin-bottom:14px}
  .home-section-head h2{font-size:23px;line-height:1.2;margin:0}
  .home-section-head p{color:var(--muted);font-size:12px;margin:4px 0 0}
  .home-section-head a{color:var(--muted);font-size:12px;text-decoration:none;white-space:nowrap}
  .home-section-head a:hover{color:var(--blue)}
  .home-scroller{display:flex;gap:16px;overflow-x:auto;padding:2px 2px 9px;scrollbar-color:var(--line-strong) transparent;scroll-snap-type:x proximity}
  .home-media-tile{flex:0 0 154px;min-width:0;scroll-snap-align:start}
  .home-media-tile img,.home-media-placeholder{background:var(--surface-raised);border-radius:8px;display:block;height:154px;object-fit:cover;width:154px}
  .home-media-tile.artist{text-align:center}
  .home-media-tile.artist img,.home-media-tile.artist .home-media-placeholder{border-radius:50%}
  .home-media-placeholder{align-items:center;color:var(--quiet);display:flex;justify-content:center}
  .home-rank{color:var(--blue);font-size:12px;font-weight:700;margin-top:8px}
  .home-media-title{color:var(--text);display:block;font-size:14px;font-weight:700;line-height:1.25;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .home-media-meta{color:var(--muted);display:block;font-size:11px;line-height:1.35;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .home-platform-scroller{display:flex;gap:10px;overflow-x:auto;padding:2px 2px 8px;scroll-snap-type:x proximity}
  .home-platform-tile{align-items:center;background:var(--surface);border:1px solid var(--line);border-radius:10px;color:inherit;display:flex;flex:0 0 260px;gap:12px;min-height:88px;padding:10px;text-decoration:none;scroll-snap-align:start}
  .home-platform-tile:hover{border-color:var(--line-strong)}
  .home-platform-tile img,.home-platform-placeholder{background:var(--surface-raised);border-radius:7px;display:block;flex:0 0 66px;height:66px;object-fit:cover;width:66px}
  .home-platform-placeholder{align-items:center;color:var(--blue);display:flex;font-size:20px;font-weight:700;justify-content:center}
  .home-platform-copy{min-width:0}
  .home-platform-source{color:var(--blue);display:block;font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase}
  .home-platform-title{color:var(--text);display:block;font-size:13px;font-weight:700;line-height:1.3;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .home-platform-meta{color:var(--muted);display:block;font-size:11px;margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .home-dashboard-grid{display:grid;gap:16px;grid-template-columns:minmax(0,1.3fr) minmax(280px,.7fr)}
  .home-panel{background:var(--surface);border:1px solid var(--line);border-radius:10px;min-width:0;padding:18px}
  .home-panel h2{font-size:18px;margin:0}
  .home-panel-intro{color:var(--muted);font-size:12px;margin:4px 0 18px}
  .home-rhythm{align-items:end;display:grid;gap:5px;grid-template-columns:repeat(24,minmax(5px,1fr));height:126px}
  .home-rhythm-bar{background:var(--blue);border-radius:3px 3px 1px 1px;min-height:4px;opacity:.9}
  .home-rhythm-labels{color:var(--quiet);display:grid;font-size:10px;grid-template-columns:repeat(8,1fr);margin-top:7px}
  .home-rhythm-labels span{text-align:center}
  .home-mix{display:flex;flex-direction:column;gap:12px}
  .home-mix-row{display:grid;gap:10px;grid-template-columns:72px minmax(0,1fr) 36px}
  .home-mix-label{color:var(--muted);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .home-mix-track{background:var(--surface-raised);border-radius:3px;height:8px;overflow:hidden;margin-top:4px}
  .home-mix-track span{background:var(--blue);display:block;height:100%}
  .home-mix-count{color:var(--text);font-size:12px;text-align:right}
  .home-empty{border:1px dashed var(--line-strong);border-radius:8px;color:var(--quiet);font-size:13px;padding:24px;text-align:center;width:100%}
  .home-recent-list{border-top:1px solid var(--line);list-style:none;margin:0;padding:0}
  .home-recent-item{align-items:center;border-bottom:1px solid var(--line);display:grid;gap:14px;grid-template-columns:52px minmax(0,1fr) auto;min-height:78px;padding:11px 2px}
  .home-recent-art,.home-recent-placeholder{background:var(--surface-raised);border-radius:7px;display:block;height:52px;object-fit:cover;width:52px}
  .home-recent-placeholder{align-items:center;color:var(--quiet);display:flex;font-size:11px;justify-content:center}
  .home-recent-copy{min-width:0}
  .home-recent-labels{align-items:center;display:flex;gap:8px}
  .home-recent-source{color:var(--blue);font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase}
  .home-recent-kind{color:var(--quiet);font-size:10px;text-transform:uppercase}
  .home-recent-title{color:var(--text);display:block;font-size:14px;font-weight:700;line-height:1.3;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .home-recent-meta{color:var(--muted);display:block;font-size:11px;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .home-recent-time{color:var(--quiet);font-size:11px;text-align:right;white-space:nowrap}
  .home-footnote{color:var(--quiet);font-size:11px;margin:12px 0 0}
  @media(max-width:780px){.home-profile{align-items:flex-start;flex-direction:column}.home-profile-status{text-align:left}.home-status-line{justify-content:flex-start}.home-metric-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.home-dashboard-grid{grid-template-columns:1fr}}
  @media(max-width:520px){.home-profile-main{align-items:flex-start;gap:14px}.home-avatar,.home-avatar-placeholder{flex-basis:68px;height:68px;width:68px}.home-profile h1{font-size:30px}.home-metric-value{font-size:24px}.home-section-head{align-items:flex-start;flex-direction:column;gap:5px}.home-section-head a{margin-top:4px}.home-media-tile{flex-basis:132px}.home-media-tile img,.home-media-placeholder{height:132px;width:132px}.home-recent-item{gap:10px;grid-template-columns:44px minmax(0,1fr)}.home-recent-art,.home-recent-placeholder{height:44px;width:44px}.home-recent-time{grid-column:2;text-align:left}.home-recent-title{font-size:13px}}
`;

interface RankedTitle {
  title: string;
  image: string;
  source: string;
  kind: string;
  count: number;
}

function formatDate(activity: Activity): { date: string; time: string; datetime: string } {
  const raw = activity.occurredAt ?? activity.firstSeenAt;
  if (activity.occurredAtPrecision === 'label') return { date: raw, time: '', datetime: '' };
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return { date: raw, time: '', datetime: '' };
  const date = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: 'short', day: 'numeric',
  }).format(parsed);
  const time = activity.occurredAtPrecision === 'exact'
    ? new Intl.DateTimeFormat('en', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(parsed)
    : '';
  return { date, time, datetime: parsed.toISOString() };
}

function activityMeta(activity: Activity): string {
  const details: string[] = [];
  const add = (value: unknown) => details.push(html(value));
  if (activity.status) add(activity.status.replaceAll('_', ' '));
  if (activity.extra.artist) add(activity.extra.artist);
  else if (activity.extra.author) add(`by ${activity.extra.author}`);
  else if (activity.extra.channel) add(activity.extra.channel);
  if (activity.extra.watchedEpisodes != null && activity.extra.totalEpisodes != null) {
    add(`${activity.extra.watchedEpisodes}/${activity.extra.totalEpisodes} episodes`);
  } else if (activity.extra.progress != null) {
    add(`progress ${activity.extra.progress}`);
  }
  if (activity.extra.platform) add(activity.extra.platform);
  if (activity.extra.playtime) add(activity.extra.playtime);
  if (activity.extra.venue) add(activity.extra.venue);
  if (activity.extra.year) add(activity.extra.year);
  if (activity.rating) details.push(`★ ${html(activity.rating.value)}/${html(activity.rating.scale)}`);
  return details.join(' · ');
}

function imageOrPlaceholder(image: string, className: string, label: string): string {
  if (image) return `<img class="${className}" data-adaptive-media src="${html(image)}" alt="${html(label)}" loading="lazy">`;
  const placeholder = className === 'home-platform-art' ? 'home-platform-placeholder' : 'home-recent-placeholder';
  return `<span class="${placeholder}" aria-hidden="true">${html(label.slice(0, 1).toUpperCase())}</span>`;
}

function durationLabel(timeSpent: TimeSpentSummary | null, window: keyof TimeSpentSummary['total']): string {
  if (!timeSpent || !timeSpent.total[window]) return '—';
  const approximate = timeSpent.sources.some((entry) => entry.method === 'estimated' && entry.windows[window] > 0);
  return `${approximate ? '~' : ''}${timeAmount(timeSpent.total[window])}`;
}

function rankedTitles(activities: Activity[]): RankedTitle[] {
  const grouped = new Map<string, RankedTitle>();
  for (const activity of activities) {
    const key = `${activity.source}:${activity.title.trim().toLocaleLowerCase('en-US')}`;
    const current = grouped.get(key);
    if (current) current.count++;
    else grouped.set(key, {
      title: activity.title,
      image: activity.image,
      source: activity.source,
      kind: activity.mediaKind,
      count: 1,
    });
  }
  return [...grouped.values()]
    .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title))
    .slice(0, 8);
}

function mediaMix(activities: Activity[]): Array<{ kind: string; count: number }> {
  const counts = new Map<string, number>();
  for (const activity of activities) counts.set(activity.mediaKind, (counts.get(activity.mediaKind) ?? 0) + 1);
  return [...counts.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count);
}

function exactHours(activities: Activity[]): number[] {
  const counts = Array.from({ length: 24 }, () => 0);
  for (const activity of activities) {
    if (activity.occurredAtPrecision !== 'exact') continue;
    const parsed = new Date(activity.occurredAt ?? '');
    if (Number.isNaN(parsed.getTime())) continue;
    const hour = Number(new Intl.DateTimeFormat('en', {
      timeZone: 'Asia/Taipei', hour: '2-digit', hourCycle: 'h23',
    }).format(parsed));
    if (Number.isInteger(hour) && hour >= 0 && hour < 24) counts[hour]++;
  }
  return counts;
}

function profileAvatar(data: HomepageData): string {
  if (data.avatar) return `<img class="home-avatar" src="${html(data.avatar)}" alt="${html(data.ownerName)}" loading="eager">`;
  return `<span class="home-avatar-placeholder" aria-hidden="true">${html(data.ownerName.slice(0, 1).toUpperCase())}</span>`;
}

function sourceHighlight(activity: Activity): string {
  const when = formatDate(activity);
  const meta = [activity.status?.replaceAll('_', ' '), activity.extra.artist ?? activity.extra.author ?? activity.extra.channel, when.date]
    .filter(Boolean)
    .join(' · ');
  return `<a class="home-platform-tile" href="/platforms/${html(activity.source)}">
    ${imageOrPlaceholder(activity.image, 'home-platform-art', activity.title)}
    <span class="home-platform-copy"><span class="home-platform-source">${html(sourceLabel(activity.source))}</span><span class="home-platform-title">${html(activity.title)}</span><span class="home-platform-meta">${html(meta)}</span></span>
  </a>`;
}

function albumTile(album: StatsfmAlbum, index: number): string {
  const image = album.image
    ? `<img src="${html(album.image)}" alt="${html(album.name)}" loading="lazy">`
    : '<span class="home-media-placeholder" aria-hidden="true">A</span>';
  return `<article class="home-media-tile">${image}<span class="home-rank">#${index + 1} · ${html(album.streams)} streams</span><span class="home-media-title">${html(album.name)}</span><span class="home-media-meta">${html(album.artist)}</span></article>`;
}

function artistTile(artist: StatsfmArtist, index: number): string {
  const image = artist.image
    ? `<img src="${html(artist.image)}" alt="${html(artist.name)}" loading="lazy">`
    : '<span class="home-media-placeholder" aria-hidden="true">A</span>';
  return `<article class="home-media-tile artist">${image}<span class="home-rank">#${index + 1} · ${html(artist.streams)} streams</span><span class="home-media-title">${html(artist.name)}</span></article>`;
}

function titleTile(title: RankedTitle): string {
  const image = title.image
    ? `<img src="${html(title.image)}" alt="${html(title.title)}" loading="lazy">`
    : `<span class="home-media-placeholder" aria-hidden="true">${html(title.title.slice(0, 1).toUpperCase())}</span>`;
  return `<article class="home-media-tile">${image}<span class="home-rank">${html(title.count)} recorded</span><span class="home-media-title">${html(title.title)}</span><span class="home-media-meta">${html(sourceLabel(title.source))} · ${html(title.kind)}</span></article>`;
}

function recentRow(activity: Activity): string {
  const when = formatDate(activity);
  const meta = activityMeta(activity);
  const time = when.time ? `${when.date} · ${when.time}` : when.date;
  return `<li class="home-recent-item">
    ${imageOrPlaceholder(activity.image, 'home-recent-art', activity.title)}
    <span class="home-recent-copy"><span class="home-recent-labels"><span class="home-recent-source">${html(sourceLabel(activity.source))}</span><span class="home-recent-kind">${html(activity.mediaKind)}</span></span><span class="home-recent-title">${html(activity.title)}</span><span class="home-recent-meta">${html(meta)}</span></span>
    <time class="home-recent-time"${when.datetime ? ` datetime="${html(when.datetime)}"` : ''}>${html(time)}${when.time ? ' GMT+8' : ''}</time>
  </li>`;
}

function metric(label: string, value: string, note: string): string {
  return `<div class="home-metric"><span class="home-metric-label">${html(label)}</span><strong class="home-metric-value">${html(value)}</strong><span class="home-metric-note">${html(note)}</span></div>`;
}

function rhythmPanel(activities: Activity[]): string {
  const counts = exactHours(activities);
  const max = Math.max(1, ...counts);
  const bars = counts.map((count, hour) => `<span class="home-rhythm-bar" style="height:${count ? Math.max(10, Math.round(count / max * 100)) : 4}%" title="${hour}:00 · ${count} activities" aria-label="${hour}:00, ${count} activities"></span>`).join('');
  const labels = [0, 3, 6, 9, 12, 15, 18, 21].map((hour) => `<span>${hour}:00</span>`).join('');
  const hasData = counts.some(Boolean);
  return `<div class="home-panel"><h2>Activity rhythm</h2><p class="home-panel-intro">Exact timestamps, shown in Taipei time.</p>${hasData ? `<div class="home-rhythm" role="img" aria-label="Activity by hour">${bars}</div><div class="home-rhythm-labels">${labels}</div>` : '<div class="home-empty">No exact timestamps have been collected yet.</div>'}</div>`;
}

function mixPanel(activities: Activity[]): string {
  const entries = mediaMix(activities);
  const max = Math.max(1, ...entries.map((entry) => entry.count));
  const rows = entries.map((entry) => `<div class="home-mix-row"><span class="home-mix-label">${html(entry.kind)}</span><span class="home-mix-track"><span style="width:${Math.max(3, Math.round(entry.count / max * 100))}%"></span></span><strong class="home-mix-count">${html(entry.count)}</strong></div>`).join('');
  return `<div class="home-panel"><h2>Media mix</h2><p class="home-panel-intro">Recent public activity by medium.</p>${rows ? `<div class="home-mix">${rows}</div>` : '<div class="home-empty">No activity has been collected yet.</div>'}</div>`;
}

export function homePage(data: HomepageData): string {
  const ranked = rankedTitles(data.allActivities);
  const weekStreams = data.statsfmStats.weeklyStreams ? String(data.statsfmStats.weeklyStreams) : '—';
  const statsfmNote = data.statsfmStats.weeklyMinutes ? `${Math.round(data.statsfmStats.weeklyMinutes / 60 * 10) / 10}h streamed` : 'stats.fm not synced';
  const recent = data.recentActivities.length
    ? `<ul class="home-recent-list">${data.recentActivities.map(recentRow).join('')}</ul>`
    : '<div class="home-empty">No activity has been collected yet.</div>';
  const albums = data.topAlbums.length
    ? `<div class="home-scroller">${data.topAlbums.slice(0, 10).map(albumTile).join('')}</div>`
    : '<div class="home-empty">No album rankings are available yet.</div>';
  const artists = data.topArtists.length
    ? `<div class="home-scroller">${data.topArtists.slice(0, 10).map(artistTile).join('')}</div>`
    : '<div class="home-empty">No artist rankings are available yet.</div>';
  const titles = ranked.length
    ? `<div class="home-scroller">${ranked.map(titleTile).join('')}</div>`
    : '<div class="home-empty">No repeated titles are available yet.</div>';
  const highlights = data.sourceHighlights.length
    ? `<div class="home-platform-scroller">${data.sourceHighlights.map(sourceHighlight).join('')}</div>`
    : '<div class="home-empty">No platform activity has been collected yet.</div>';
  const updated = data.lastUpdated ? `Updated ${data.lastUpdated}` : 'Waiting for the first sync';
  const profileLink = data.profileUrl
    ? `<a href="${html(data.profileUrl)}" rel="noreferrer">stats.fm profile ↗</a>`
    : '';
  const body = `<div class="home-page">
    <section class="home-profile" aria-labelledby="home-title">
      <div class="home-profile-main">${profileAvatar(data)}<div><span class="home-kicker">Personal media dashboard</span><h1 id="home-title">${html(data.ownerName)}</h1><p class="home-handle">@${html(data.handle)} · watched, read, played, heard, attended</p><div class="home-profile-links">${profileLink}<a href="/feed.xml">RSS feed</a><a href="/api/activities.json">JSON API</a></div></div></div>
      <div class="home-profile-status"><span class="home-status-line"><span class="home-status-dot" aria-hidden="true"></span>Live profile</span><strong>${html(updated)}</strong><span>${html(data.connectedSources)} connected sources</span></div>
    </section>
    <nav class="home-view-nav" aria-label="Dashboard views"><a href="/" aria-current="page">Overview</a><a href="/stats">Time</a><a href="/now">Now</a><a href="/profile">Archive</a><a href="/platforms">Platforms</a></nav>
    <section class="home-metric-grid" aria-label="Overview metrics">
      ${metric('This week', durationLabel(data.timeSpent, 'week'), 'all connected media')}
      ${metric('Music streams', weekStreams, statsfmNote)}
      ${metric('Public entries', String(data.publicActivityCount), 'in the archive')}
      ${metric('Active platforms', String(data.connectedSources), 'currently configured')}
    </section>
    <section class="home-section"><div class="home-section-head"><div><h2>Latest from your platforms</h2><p>One current signal from each connected source.</p></div><a href="/platforms">View all platforms →</a></div>${highlights}</section>
    <section class="home-section"><div class="home-section-head"><div><h2>Top albums</h2><p>stats.fm · last 4 weeks · ranked by streams</p></div><a href="/platforms/statsfm">Open stats.fm →</a></div>${albums}</section>
    <section class="home-section"><div class="home-section-head"><div><h2>Top artists</h2><p>stats.fm · last 4 weeks · ranked by streams</p></div></div>${artists}</section>
    <section class="home-section"><div class="home-section-head"><div><h2>Most revisited</h2><p>Repeated public titles from the available activity history.</p></div><a href="/profile">Open archive →</a></div>${titles}</section>
    <section class="home-section home-dashboard-grid">${rhythmPanel(data.allActivities)}${mixPanel(data.allActivities)}</section>
    <section class="home-section" id="recent"><div class="home-section-head"><div><h2>Recent activity</h2><p>The latest public entries across every medium.</p></div><a href="/profile">Show all →</a></div>${recent}<p class="home-footnote">${data.lastUpdated ? `Last synced ${html(data.lastUpdated)}. ` : ''}High-frequency music and YouTube activity are sampled so every medium remains visible.</p></section>
  </div>`;
  return shell(`${data.ownerName} · overview`, body, 'home', homeStyles);
}
