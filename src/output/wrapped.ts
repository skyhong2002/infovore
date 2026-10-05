import type { AgentPeriod } from '../computai/store.js';
import { agentName } from '../computai/types.js';
import type { WrappedSummary, YearTime } from '../data/database.js';
import { html, info, shell, sourceLabel, timeAmount } from './pages.js';
import { timeNotes } from './platforms.js';
import { platformColors } from './rhythm.js';

export interface WrappedExtras {
  time?: YearTime | null;
  agents?: AgentPeriod | null;
  // Years with any recorded activity, for the year switcher.
  years?: number[];
}

const compact = (value: number) => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
const number = (value: number) => new Intl.NumberFormat('en').format(value);
const hours = (seconds: number) => `${number(Math.round(seconds / 360) / 10)}h`;

function stat(label: string, value: string, note = '', tip = ''): string {
  return `<div class="metric-card"><span class="pill">${html(label)}${tip ? info(tip) : ''}</span><span class="count">${html(value)}</span>${note ? `<span class="muted wrapped-note">${html(note)}</span>` : ''}</div>`;
}

function timeSection(time: YearTime): string {
  if (!time.sources.length) return '';
  const max = Math.max(...time.sources.map((entry) => entry.seconds));
  const rows = time.sources.map((entry) => {
    const approx = entry.method === 'estimated' ? '~' : '';
    const share = time.total ? Math.round(entry.seconds / time.total * 100) : 0;
    const note = timeNotes[entry.source];
    return `<div class="wrapped-row"><a href="/platforms/${html(entry.source)}">${html(sourceLabel(entry.source))}</a>${note ? info(note) : '<span></span>'}<div class="bar"><span style="width:${Math.max(1, Math.round(entry.seconds / max * 100))}%;background:${platformColors[entry.source] ?? 'var(--accent)'}"></span></div><strong>${approx}${timeAmount(entry.seconds)}</strong><span class="wrapped-share">${share}%</span></div>`;
  }).join('');
  const caveat = time.complete ? '' : '<p class="feed-note">stats.fm time for past years only counts streams synced into infovore, so it can undercount.</p>';
  return `<section class="content-section"><div class="section-heading"><div><div class="eyebrow">Time</div><h2>Where the year went</h2></div><span>${hours(time.total)} across ${time.sources.length} platforms · overlaps counted per platform</span></div>
    <div class="wrapped-panel">${rows}</div>${caveat}</section>`;
}

function agentSection(agents: AgentPeriod): string {
  if (!agents.seconds && !agents.tokens) return '';
  const maxTokens = Math.max(1, ...agents.projects.map((project) => project.tokens));
  const projects = agents.projects.map((project) => `<div class="wrapped-row wrapped-row-simple"><span>${html(project.name)}</span><div class="bar"><span style="width:${Math.max(1, Math.round(project.tokens / maxTokens * 100))}%;background:${platformColors.computai}"></span></div><strong>${compact(project.tokens)}</strong></div>`).join('');
  const totalTokens = agents.agents.reduce((total, agent) => total + agent.tokens, 0) || 1;
  const split = agents.agents.map((agent) => `${html(agentName(agent.name))} ${Math.round(agent.tokens / totalTokens * 100)}%`).join(' · ');
  return `<section class="content-section"><div class="section-heading"><div><div class="eyebrow">ComputAI</div><h2>AI agents</h2></div><a href="/platforms/computai">Open ComputAI →</a></div>
    <div class="metric-grid">
      ${stat('Agent time', hours(agents.seconds), `on ${agents.activeDays} days`, 'Wall-clock time with any Claude Code or Codex session producing output, on every machine; parallel sessions count once.')}
      ${stat('Tokens', compact(agents.tokens), split)}
      ${stat('Sessions', number(agents.sessions), `${agents.machines} ${agents.machines === 1 ? 'machine' : 'machines'}`)}
    </div>
    ${projects ? `<div class="wrapped-panel wrapped-panel-gap"><div class="wrapped-panel-title">Top projects by tokens</div>${projects}</div>` : ''}</section>`;
}

