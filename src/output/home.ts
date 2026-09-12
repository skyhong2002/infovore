import { coverageSources } from './rhythm.js';
import type { PlatformOverview } from './overview.js';
import { recordedCoverage, type CoverageDay } from '../data/coverage.js';
import type { TimeSpentSummary, TimeWindows } from '../data/database.js';
import { dayflowDay, type DayflowSnapshot } from '../dayflow/types.js';
import type { Activity } from '../data/types.js';
import { html, shell, sourceLabel, timeAmount } from './pages.js';
import { healthActivityMeta } from './health-activity.js';

export interface HomepageData {
  ownerName: string;
  avatar: string;
  lastUpdated: string | null;
  allActivities: Activity[];
  recentActivities: Activity[];
  platformOverviews?: PlatformOverview[];
  timeSpent: TimeSpentSummary | null;
  publicActivityCount: number;
  connectedSources: number;
  coverage?: CoverageDay[];
  // Fraction of the last 28 days with any recording, overlaps counted once.
  recordedShare?: number | null;
  dayflow?: DayflowSnapshot | null;
  healthSleepTime?: TimeWindows | null;
}

const homeStyles = `
  .home-platform-tile img[src="/logos/healthconnect.png"],.home-recent-art[src="/logos/healthconnect.png"]{background:#fff;object-fit:contain;padding:8px}.home-platform-tile[href="/platforms/health"] .home-platform-meta{white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}.home-recent-title{text-decoration:none}.home-rhythm-legend{display:flex;flex-wrap:wrap;gap:10px;font-size:10px;color:var(--muted);margin-top:10px}.home-rhythm-legend i{display:inline-block;width:8px;height:8px;margin-right:4px}.home-time-list .home-time-row{grid-template-columns:110px minmax(0,1fr) 58px}
  .home-keywords{display:flex;flex-wrap:wrap;gap:5px;margin-top:6px;color:var(--muted);font-size:11px}
  .home-keywords span{background:var(--surface-raised);border-radius:4px;padding:3px 6px;overflow-wrap:anywhere}
  .home-platform-tile[href="/platforms/dayflow"] .home-platform-meta{white-space:normal}
  .home-coverage-axis{display:flex;justify-content:space-between;color:var(--quiet);font-size:10px;margin:0 0 10px}
  .home-coverage-day{margin-top:10px}.home-coverage-label{display:flex;justify-content:space-between;color:var(--muted);font-size:11px;margin-bottom:4px}
  .home-coverage-track{background:repeating-linear-gradient(to right,transparent 0,transparent calc(100% / 24 - 1px),var(--line) calc(100% / 24 - 1px),var(--line) calc(100% / 24)),var(--surface-raised);border-radius:3px;overflow:hidden;padding:2px 0}
  .home-coverage-lane{position:relative;height:6px;margin:1px 0}.home-coverage-lane span{position:absolute;top:0;height:100%;border-radius:1px}
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
  .home-platform-scroller{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));gap:10px}
  .home-platform-tile{align-items:center;background:var(--surface);border:1px solid var(--line);border-radius:10px;color:inherit;display:flex;flex:0 0 260px;gap:12px;min-height:88px;padding:10px;text-decoration:none;scroll-snap-align:start}
  .home-platform-tile:hover{border-color:var(--line-strong)}
  .home-platform-tile img,.home-platform-placeholder{background:var(--surface-raised);border-radius:7px;display:block;flex:0 0 66px;height:66px;object-fit:cover;width:66px}
  .home-platform-placeholder{align-items:center;color:var(--blue);display:flex;font-size:20px;font-weight:700;justify-content:center}
  .home-platform-copy{min-width:0}
  .home-platform-source{color:var(--blue);display:block;font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase}
  .home-platform-title{color:var(--text);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;font-size:13px;font-weight:700;line-height:1.3;margin-top:3px;overflow:hidden;overflow-wrap:anywhere}
  .home-platform-meta{color:var(--muted);display:block;font-size:11px;margin-top:4px;white-space:normal;line-height:1.5}
  .home-dashboard-grid{display:grid;gap:16px;grid-template-columns:minmax(0,1.3fr) minmax(280px,.7fr)}
  .home-panel{background:var(--surface);border:1px solid var(--line);border-radius:10px;min-width:0;padding:18px}
  .home-panel h2{font-size:18px;margin:0}
  .home-panel-intro{color:var(--muted);font-size:12px;margin:4px 0 18px}




  .home-time-list{display:flex;flex-direction:column;gap:13px}
  .home-time-row{align-items:center;color:inherit;display:grid;gap:12px;grid-template-columns:88px minmax(0,1fr) 58px;text-decoration:none}
  .home-time-row:hover .home-time-label{color:var(--blue)}
  .home-time-label{color:var(--muted);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .home-time-track{background:var(--surface-raised);border-radius:3px;height:8px;overflow:hidden}
  .home-time-track span{background:var(--blue);display:block;height:100%}
  .home-time-value{color:var(--text);font-size:12px;text-align:right;white-space:nowrap}
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
  @media(max-width:520px){.home-profile-main{align-items:flex-start;gap:14px}.home-avatar,.home-avatar-placeholder{flex-basis:68px;height:68px;width:68px}.home-profile h1{font-size:30px}.home-metric-value{font-size:24px}.home-section-head{align-items:flex-start;flex-direction:column;gap:5px}.home-section-head a{margin-top:4px}.home-time-row{grid-template-columns:74px minmax(0,1fr) 52px}.home-recent-item{gap:10px;grid-template-columns:44px minmax(0,1fr)}.home-recent-art,.home-recent-placeholder{height:44px;width:44px}.home-recent-time{grid-column:2;text-align:left}.home-recent-title{font-size:13px}}
`;

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
  if (activity.source === 'health') return html(healthActivityMeta(activity));
  if (activity.source === 'dayflow') return html(`${timeAmount(Number(activity.extra.activeMinutes) * 60)} active · ${timeAmount(Number(activity.extra.idleMinutes) * 60)} idle`);
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
  if (activity.extra.distanceKm) add(`${activity.extra.distanceKm} km`);
  if (activity.extra.kilocalories) add(`${activity.extra.kilocalories} kcal`);
  if (activity.extra.exerciseMinutes) add(`${activity.extra.exerciseMinutes} min active`);
  if (activity.extra.sleepHours) add(`${activity.extra.sleepHours} h sleep`);
  if (activity.extra.heartRateAverage) add(`${activity.extra.heartRateAverage} bpm avg`);
  if (activity.extra.year) add(activity.extra.year);
  if (activity.rating) details.push(`★ ${html(activity.rating.value)}/${html(activity.rating.scale)}`);
  return details.join(' · ');
}


