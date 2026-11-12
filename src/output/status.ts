import { html, shell, sourceLabel } from './pages.js';
import { syncAge } from './home.js';
import { dateFormat } from '../data/time.js';

// Public error strings keep their category (e.g. "HTTP 404") but never the
// upstream URL, which can name a third-party profile.
export function publicError(error: string | null | undefined): string | null {
  if (!error) return null;
  return error.replace(/\bhttps?:\/\/[^\s"'<>)]+/gi, '[link removed]').slice(0, 300);
}

// These sources are pushed by devices, so the server only knows the last
// successful push; a failing device shows up here as "Delayed" once stale.
const PUSHED_SOURCES = new Set(['health', 'dayflow', 'computai']);

// delayAfterHours: after how long without a successful sync the source counts
// as delayed (shorter for device-pushed Health); `delayed` is that verdict.
export interface StatusSource {
  source: string; lastFetched: string | null; error: string | null; json: string;
  delayed?: boolean; delayAfterHours?: number;
}
export interface StatusView {
  ownerName: string;
  maxSourceAgeHours: number;
  intervalMinutes: number;
  nextScheduledAt: string | null;
  running: string[];
  sources: StatusSource[];
  now?: Date;
}

function errorSummary(error: string): string {
  const http = /HTTP (\d{3})/.exec(error);
  if (http) return `last attempt failed (HTTP ${http[1]})`;
  if (/timed? ?out|deadline/i.test(error)) return 'last attempt timed out';
  return 'last attempt failed';
}

// A readable version of /status for people; /status.json keeps the machine view.
export function statusPage(view: StatusView): string {
  const now = view.now ?? new Date();
  const absolute = (iso: string) => `${dateFormat('en', { timeZone: 'Asia/Taipei', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso))} GMT+8`;
  const limit = (source: StatusSource) => source.delayAfterHours ?? view.maxSourceAgeHours;
  const isStale = (source: StatusSource) => {
    const age = source.lastFetched ? now.getTime() - Date.parse(source.lastFetched) : null;
    return age === null || age > limit(source) * 3_600_000;
  };
  const rows = view.sources.map((source) => {
    const stale = isStale(source);
    const state = source.lastFetched === null ? 'Not synced yet' : stale ? 'Delayed' : source.error ? 'Retrying' : 'Fresh';
    const tone = state === 'Fresh' ? 'ok' : state === 'Retrying' ? 'warn' : 'bad';
    const running = view.running.includes(source.source) ? ' · syncing now' : '';
    const pushed = PUSHED_SOURCES.has(source.source);
    const detail = source.error ? errorSummary(source.error)
      : stale && source.lastFetched ? `older than ${limit(source)} h; showing last good data${pushed ? '. Pushed from a device: check that the device app is running and syncing' : ''}`
      : pushed ? 'pushed from a device; device-side sync errors show in the device app, not here' : '';
    // On phones the column headers are hidden and each row is a card, so every cell carries its
    // column's name: visible for the time, note and data, read-only for the state chip.
    const label = (name: string) => `<span class="status-label">${name}</span>`;
    return `<tr><th scope="row"><a href="/platforms/${html(source.source)}">${html(sourceLabel(source.source))}</a></th>
      <td>${label('State')}<span class="status-chip ${tone}">${state}</span>${running}</td>
      <td>${label('Last successful sync')}${source.lastFetched ? `<time datetime="${html(source.lastFetched)}">${html(syncAge(source.lastFetched, now))}</time><span class="status-abs">${html(absolute(source.lastFetched))}</span>` : '—'}</td>
      <td>${label('Note')}${detail ? html(detail) : '<span class="status-quiet">—</span>'}</td>
      <td>${label('Data')}<a href="${html(source.json)}">JSON</a></td></tr>`;
  }).join('');
  const fresh = view.sources.filter((source) => !isStale(source)).length;
  // Sources with their own delay threshold (device-pushed ones), named in the note.
  const shorter = view.sources.filter((source) => limit(source) !== view.maxSourceAgeHours)
    .map((source) => `${sourceLabel(source.source)} after ${limit(source)} hours`);
  const summary = fresh === view.sources.length ? 'All platforms synced recently.' : `${view.sources.length - fresh} of ${view.sources.length} platforms are behind; their pages keep showing the last good data.`;
  const intro = `<section class="page-intro"><div><div class="eyebrow">Data freshness</div><h1>Sync status</h1><p>${html(summary)} Fetched platforms refresh every ${view.intervalMinutes} minutes; Health, Dayflow and AI agents are pushed from devices when they sync.</p></div><div class="page-intro-aside">${view.nextScheduledAt ? `Next scheduled refresh ${html(syncAgeFuture(view.nextScheduledAt, now))}.` : 'A refresh is running or not scheduled.'}<br><a href="/status.json">Machine-readable status</a> · <a href="/healthz">Health check</a></div></section>`;
  const table = `<div class="time-table-wrap" tabindex="0" role="region" aria-label="Sync status by platform"><table class="time-table status-table"><thead><tr><th scope="col">Platform</th><th scope="col">State</th><th scope="col">Last successful sync</th><th scope="col">Note</th><th scope="col">Data</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="feed-note">“Delayed” means the platform has not synced for over ${view.maxSourceAgeHours} hours${shorter.length ? html(` (device-pushed: ${shorter.join(', ')})`) : ''}. A platform with no new activity can still be fresh. Error details stay on the server. Health, Dayflow and AI agents are pushed by devices, so their failures are reported on the device and appear here only as a delay. Phone screen activity is not listed because its last capture time would reveal live phone use; its daily totals are on the Dayflow page.</p>`;
  const styles = '.status-table th,.status-table td{text-align:left!important;vertical-align:top;white-space:normal}.status-table th[scope=row] a,.status-table td a{display:inline-block;padding:4px 0}.status-table th[scope=row] a{color:var(--text);font-weight:700;text-decoration:none}.status-chip{border-radius:999px;font-size:12.5px;font-weight:700;padding:2px 9px}.status-chip.ok{background:color-mix(in srgb,var(--ok) 16%,transparent);color:var(--ok)}.status-chip.warn{background:color-mix(in srgb,var(--warn) 18%,transparent);color:var(--warn)}.status-chip.bad{background:color-mix(in srgb,var(--warn) 28%,transparent);color:var(--text)}.status-abs{color:var(--quiet);display:block;font-size:12.5px}.status-quiet{color:var(--quiet)}.status-table tbody th{background:none;color:var(--text);font-size:14px;letter-spacing:0;text-transform:none}.status-label{display:none}@media(max-width:640px){.status-label{color:var(--quiet);display:block;font-size:12px;font-weight:700;letter-spacing:.04em}.status-table td:nth-child(2) .status-label{clip:rect(0 0 0 0);clip-path:inset(50%);height:1px;overflow:hidden;position:absolute;white-space:nowrap;width:1px}.status-table td:last-child .status-label{display:inline;margin-right:6px}.status-table thead{display:none}.status-table tr{border-top:1px solid var(--line);display:grid;gap:4px 12px;grid-template-columns:minmax(0,1fr) auto;padding:12px 16px}.status-table tbody tr:first-child{border-top:0}.status-table tbody th,.status-table td{border:0;padding:0!important}.status-table td:nth-child(2){text-align:right!important}.status-table td:nth-child(3),.status-table td:nth-child(4){grid-column:1/-1}.status-table td:nth-child(4):has(.status-quiet){display:none}.status-table td:last-child{grid-column:1/-1}.status-abs{display:inline;margin-left:6px}}';
  return shell(`${view.ownerName} · sync status`, intro + table, 'api', styles, { path: '/status' });
}

function syncAgeFuture(iso: string, now: Date): string {
  const minutes = Math.round((Date.parse(iso) - now.getTime()) / 60_000);
  if (!Number.isFinite(minutes)) return '';
  if (minutes <= 1) return 'in a minute';
  return minutes < 60 ? `in ${minutes} min` : `in ${Math.round(minutes / 60)} h`;
}

export function notFoundPage(ownerName: string, path: string): string {
  const body = `<section class="page-intro"><div><div class="eyebrow">404</div><h1>Nothing here</h1><p>There is no page at <code>${html(path.slice(0, 120))}</code>. It may have moved, or the link may be mistyped.</p></div></section>
    <div class="archive-actions"><a class="archive-action" href="/"><strong>Go to the overview →</strong><span>Time, platforms and the latest activity.</span></a><a class="archive-action" href="/search"><strong>Search the archive →</strong><span>Find a title, artist, channel or venue.</span></a></div>`;
  return shell(`${ownerName} · not found`, body, 'api', '', { noindex: true });
}
