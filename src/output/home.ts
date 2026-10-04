import { coverageSources, platformColors } from './rhythm.js';
import { agentName, type WorkBlock } from '../computai/types.js';
import type { PlatformOverview } from './overview.js';
import { recordedCoverage, type CoverageDay } from '../data/coverage.js';
import type { TimeSpentSummary, TimeWindows } from '../data/database.js';
import { dayflowDay, type DayflowSnapshot } from '../dayflow/types.js';
import { taipeiDay, dateFormat } from '../data/time.js';
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
  agentTime?: TimeWindows | null;
}

const homeStyles = `
  .home-page{margin:0 auto}
  .home-profile{align-items:center;background:linear-gradient(135deg,var(--accent-soft),var(--surface) 55%);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);display:flex;gap:26px;justify-content:space-between;padding:28px 30px}
  .home-profile-main{align-items:center;display:flex;gap:22px;min-width:0}
  .home-avatar,.home-avatar-placeholder{background:var(--surface-raised);border-radius:50%;box-shadow:0 0 0 4px var(--surface),0 0 0 5px var(--line);display:block;flex:0 0 92px;height:92px;object-fit:cover;width:92px}
  .home-avatar-placeholder{align-items:center;color:var(--accent);display:flex;font-size:34px;font-weight:700;justify-content:center}
  .home-kicker{color:var(--gold);font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase}
  .home-profile h1{font-family:var(--display);font-size:52px;font-weight:400;letter-spacing:-.02em;line-height:1;margin:6px 0 6px}
  .home-handle{color:var(--muted);font-size:15px;margin:0}
  .home-profile-links{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:14px}
  .home-profile-links a{color:var(--muted);font-size:13px;text-decoration:none}.home-profile-links a:hover{color:var(--accent)}
  .home-profile-status{color:var(--quiet);flex:0 0 auto;font-size:12.5px;max-width:200px;text-align:right}
  .home-profile-status strong{color:var(--text);display:block;font-size:13.5px;margin:4px 0}
  .home-status-line{align-items:center;display:flex;gap:6px;justify-content:flex-end}
  .home-status-dot{background:var(--ok);border-radius:50%;box-shadow:0 0 0 3px color-mix(in srgb,var(--ok) 25%,transparent);height:7px;width:7px}
  .home-metric-grid{display:grid;gap:12px;grid-template-columns:repeat(4,minmax(0,1fr));margin-top:16px}
  .home-metric{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-sm);box-shadow:var(--shadow);min-height:104px;overflow:hidden;padding:16px 18px;position:relative}
  .home-metric::before{background:linear-gradient(90deg,var(--accent),var(--gold));content:"";height:3px;left:0;position:absolute;right:0;top:0;opacity:.8}
  .home-metric-label{color:var(--muted);display:block;font-size:11.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
  .home-metric-value{color:var(--text);display:block;font-size:30px;font-variant-numeric:tabular-nums;font-weight:700;letter-spacing:-.03em;line-height:1.1;margin-top:12px}
  .home-metric-note{color:var(--quiet);display:block;font-size:12px;margin-top:5px}
  .home-section{margin-top:44px}
  .home-section-head{align-items:end;display:flex;gap:16px;justify-content:space-between;margin-bottom:14px}
  .home-section-head h2{font-size:22px;line-height:1.2;margin:0}
  .home-section-head p{color:var(--muted);font-size:13px;margin:3px 0 0}
  .home-section-head a{color:var(--muted);font-size:13px;text-decoration:none;white-space:nowrap}.home-section-head a:hover{color:var(--accent)}
  .home-platform-scroller{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));gap:12px}
  .home-platform-tile{align-items:center;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-sm);box-shadow:var(--shadow);color:inherit;display:flex;gap:13px;min-height:92px;padding:12px;text-decoration:none;transition:border-color .15s,transform .15s}
  .home-platform-tile:hover{border-color:var(--line-strong);color:inherit;transform:translateY(-2px)}
  .home-platform-tile img,.home-platform-placeholder{background:var(--surface-raised);border-radius:9px;display:block;flex:0 0 66px;height:66px;object-fit:cover;width:66px}
  .home-platform-tile img[src="/logos/healthconnect.png"],.home-recent-art[src="/logos/healthconnect.png"]{background:#fff;object-fit:contain;padding:8px}
  .home-platform-placeholder{align-items:center;color:var(--accent);display:flex;font-size:20px;font-weight:700;justify-content:center}
  .home-platform-copy{min-width:0}
  .home-platform-source{color:var(--accent);display:block;font-size:10.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase}
  .home-platform-title{color:var(--text);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;font-size:14px;font-weight:700;line-height:1.3;margin-top:3px;overflow:hidden;overflow-wrap:anywhere}
  .home-platform-meta{color:var(--muted);display:block;font-size:12px;line-height:1.5;margin-top:4px;white-space:normal}
  .home-platform-tile[href="/platforms/health"] .home-platform-meta,.home-platform-tile[href="/platforms/dayflow"] .home-platform-meta{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .home-dashboard-grid{display:grid;gap:16px;grid-template-columns:minmax(0,1.3fr) minmax(300px,.7fr)}
  .home-panel{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);min-width:0;padding:22px}
  .home-panel h2{font-size:18px;margin:0}
  .home-panel-intro{color:var(--muted);font-size:12.5px;margin:4px 0 18px}
  .home-panel-link{color:var(--muted);float:right;font-size:12px;text-decoration:none}.home-panel-link:hover{color:var(--accent)}
  .home-coverage-axis{display:flex;justify-content:space-between;color:var(--quiet);font-size:10.5px;font-variant-numeric:tabular-nums;margin:0 0 10px}
  .home-coverage-day{margin-top:10px}.home-coverage-label{display:flex;justify-content:space-between;color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums;margin-bottom:4px}
  .home-coverage-track{background:repeating-linear-gradient(to right,transparent 0,transparent calc(100% / 24 - 1px),var(--line) calc(100% / 24 - 1px),var(--line) calc(100% / 24)),var(--surface-raised);border-radius:4px;overflow:hidden;padding:2px 0}
  .home-coverage-lane{position:relative;height:6px;margin:1px 0}.home-coverage-lane span{position:absolute;top:0;height:100%;border-radius:1px}
  .home-rhythm-legend{display:flex;flex-wrap:wrap;gap:6px 12px;font-size:11px;color:var(--muted);margin-top:12px}
  .home-rhythm-legend i{border-radius:2px;display:inline-block;width:9px;height:9px;margin-right:5px;vertical-align:-1px}
  .home-keywords{display:flex;flex-wrap:wrap;gap:5px;margin-top:6px;color:var(--muted);font-size:11.5px}
  .home-keywords span{background:var(--surface-raised);border-radius:5px;padding:3px 7px;overflow-wrap:anywhere}
  .home-time-list{display:flex;flex-direction:column;gap:13px}
  .home-time-row{align-items:center;color:inherit;display:grid;gap:12px;grid-template-columns:118px minmax(0,1fr) 60px;text-decoration:none}
  .home-time-row:hover .home-time-label{color:var(--accent)}
  .home-time-label{color:var(--muted);font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .home-time-track{background:var(--surface-raised);border-radius:4px;height:9px;overflow:hidden}
  .home-time-track span{background:var(--accent);border-radius:4px;display:block;height:100%}
  .home-time-value{color:var(--text);font-size:12.5px;font-variant-numeric:tabular-nums;font-weight:700;text-align:right;white-space:nowrap}
  .home-empty{border:1px dashed var(--line-strong);border-radius:var(--radius-sm);color:var(--quiet);font-size:13px;padding:24px;text-align:center;width:100%}
  .home-recent-list{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);list-style:none;margin:0;overflow:hidden;padding:0}
  .home-recent-item{align-items:center;border-bottom:1px solid var(--line);display:grid;gap:14px;grid-template-columns:52px minmax(0,1fr) auto;min-height:78px;padding:12px 18px;transition:background .15s}
  .home-recent-item:last-child{border-bottom:0}.home-recent-item:hover{background:var(--surface-hover)}
  .home-recent-art,.home-recent-placeholder{background:var(--surface-raised);border-radius:8px;display:block;height:52px;object-fit:cover;width:52px}
  .home-recent-placeholder{align-items:center;color:var(--quiet);display:flex;font-size:11px;justify-content:center}
  .home-recent-copy{min-width:0}
  .home-recent-labels{align-items:center;display:flex;gap:8px}
  .home-recent-source{color:var(--accent);font-size:10.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase}
  .home-recent-kind{color:var(--quiet);font-size:10.5px;text-transform:uppercase}
  .home-recent-title{color:var(--text);display:block;font-size:14.5px;font-weight:700;line-height:1.3;margin-top:3px;overflow:hidden;text-decoration:none;text-overflow:ellipsis;white-space:nowrap}
  a.home-recent-title:hover{color:var(--accent)}
  .home-recent-meta{color:var(--muted);display:block;font-size:12px;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .home-recent-time{color:var(--quiet);font-size:12px;font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
  .home-footnote{color:var(--quiet);font-size:12px;line-height:1.5;margin:12px 0 0}
  @media(max-width:780px){.home-profile{align-items:flex-start;flex-direction:column;padding:22px}.home-profile-status{max-width:none;text-align:left}.home-status-line{justify-content:flex-start}.home-metric-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.home-dashboard-grid{grid-template-columns:1fr}}
  @media(max-width:520px){.home-profile-main{align-items:flex-start;gap:14px}.home-avatar,.home-avatar-placeholder{flex-basis:68px;height:68px;width:68px}.home-profile h1{font-size:40px}.home-metric-value{font-size:24px}.home-section-head{align-items:flex-start;flex-direction:column;gap:5px}.home-section-head a{margin-top:4px}.home-time-row{grid-template-columns:84px minmax(0,1fr) 52px}.home-recent-item{gap:10px;grid-template-columns:44px minmax(0,1fr);padding-inline:14px}.home-recent-art,.home-recent-placeholder{height:44px;width:44px}.home-recent-time{grid-column:2;text-align:left}.home-recent-title{font-size:13.5px}.home-panel{padding:16px}}
`;