export function wrappedPage(ownerName: string, summary: WrappedSummary, extras: WrappedExtras = {}): string {
  const { time, agents } = extras;
  const years = (extras.years ?? []).filter((year) => year !== summary.year);
  const switcher = years.length ? `<nav class="search-filters" aria-label="Other years">${[...years, summary.year].sort((a, b) => b - a).map((year) => `<a href="/wrapped/${year}"${year === summary.year ? ' aria-current="true"' : ''}>${year}</a>`).join('')}</nav>` : '';
  const intro = `<section class="page-intro"><div><div class="eyebrow">Archive · annual view</div><h1>${summary.year} Wrapped</h1><p>A year-sized summary of ${html(ownerName)}'s cross-media activity and recorded time, derived from the same entries as the archive.</p></div><div class="page-intro-aside"><a href="/api/wrapped/${summary.year}.json">JSON</a></div></section>
    <div class="context-line"><a href="/">Home</a><span>→</span><a href="/profile">Archive</a><span>→</span><strong>${summary.year} Wrapped</strong></div>${switcher}`;
  const headline = `<div class="metric-grid">
    ${stat('Activities', number(summary.totalActivities), summary.firstActivityAt ? `since ${summary.firstActivityAt.slice(5, 10).replace('-', '/')}` : '', 'Dated public entries this year. YouTube counts watches; every stats.fm stream is one entry.')}
    ${time ? stat('Recorded time', hours(time.total + (agents?.seconds ?? 0)), `${(time.sources.length + (agents?.seconds ? 1 : 0))} platforms`, 'Time per platform added up, so overlapping activity on two platforms counts twice.') : ''}
    ${agents?.seconds ? stat('AI agent time', hours(agents.seconds), `${compact(agents.tokens)} tokens`) : ''}
    ${stat('Average rating', summary.averageRating == null ? '—' : String(summary.averageRating), 'out of 10, across rated entries')}
  </div>`;
  const mergedTime = time && agents?.seconds
    ? { ...time, sources: [...time.sources, { source: 'computai', method: 'measured' as const, seconds: agents.seconds }].sort((a, b) => b.seconds - a.seconds), total: time.total + agents.seconds }
    : time;
  const maxKind = Math.max(1, ...Object.values(summary.byKind));
  const kinds = Object.entries(summary.byKind).map(([kind, count]) => `<div class="wrapped-row wrapped-row-simple"><span>${html(kind)}</span><div class="bar"><span style="width:${Math.max(1, Math.round(count / maxKind * 100))}%"></span></div><strong>${number(count)}</strong></div>`).join('');
  const media = `<section class="content-section"><div class="section-heading"><div><div class="eyebrow">Entries</div><h2>Across media</h2></div></div>${kinds ? `<div class="wrapped-panel">${kinds}</div>` : '<div class="empty">No dated activity has been collected for this year yet.</div>'}</section>`;
  const titles = summary.topTitles.map((item, index) => `<li><span class="wrapped-rank">${index + 1}</span><span class="wrapped-title"><a href="/search?q=${encodeURIComponent(item.title)}">${html(item.title)}</a><small>${html(item.kind)}</small></span><strong>${number(item.count)}×</strong></li>`).join('');
  const top = `<section class="content-section"><div class="section-heading"><div><div class="eyebrow">Repeats</div><h2>Most active titles</h2></div><span>Entries per title</span></div>${titles ? `<ol class="wrapped-titles">${titles}</ol>` : '<div class="empty">No titles to rank yet.</div>'}</section>`;
  const styles = `
    .wrapped-note{font-size:12px}
    .wrapped-panel{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-sm);box-shadow:var(--shadow);display:grid;gap:9px;padding:14px 18px}
    .wrapped-panel-gap{margin-top:10px}.wrapped-panel-title{color:var(--quiet);font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
    .wrapped-row{align-items:center;display:grid;gap:10px;grid-template-columns:120px 16px minmax(0,1fr) 64px 38px;font-size:13px}
    .wrapped-row-simple{grid-template-columns:150px minmax(0,1fr) 64px}
    .wrapped-row>a,.wrapped-row>span:first-child{color:var(--text);font-weight:600;overflow:hidden;text-decoration:none;text-overflow:ellipsis;white-space:nowrap;text-transform:none}
    .wrapped-row>a:hover{color:var(--accent)}.wrapped-row strong{font-variant-numeric:tabular-nums;text-align:right}.wrapped-share{color:var(--quiet);font-size:12px;font-variant-numeric:tabular-nums;text-align:right}
    .wrapped-titles{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-sm);box-shadow:var(--shadow);columns:2;column-gap:0;list-style:none;margin:0;padding:6px 0}
    .wrapped-titles li{align-items:center;break-inside:avoid;display:grid;gap:10px;grid-template-columns:24px minmax(0,1fr) auto;padding:7px 18px}
    .wrapped-rank{color:var(--quiet);font-size:12px;font-variant-numeric:tabular-nums;text-align:right}
    .wrapped-title{min-width:0}.wrapped-title a{color:var(--text);display:block;font-size:13.5px;font-weight:600;overflow:hidden;text-decoration:none;text-overflow:ellipsis;white-space:nowrap}.wrapped-title a:hover{color:var(--accent)}.wrapped-title small{color:var(--quiet);font-size:11px;text-transform:uppercase}
    .wrapped-titles strong{font-size:13px;font-variant-numeric:tabular-nums}
    @media(max-width:700px){.wrapped-titles{columns:1}.wrapped-row{grid-template-columns:96px 16px minmax(0,1fr) 56px}.wrapped-share{display:none}.wrapped-row-simple{grid-template-columns:110px minmax(0,1fr) 56px}}`;
  return shell(`${ownerName} · ${summary.year} Wrapped`, intro + headline + (mergedTime ? timeSection(mergedTime) : '') + (agents ? agentSection(agents) : '') + media + top, 'profile', styles);
}
