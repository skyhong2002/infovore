import { agentName, type WorkBlock } from '../computai/types.js';
import { dateFormat } from '../data/time.js';
import type { Activity } from '../data/types.js';
import { healthActivityMeta } from './health-activity.js';
import { html, timeAmount } from './pages.js';

// Statuses that say nothing a reader needs (every stats.fm row is `listened`).
const HIDDEN_STATUSES = new Set(['listened', 'work_block', 'daily_summary']);

// A work block: when, how many sessions, which agents and projects. Daily
// summaries from before segments were synced have only a token count.
function computaiMeta(activity: Activity): string {
  const e = activity.extra as Partial<WorkBlock>;
  if (!e.start || !e.end) return 'Claude Code and Codex · every machine';
  const clock = (iso: string) => dateFormat('en', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
  return [`${clock(e.start)}–${clock(e.end)}`, `${e.sessions} session${e.sessions === 1 ? '' : 's'}`,
    (e.sources ?? []).map(agentName).join(', '), (e.projects ?? []).slice(0, 3).join(', ')].filter(Boolean).join(' · ');
}

// One line of human-readable detail for an activity, already HTML-escaped:
// the artist, author or channel, progress, platform and playtime — never the
// raw internal status labels such as `work_block` or `daily_summary`.
// Events keep their source status, but an "upcoming"/"ticketed" event whose
// Taipei date is already past reads as "date passed" so it is not presented
// as still ahead. It does not claim attendance.
const FORWARD_STATUSES = new Set(['upcoming', 'ticketed', 'planned']);
export function eventStatusLabel(activity: Activity, now = new Date()): string | null {
  const status = activity.status;
  if (!status || !FORWARD_STATUSES.has(status)) return null;
  const when = Date.parse(activity.occurredAt ?? '');
  if (!Number.isFinite(when)) return null;
  const day = (ms: number) => new Date(ms + 8 * 3_600_000).toISOString().slice(0, 10);
  return day(when) < day(now.getTime()) ? `date passed · was ${status.replaceAll('_', ' ')}` : null;
}

export function activityMeta(activity: Activity, now = new Date()): string {
  if (activity.source === 'health') return html(healthActivityMeta(activity));
  if (activity.source === 'dayflow') return html(`${timeAmount(Number(activity.extra.activeMinutes) * 60)} active · ${timeAmount(Number(activity.extra.idleMinutes) * 60)} idle`);
  if (activity.source === 'computai') return html(computaiMeta(activity));
  const details: string[] = [];
  const add = (value: unknown) => details.push(html(value));
  if (activity.status && !HIDDEN_STATUSES.has(activity.status)) add(eventStatusLabel(activity, now) ?? activity.status.replaceAll('_', ' '));
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
