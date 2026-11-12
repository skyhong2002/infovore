import type { DailyTimeSeries, SourceTimeSpent, TimeSpentSummary, TimeWindows } from '../data/database.js';
import { platformColors } from './rhythm.js';
import { delta, html, info, shell, sourceLabel, sparkline, sum, timeAmount } from './pages.js';
import { timeNotes } from './platforms.js';

const WINDOW_COLUMNS: Array<{ key: keyof TimeWindows; title: string }> = [
  { key: 'last24h', title: 'Last 24h' },
  { key: 'last28d', title: 'Last 28 days' },
  { key: 'day', title: 'Today' },
  { key: 'week', title: 'This week' },
  { key: 'month', title: 'This month' },
  { key: 'year', title: 'This year' },
  { key: 'allTime', title: 'All time' },
];

const WINDOW_NOTES: Partial<Record<keyof TimeWindows, string>> = {
  last24h: 'Rolling 24 hours for instant-based sources; day-granular sources count today in Taipei.',
  last28d: 'Rolling 28 Taipei calendar days, including today.',
  week: 'Calendar week starting Monday, Taipei time.',
};

function cell(seconds: number, approx: string): string {
  return seconds ? `${approx}${timeAmount(seconds)}` : '—';
}

function totalApprox(summary: TimeSpentSummary, window: keyof TimeWindows): string {
  return summary.sources.some((entry) => entry.method === 'estimated' && entry.windows[window] > 0) ? '~' : '';
}

const EMPTY_SERIES: number[] = [];

function weekDelta(series: number[], approx: string): string {
  const current = sum(series, series.length - 7, series.length);
  const previous = sum(series, series.length - 14, series.length - 7);
  return delta(current, previous, (value) => `${approx}${timeAmount(value)}`);
}

function sourceRow(entry: SourceTimeSpent, series: number[]): string {
  const approx = entry.method === 'estimated' ? '~' : '';
  const values = WINDOW_COLUMNS.map(({ key }) => `<td data-value="${entry.windows[key]}">${cell(entry.windows[key], approx)}</td>`).join('');
  const current = sum(series, series.length - 7, series.length);
  const previous = sum(series, series.length - 14, series.length - 7);
  const note = timeNotes[entry.source];
  return `<tr><td data-value="${html(sourceLabel(entry.source))}"><a href="/platforms/${html(entry.source)}">${html(sourceLabel(entry.source))}</a><span class="time-method-inline">${html(entry.method)}</span></td>
    <td data-value="${html(entry.method)}"><span class="time-method">${html(entry.method)}</span>${note ? info(note) : ''}</td>
    <td class="time-trend" data-value="${sum(series, 0, series.length)}">${sparkline(series, { color: platformColors[entry.source] ?? 'var(--accent)', label: `${sourceLabel(entry.source)} · daily time over the last 28 days` })}</td>
    <td data-value="${current - previous}">${weekDelta(series, approx)}</td>${values}</tr>`;
}

function weekShare(summary: TimeSpentSummary): string {
  const active = summary.sources.filter((entry) => entry.windows.week > 0);
  if (!active.length) return '';
  const max = Math.max(...active.map((entry) => entry.windows.week));
  const rows = active.map((entry) => `<div class="time-share-row">
    <span class="pill">${html(sourceLabel(entry.source))}</span>
    <div class="bar"><span style="width:${Math.max(2, Math.round(entry.windows.week / max * 100))}%${platformColors[entry.source] ? `;background:${platformColors[entry.source]}` : ''}"></span></div>
    <strong>${cell(entry.windows.week, entry.method === 'estimated' ? '~' : '')}</strong>
  </div>`).join('');
  return `<section class="content-section"><div class="section-heading"><div><div class="eyebrow">Share of the week</div><h2>Where this week went</h2></div><span>Calendar week · Monday to today</span></div>
    <div class="time-share">${rows}</div></section>`;
}

const sortScript = `<script>(()=>{const t=document.querySelector('.time-table');if(!t)return;const w=t.closest('.time-table-wrap'),hint=document.querySelector('.time-table-hint');const pick=document.getElementById('time-window'),narrow=matchMedia('(max-width:1024px)');const showWindow=()=>{const value=pick.value,delta=value==='delta',chosen=narrow.matches?(delta?-2:Number(value)):-1;for(const row of t.rows)[...row.cells].forEach((cell,i)=>cell.classList.toggle('tw-hide',chosen!==-1&&((i===3&&!delta)||(i>=4&&(delta||i-4!==chosen)))))};if(pick){pick.addEventListener('change',()=>{showWindow();fit()});narrow.addEventListener('change',()=>{showWindow();fit()});showWindow()}const fit=()=>{const more=w.scrollWidth-w.clientWidth-w.scrollLeft>2;w.classList.toggle('has-more',more);if(hint)hint.hidden=w.scrollWidth<=w.clientWidth+2};fit();w.addEventListener('scroll',fit,{passive:true});addEventListener('resize',fit);const b=t.tBodies[0];t.querySelectorAll('th[data-sort]').forEach((h)=>{const b=document.createElement('button');b.type='button';b.className='th-sort';b.append(...h.childNodes);h.append(b)});t.querySelectorAll('th[data-sort]').forEach((h,i)=>h.addEventListener('click',()=>{const asc=h.getAttribute('aria-sort')==='descending';t.querySelectorAll('th[data-sort]').forEach(o=>o.removeAttribute('aria-sort'));h.setAttribute('aria-sort',asc?'ascending':'descending');const live=document.getElementById('sort-status');if(live)live.textContent='Sorted by '+h.textContent.trim()+', '+(asc?'ascending':'descending');const v=r=>r.cells[i].dataset.value??'';const num=h.dataset.sort==='number';[...b.rows].sort((a,c)=>{const x=v(a),y=v(c);const d=num?Number(x)-Number(y):x.localeCompare(y);return asc?d:-d}).forEach(r=>b.appendChild(r))}))})()</script>`;