function formatDate(activity: Activity): { date: string; time: string; datetime: string } {
  const raw = activity.occurredAt ?? activity.firstSeenAt;
  if (activity.occurredAtPrecision === 'label') return { date: raw, time: '', datetime: '' };
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return { date: raw, time: '', datetime: '' };
  const date = dateFormat('en', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: 'short', day: 'numeric',
  }).format(parsed);
  const time = activity.occurredAtPrecision === 'exact'
    ? dateFormat('en', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(parsed)
    : '';
  return { date, time, datetime: parsed.toISOString() };
}

// A work block: when, how many sessions, which agents and projects. Daily
// summaries from before segments were synced have only a token count.
function computaiMeta(activity: Activity): string {
  const e = activity.extra as Partial<WorkBlock>;
  if (!e.start || !e.end) return 'Claude Code and Codex · every machine';
  const clock = (iso: string) => dateFormat('en', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
  return [`${clock(e.start)}–${clock(e.end)}`, `${e.sessions} session${e.sessions === 1 ? '' : 's'}`,
    (e.sources ?? []).map(agentName).join(', '), (e.projects ?? []).slice(0, 3).join(', ')].filter(Boolean).join(' · ');
}

function activityMeta(activity: Activity): string {
  if (activity.source === 'health') return html(healthActivityMeta(activity));
  if (activity.source === 'dayflow') return html(`${timeAmount(Number(activity.extra.activeMinutes) * 60)} active · ${timeAmount(Number(activity.extra.idleMinutes) * 60)} idle`);
  if (activity.source === 'computai') return html(computaiMeta(activity));
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
    days.add(taipeiDay(parsed));
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
    <span class="home-recent-copy"><span class="home-recent-labels"><span class="home-recent-source">${html(sourceLabel(activity.source))}</span><span class="home-recent-kind">${html(activity.mediaKind)}</span></span>${activity.source === 'health' || activity.source === 'dayflow' || activity.source === 'computai' ? `<a class="home-recent-title" href="/platforms/${html(activity.source)}${activity.status === 'sleep' ? '#sleep' : ''}">${html(activity.title)}</a>` : `<span class="home-recent-title">${html(activity.title)}</span>`}<span class="home-recent-meta" title="${meta}">${meta}</span>${activity.source === 'dayflow' ? dailyKeywords(activity, dayflow) : ''}</span>
    <time class="home-recent-time"${when.datetime ? ` datetime="${html(when.datetime)}"` : ''}>${html(time)}${when.time ? ' GMT+8' : ''}</time>
  </li>`;
}

function metric(label: string, value: string, note: string): string {
  return `<div class="home-metric"><span class="home-metric-label">${html(label)}</span><strong class="home-metric-value">${html(value)}</strong><span class="home-metric-note">${html(note)}</span></div>`;
}

function timePanel(timeSpent: TimeSpentSummary | null, sleepTime?: TimeWindows | null, dayflow?: DayflowSnapshot | null, agentTime?: TimeWindows | null): string {
  const window = homeTimeWindow(timeSpent);
  const today = dayflowDay();
  const computerSeconds = dayflow?.extra.daily.filter(day => day.day <= today && (window.key === 'allTime' || day.day >= last28Days())).reduce((sum, day) => sum + day.activeMinutes * 60, 0) ?? 0;
  const entries = [...(timeSpent?.sources ?? []), ...(computerSeconds ? [{ source: 'dayflow', method: 'measured' as const, windows: { last28d: computerSeconds, allTime: computerSeconds } }] : []), ...(sleepTime ? [{ source: 'health-sleep', method: 'measured' as const, windows: sleepTime }] : []), ...(agentTime ? [{ source: 'computai', method: 'measured' as const, windows: agentTime }] : [])]
    .filter((entry) => entry.windows[window.key] > 0)
    .sort((a, b) => b.windows[window.key] - a.windows[window.key]);
  if (!entries.length) return `<div class="home-panel"><h2>Time by platform</h2><p class="home-panel-intro">No time records are available yet.</p><div class="home-empty">Time appears after the first platform sync.</div></div>`;
  const max = Math.max(1, ...entries.map((entry) => entry.windows[window.key]));
  const rows = entries.map((entry) => {
    const seconds = entry.windows[window.key];
    const approx = entry.method === 'estimated' ? '~' : '';
    const label = entry.source === 'dayflow' ? 'Dayflow · active' : entry.source === 'health-sleep' ? 'Health · sleep' : entry.source === 'health' ? 'Health · exercise' : entry.source === 'computai' ? 'AI agents · working' : sourceLabel(entry.source);
    const href = entry.source === 'health-sleep' ? '/platforms/health#sleep' : `/platforms/${html(entry.source)}`;
    return `<a class="home-time-row" href="${href}" data-source="${html(entry.source)}"><span class="home-time-label" title="${html(label)}">${html(label)}</span><span class="home-time-track"><span style="width:${Math.max(3, Math.round(seconds / max * 100))}%${platformColors[entry.source] ? `;background:${platformColors[entry.source]}` : ''}"></span></span><strong class="home-time-value">${approx}${timeAmount(seconds)}</strong></a>`;
  }).join('');
  return `<div class="home-panel"><h2>Time by platform</h2><p class="home-panel-intro">Where the recorded time went ${window.label}.</p><div class="home-time-list">${rows}</div>${computerSeconds ? '<p class="home-footnote">Dayflow shows active computer time by recorded day. It can overlap other platforms; the recorded-time share above counts overlaps once.</p>' : ''}${entries.some((entry) => entry.source === 'health-sleep') ? '<p class="home-footnote">Sleep = recorded sessions, including awake time, shown separately from exercise.</p>' : ''}${entries.some((entry) => entry.source === 'computai') ? '<p class="home-footnote">AI agents = wall-clock time with any Claude Code or Codex session producing output, parallel sessions counted once.</p>' : ''}</div>`;
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
  return `<div class="home-panel"><h2>Activity rhythm</h2><a class="home-panel-link" href="/card/activity-rhythm.svg">Share card ↗</a><p class="home-panel-intro">Recorded time each day · recent 7 days · Taipei time</p>
    <div class="home-coverage-axis"><span>00</span><span>06</span><span>12</span><span>18</span><span>24h</span></div>${rows}
    <div class="home-rhythm-legend">${Object.values(sources).map(source => `<span><i style="background:${source.color}"></i>${source.label}</span>`).join('')}<span><i style="background:var(--surface-raised)"></i>Unrecorded</span></div>
    <p class="home-footnote">Overlapping time counts once. Dayflow counts active computer time only; idle records and analysis errors are excluded. Music uses track duration; YouTube uses measured or, failing that, estimated watch time. Daily totals and events without a duration are excluded.</p></div>`;
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
    <section class="home-metric-grid" aria-label="Overview metrics">
      ${metric('Time recorded', shareLabel(data.recordedShare), 'of the last 28 days')}
      ${metric('Active days', String(activeDays(data.allActivities)), 'available timeline')}
      ${metric('Public entries', String(data.publicActivityCount), 'in the archive')}
      ${metric('Active platforms', String(data.connectedSources), 'currently configured')}
    </section>
    <section class="home-section"><div class="home-section-head"><div><h2>Platform overview</h2><p>Current interests, library progress and recent trends.</p></div><a href="/platforms">View all platforms →</a></div>${highlights}</section>
    <section class="home-section home-dashboard-grid">${rhythmPanel(data.coverage ?? recordedCoverage([]))}${timePanel(data.timeSpent, data.healthSleepTime, data.dayflow, data.agentTime)}</section>
    <section class="home-section" id="recent"><div class="home-section-head"><div><h2>Recent activity</h2><p>The latest public activity from each source.</p></div><a href="/profile">Show all →</a></div>${recent}<p class="home-footnote">${data.lastUpdated ? `Last synced ${html(data.lastUpdated)}. ` : ''}Each source appears once, with its latest activity.</p></section>
  </div>`;
  return shell(`${data.ownerName} · overview`, body, 'home', homeStyles);
}
