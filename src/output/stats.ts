import type { SourceTimeSpent, TimeSpentSummary, TimeWindows } from '../data/database.js';
import { html, shell, sourceLabel, timeAmount } from './pages.js';

const WINDOW_COLUMNS: Array<{ key: keyof TimeWindows; title: string }> = [
  { key: 'last24h', title: 'Last 24h' },
  { key: 'day', title: 'Today' },
  { key: 'week', title: 'This week' },
  { key: 'month', title: 'This month' },
  { key: 'year', title: 'This year' },
  { key: 'allTime', title: 'All time' },
];

function cell(seconds: number, approx: string): string {
  return seconds ? `${approx}${timeAmount(seconds)}` : '—';
}

function totalApprox(summary: TimeSpentSummary, window: keyof TimeWindows): string {
  return summary.sources.some((entry) => entry.method === 'estimated' && entry.windows[window] > 0) ? '~' : '';
}

function sourceRow(entry: SourceTimeSpent): string {
  const approx = entry.method === 'estimated' ? '~' : '';
  const values = WINDOW_COLUMNS.map(({ key }) => `<td>${cell(entry.windows[key], approx)}</td>`).join('');
  return `<tr><td><a href="/platforms/${html(entry.source)}">${html(sourceLabel(entry.source))}</a></td>
    <td><span class="time-method">${html(entry.method)}</span></td>${values}</tr>`;
}

function weekShare(summary: TimeSpentSummary): string {
  const active = summary.sources.filter((entry) => entry.windows.week > 0);
  if (!active.length) return '';
  const max = Math.max(...active.map((entry) => entry.windows.week));
  const rows = active.map((entry) => `<div class="time-share-row">
    <span class="pill">${html(sourceLabel(entry.source))}</span>
    <div class="bar"><span style="width:${Math.max(2, Math.round(entry.windows.week / max * 100))}%"></span></div>
    <strong>${cell(entry.windows.week, entry.method === 'estimated' ? '~' : '')}</strong>
  </div>`).join('');
  return `<section class="content-section"><div class="section-heading"><div><div class="eyebrow">Share of the week</div><h2>Where this week went</h2></div></div>
    <div class="time-share">${rows}</div></section>`;
}

export function statsPage(ownerName: string, summary: TimeSpentSummary): string {
  const intro = `<section class="page-intro"><div><div class="eyebrow">Aggregated view</div><h1>Time</h1>
    <p>How much time this system has recorded ${html(ownerName)} spending with each connected platform — like a cross-platform stats.fm.</p></div>
    <div class="page-intro-aside">Overlapping activity is counted per platform, so totals can exceed wall-clock time.</div></section>
    <div class="context-line"><a href="/">Home</a><span>→</span><strong>Time</strong><span>→</span><a href="/platforms">Platforms</a></div>`;
  const headline = `<div class="metric-grid">${WINDOW_COLUMNS.map(({ key, title }) =>
    `<div class="metric-card"><span class="pill">${title}</span><span class="count">${cell(summary.total[key], totalApprox(summary, key))}</span></div>`
  ).join('')}</div>`;
  const table = summary.sources.length
    ? `<section class="content-section"><div class="section-heading"><div><div class="eyebrow">Per platform</div><h2>Time by platform</h2></div><a href="/api/time-spent.json">JSON</a></div>
      <div class="time-table-wrap"><table class="time-table">
      <thead><tr><th>Platform</th><th>Method</th>${WINDOW_COLUMNS.map(({ title }) => `<th>${title}</th>`).join('')}</tr></thead>
      <tbody>${summary.sources.map(sourceRow).join('')}</tbody>
      <tfoot><tr><td>All platforms</td><td></td>${WINDOW_COLUMNS.map(({ key }) =>
        `<td>${cell(summary.total[key], totalApprox(summary, key))}</td>`).join('')}</tr></tfoot>
      </table></div></section>`
    : '<div class="empty">No time has been recorded yet — totals appear once the platforms have synced.</div>';
  const method = `<section class="content-section"><div class="section-heading"><div><div class="eyebrow">Honest accounting</div><h2>How these numbers are made</h2></div></div>
    <div class="grid">
    <div class="card"><span class="pill">Measured</span><p class="muted">stats.fm time comes from individual stream durations, with week/month/year/lifetime read from stats.fm's full history. Backloggd uses the per-day playtime logged on each game, including its backfilled session history.</p></div>
    <div class="card"><span class="pill">Estimated ~</span><p class="muted">YouTube time is mirrored per day from urtube, which blends extension-measured seconds, saved progress and video length; every sync replaces the whole series. Simkl and Kitsu report only lifetime totals, so their time is the growth of those totals between syncs. It accumulates from the day this tracking was deployed and is day-granular, so "last 24h" means today in Taipei.</p></div>
    <div class="card"><span class="pill">Scheduled &amp; derived ~</span><p class="muted">Attended events count their scheduled start–end span (2 h when no end time was recorded). Books count pages at a ~30 pages/hour pace on the day they were finished. Both are estimates of engagement, not measurements.</p></div>
    </div></section>`;
  return shell(`${ownerName} · time`, intro + headline + table + weekShare(summary) + method, 'stats');
}