export function statsPage(ownerName: string, summary: TimeSpentSummary, daily: DailyTimeSeries = { days: [], sources: {} }): string {
  const totalSeries = daily.days.map((_, index) => Object.values(daily.sources).reduce((total, series) => total + (series[index] ?? 0), 0));
  const intro = `<section class="page-intro"><div><div class="eyebrow">Aggregated view</div><h1>Time</h1>
    <p>How much time this system has recorded ${html(ownerName)} spending with each connected platform — like a cross-platform stats.fm.</p></div>
    <div class="page-intro-aside">Media platforms (games, shows, anime, books, music, YouTube), manually logged events, exercise from Health and AI agent working time. Computer activity (Dayflow) and sleep are not in this table, so its totals are smaller than the overview's “Where the time went”; see <a href="/platforms/dayflow">Dayflow</a> and <a href="/platforms/health#sleep">Sleep</a>. AI agent time is wall-clock time with an agent running, not attention. Overlapping activity is counted per platform, so totals can exceed wall-clock time.</div></section>`;
  const headline = `<div class="metric-grid">${WINDOW_COLUMNS.map(({ key, title }) => {
    const note = WINDOW_NOTES[key];
    const trend = key === 'last28d' && totalSeries.some(Boolean)
      ? `<span class="metric-trend">${sparkline(totalSeries, { width: 140, height: 28, label: 'All platforms · daily time over the last 28 days' })}${weekDelta(totalSeries, totalApprox(summary, 'last28d'))}</span>`
      : '';
    return `<div class="metric-card"><span class="metric-card-head"><span class="pill">${title}</span>${note ? info(note) : ''}</span><span class="count">${cell(summary.total[key], totalApprox(summary, key))}</span>${trend}</div>`;
  }).join('')}</div>`;
  const table = summary.sources.length
    ? `<section class="content-section"><div class="section-heading"><div><div class="eyebrow">Per platform</div><h2>Time by platform</h2><p>Use the column headings to sort. Trend shows the last 28 days; the change compares the last 7 days with the 7 before. On phones and tablets, pick the window to compare; ~ marks estimates.</p></div><a href="/api/time-spent.json">JSON</a></div>
      <p class="time-table-hint" aria-hidden="true">Scroll the table sideways for more windows →</p><label class="time-window-pick">Window <select id="time-window">${WINDOW_COLUMNS.map(({ title }, index) => `<option value="${index}"${title === 'Last 28 days' ? ' selected' : ''}>${html(title)}</option>`).join('')}<option value="delta">Change vs prior 7 days</option></select></label><p id="sort-status" class="visually-hidden" role="status" aria-live="polite"></p><div class="time-table-wrap" tabindex="0" role="region" aria-label="Time by platform, scrollable"><table class="time-table">
      <thead><tr><th data-sort="text">Platform</th><th data-sort="text">Method</th><th data-sort="number">Trend · 28 d</th><th data-sort="number">vs prior 7 d</th>${WINDOW_COLUMNS.map(({ title }) => `<th data-sort="number">${title}</th>`).join('')}</tr></thead>
      <tbody>${summary.sources.map((entry) => sourceRow(entry, daily.sources[entry.source] ?? EMPTY_SERIES)).join('')}</tbody>
      <tfoot><tr><td>All platforms</td><td></td><td class="time-trend">${sparkline(totalSeries, { label: 'All platforms · daily time over the last 28 days' })}</td><td>${weekDelta(totalSeries, totalApprox(summary, 'last28d'))}</td>${WINDOW_COLUMNS.map(({ key }) =>
        `<td>${cell(summary.total[key], totalApprox(summary, key))}</td>`).join('')}</tr></tfoot>
      </table></div></section>${sortScript}`
    : '<div class="empty">No time has been recorded yet — totals appear once the platforms have synced.</div>';
  const method = `<section class="content-section"><div class="section-heading"><div><div class="eyebrow">Honest accounting</div><h2>How these numbers are made</h2></div></div>
    <div class="grid">
    <div class="card"><span class="pill">Measured</span><p class="muted">Health time comes from exact exercise-session start and end times. stats.fm time comes from individual stream durations, with longer windows read from its full history. Backloggd uses the per-day playtime logged on each game, including its backfilled session history.</p></div>
    <div class="card"><span class="pill">Estimated ~</span><p class="muted">YouTube time is mirrored per day from urtube, which blends extension-measured seconds, saved progress and video length; every sync replaces the whole series. Simkl and Kitsu report only lifetime totals, so their time is the growth of those totals between syncs. It accumulates from the day this tracking was deployed and is day-granular, so "last 24h" means today in Taipei.</p></div>
    <div class="card"><span class="pill">Scheduled &amp; derived ~</span><p class="muted">Attended events count their scheduled start–end span (2 h when no end time was recorded). Books count pages at a ~30 pages/hour pace on the day they were finished. Both are estimates of engagement, not measurements.</p></div>
    </div></section>`;
  return shell(`${ownerName} · time`, intro + headline + table + weekShare(summary) + method, 'stats', '.metric-trend{align-items:center;display:flex;flex-wrap:wrap;gap:6px 10px;margin-top:2px}.metric-trend .spark{max-width:100%}.time-trend{width:120px}.time-table td.time-trend{padding-block:6px}', { path: '/stats' });
}