function imageOrPlaceholder(image: string, className: string, label: string): string {
  if (image) return `<img class="${className}" data-adaptive-media src="${html(image)}" alt="${html(label)}" loading="lazy">`;
  const placeholder = className === 'home-platform-art' ? 'home-platform-placeholder' : 'home-recent-placeholder';
  return `<span class="${placeholder}" aria-hidden="true">${html(label.slice(0, 1).toUpperCase())}</span>`;
}

function shareLabel(share: number | null | undefined): string {
  return share ? `${Math.round(share * 100)}%` : '—';
}

// The platform list follows the same 28 days as the recorded-time share and
// falls back to lifetime totals until two platforms have recent time.
function homeTimeWindow(timeSpent: TimeSpentSummary | null): { key: 'last28d' | 'allTime'; label: string } {
  const recentSources = timeSpent?.sources.filter((entry) => entry.windows.last28d > 0).length ?? 0;
  return recentSources >= 2 ? { key: 'last28d', label: 'in the last 28 days' } : { key: 'allTime', label: 'all time' };
}

function last28Days(): string {
  return new Date(Date.parse(`${dayflowDay()}T00:00:00Z`) - 27 * 86_400_000).toISOString().slice(0, 10);
}

function activeDays(activities: Activity[]): number {
  const days = new Set<string>();
  for (const activity of activities) {
    const raw = activity.occurredAt ?? activity.firstSeenAt;
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
      if (raw) days.add(raw.slice(0, 10));
      continue;
    }
    days.add(new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(parsed));
  }
  return days.size;
}

function profileAvatar(data: HomepageData): string {
  if (data.avatar) return `<img class="home-avatar" src="${html(data.avatar)}" alt="${html(data.ownerName)}" loading="eager">`;
  return `<span class="home-avatar-placeholder" aria-hidden="true">${html(data.ownerName.slice(0, 1).toUpperCase())}</span>`;
}

function dailyKeywords(activity: Activity, dayflow?: DayflowSnapshot | null): string {
  const day = dayflow?.extra.daily.find(day => `day:${day.day}` === activity.sourceItemId);
  return day?.keywords?.length ? `<span class="home-keywords">${day.keywords.slice(0, 6).map(k => `<span>${html(k.name)}</span>`).join('')}</span>` : '';
}

function overviewTile(item: PlatformOverview): string {
  return `<a class="home-platform-tile" href="/platforms/${html(item.source)}">
    ${imageOrPlaceholder(item.image, 'home-platform-art', item.title)}
    <span class="home-platform-copy"><span class="home-platform-source">${html(sourceLabel(item.source))}</span><span class="home-platform-title" title="${html(item.title)}">${html(item.title)}</span><span class="home-platform-meta">${html(item.detail)}</span></span>
  </a>`;
}

function recentRow(activity: Activity, dayflow?: DayflowSnapshot | null): string {
  const when = formatDate(activity);
  const meta = activityMeta(activity);
  const time = when.time ? `${when.date} · ${when.time}` : when.date;
  return `<li class="home-recent-item">
    ${imageOrPlaceholder(activity.image, 'home-recent-art', activity.title)}
    <span class="home-recent-copy"><span class="home-recent-labels"><span class="home-recent-source">${html(sourceLabel(activity.source))}</span><span class="home-recent-kind">${html(activity.mediaKind)}</span></span>${activity.source === 'health' || activity.source === 'dayflow' ? `<a class="home-recent-title" href="/platforms/${html(activity.source)}${activity.status === 'sleep' ? '#sleep' : ''}">${html(activity.title)}</a>` : `<span class="home-recent-title">${html(activity.title)}</span>`}<span class="home-recent-meta" title="${meta}">${meta}</span>${activity.source === 'dayflow' ? dailyKeywords(activity, dayflow) : ''}</span>
    <time class="home-recent-time"${when.datetime ? ` datetime="${html(when.datetime)}"` : ''}>${html(time)}${when.time ? ' GMT+8' : ''}</time>
  </li>`;
}

function metric(label: string, value: string, note: string): string {
  return `<div class="home-metric"><span class="home-metric-label">${html(label)}</span><strong class="home-metric-value">${html(value)}</strong><span class="home-metric-note">${html(note)}</span></div>`;
}

function timePanel(timeSpent: TimeSpentSummary | null, sleepTime?: TimeWindows | null, dayflow?: DayflowSnapshot | null): string {
  const window = homeTimeWindow(timeSpent);
  const today = dayflowDay();
  const computerSeconds = dayflow?.extra.daily.filter(day => day.day <= today && (window.key === 'allTime' || day.day >= last28Days())).reduce((sum, day) => sum + day.activeMinutes * 60, 0) ?? 0;
  const entries = [...(timeSpent?.sources ?? []), ...(computerSeconds ? [{ source: 'dayflow', method: 'measured' as const, windows: { last28d: computerSeconds, allTime: computerSeconds } }] : []), ...(sleepTime ? [{ source: 'health-sleep', method: 'measured' as const, windows: sleepTime }] : [])]
    .filter((entry) => entry.windows[window.key] > 0)
    .sort((a, b) => b.windows[window.key] - a.windows[window.key]);
  if (!entries.length) return `<div class="home-panel"><h2>Time by platform</h2><p class="home-panel-intro">No time records are available yet.</p><div class="home-empty">Time appears after the first platform sync.</div></div>`;
  const max = Math.max(1, ...entries.map((entry) => entry.windows[window.key]));
  const rows = entries.map((entry) => {
    const seconds = entry.windows[window.key];
    const approx = entry.method === 'estimated' ? '~' : '';
    const label = entry.source === 'dayflow' ? 'Dayflow · active' : entry.source === 'health-sleep' ? 'Health · sleep' : entry.source === 'health' ? 'Health · exercise' : sourceLabel(entry.source);
    const href = entry.source === 'health-sleep' ? '/platforms/health#sleep' : `/platforms/${html(entry.source)}`;
    return `<a class="home-time-row" href="${href}" data-source="${html(entry.source)}"><span class="home-time-label" title="${html(label)}">${html(label)}</span><span class="home-time-track"><span style="width:${Math.max(3, Math.round(seconds / max * 100))}%${entry.source.startsWith('health') ? `;background:${entry.source === 'health-sleep' ? '#a8c7fa' : '#67d5c3'}` : ''}"></span></span><strong class="home-time-value">${approx}${timeAmount(seconds)}</strong></a>`;
  }).join('');
  return `<div class="home-panel"><h2>Time by platform</h2><p class="home-panel-intro">Where the recorded time went ${window.label}.</p><div class="home-time-list">${rows}</div>${computerSeconds ? '<p class="home-footnote">Dayflow shows active computer time by recorded day. It can overlap other platforms; the recorded-time share above counts overlaps once.</p>' : ''}${entries.some((entry) => entry.source === 'health-sleep') ? '<p class="home-footnote">Sleep = recorded sessions, including awake time, shown separately from exercise.</p>' : ''}</div>`;
}

function rhythmPanel(coverage: CoverageDay[]): string {
  const days = coverage.slice(0, 7);
  const sources = coverageSources;
  const clock = (hour: number) => `${String(Math.floor(hour)).padStart(2, '0')}:${String(Math.min(59, Math.floor((hour % 1) * 60 + 0.00001))).padStart(2, '0')}`;
  const rows = days.map(day => `<div class="home-coverage-day" data-day="${day.day}" data-recorded-seconds="${day.recordedSeconds}">
    <div class="home-coverage-label"><time datetime="${day.day}">${day.day.slice(5)}</time><span>${html(timeAmount(day.recordedSeconds))} / 24h</span></div>
    <div class="home-coverage-track" aria-label="${day.day}: ${html(timeAmount(day.recordedSeconds))} recorded out of 24 hours">
      ${day.lanes.length ? day.lanes.map(lane => `<div class="home-coverage-lane" data-source="${html(lane.source)}">${lane.spans.map(span => `<span style="left:${span.startHour / 24 * 100}%;width:${(span.endHour - span.startHour) / 24 * 100}%;background:${sources[lane.source]?.color ?? '#8caacb'}" title="${html(sources[lane.source]?.label ?? lane.source)} · ${clock(span.startHour)}–${clock(span.endHour)}"></span>`).join('')}</div>`).join('') : '<div class="home-coverage-lane"></div>'}
    </div></div>`).join('');
  return `<div class="home-panel"><h2>Activity rhythm</h2><a href="/card/activity-rhythm.svg" style="float:right;color:var(--muted);font-size:11px">Share card ↗</a><p class="home-panel-intro">Recorded time each day · recent 7 days · Taipei time</p>
    <div class="home-coverage-axis"><span>00</span><span>06</span><span>12</span><span>18</span><span>24h</span></div>${rows}
    <div class="home-rhythm-legend">${Object.values(sources).map(source => `<span><i style="background:${source.color}"></i>${source.label}</span>`).join('')}<span><i style="background:var(--surface-raised)"></i>Unrecorded</span></div>
    <p class="home-footnote">Overlapping time counts once. Dayflow includes idle records; analysis errors are excluded. Music uses track duration. Daily totals and events without a duration are excluded.</p></div>`;
}

export function homePage(data: HomepageData): string {
  const recent = data.recentActivities.length
    ? `<ul class="home-recent-list">${data.recentActivities.map(activity => recentRow(activity, data.dayflow)).join('')}</ul>`
    : '<div class="home-empty">No activity has been collected yet.</div>';
  const highlights = data.platformOverviews?.length
    ? `<div class="home-platform-scroller">${data.platformOverviews.map(overviewTile).join('')}</div>`
    : '<div class="home-empty">No platform summaries are available yet.</div>';
  const updated = data.lastUpdated ? `Updated ${data.lastUpdated}` : 'Waiting for the first sync';
  const body = `<div class="home-page">
    <section class="home-profile" aria-labelledby="home-title">
      <div class="home-profile-main">${profileAvatar(data)}<div><span class="home-kicker">Personal lifelog dashboard</span><h1 id="home-title">${html(data.ownerName)}</h1><p class="home-handle">Watched, read, played, heard, attended, moved</p><div class="home-profile-links"><a href="/platforms">Connected platforms</a><a href="/cards#word-cloud">28-day word cloud</a><a href="/feed.xml">RSS feed</a><a href="/api/activities.json">JSON API</a></div></div></div>
      <div class="home-profile-status"><span class="home-status-line"><span class="home-status-dot" aria-hidden="true"></span>Live profile</span><strong>${html(updated)}</strong><span>${html(data.connectedSources)} connected sources</span></div>
    </section>
    <nav class="home-view-nav" aria-label="Dashboard views"><a href="/" aria-current="page">Overview</a><a href="/stats">Time</a><a href="/now">Now</a><a href="/profile">Archive</a><a href="/platforms">Platforms</a></nav>
    <section class="home-metric-grid" aria-label="Overview metrics">
      ${metric('Time recorded', shareLabel(data.recordedShare), 'of the last 28 days')}
      ${metric('Active days', String(activeDays(data.allActivities)), 'available timeline')}
      ${metric('Public entries', String(data.publicActivityCount), 'in the archive')}
      ${metric('Active platforms', String(data.connectedSources), 'currently configured')}
    </section>
    <section class="home-section"><div class="home-section-head"><div><h2>Platform overview</h2><p>Current interests, library progress and recent trends.</p></div><a href="/platforms">View all platforms →</a></div>${highlights}</section>
    <section class="home-section home-dashboard-grid">${rhythmPanel(data.coverage ?? recordedCoverage([]))}${timePanel(data.timeSpent, data.healthSleepTime, data.dayflow)}</section>
    <section class="home-section" id="recent"><div class="home-section-head"><div><h2>Recent activity</h2><p>The latest public activity from each source.</p></div><a href="/profile">Show all →</a></div>${recent}<p class="home-footnote">${data.lastUpdated ? `Last synced ${html(data.lastUpdated)}. ` : ''}Each source appears once, with its latest activity.</p></section>
  </div>`;
  return shell(`${data.ownerName} · overview`, body, 'home', homeStyles);
}
