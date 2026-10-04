import { compactNumber, dailyTokens, type ComputaiExtra, type ComputaiSnapshot } from '../computai/types.js';
import { html } from './pages.js';
import { h, renderCard } from './render.js';
import { dateFormat } from '../data/time.js';

// A deliberately plain card in GitHub's own palette so it sits quietly in a
// profile README. Two variants share one layout; the README picks one with
// <picture> and prefers-color-scheme.
const THEMES = {
  dark: { background: '#0d1117', border: '#30363d', text: '#e6edf3', muted: '#8b949e', track: '#21262d',
    bar: '#3b82c4', today: '#2f81f7', models: ['#2f81f7', '#a371f7', '#3fb950', '#6e7681'] },
  light: { background: '#ffffff', border: '#d0d7de', text: '#1f2328', muted: '#656d76', track: '#eaeef2',
    bar: '#8cb4e6', today: '#0969da', models: ['#0969da', '#8250df', '#1a7f37', '#8c959f'] },
};
type Theme = typeof THEMES.dark;

const span = (value: string, style: Record<string, unknown>) => h('span', { style: { display: 'flex', ...style } }, value);
const row = (children: unknown[], style: Record<string, unknown> = {}) => h('div', { style: { display: 'flex', ...style } }, ...children);

function taipeiDate(iso: string): string {
  return dateFormat('en-US', { timeZone: 'Asia/Taipei', month: 'short', day: 'numeric' }).format(new Date(iso));
}

function aiAgentsCard(data: ComputaiSnapshot, c: Theme): Promise<string> {
  const report = data.extra.report;
  const header = row([
    row([span('AI agents', { fontSize: 16, fontWeight: 700 }), span('last 30 days', { fontSize: 13, color: c.muted })], { gap: 8, alignItems: 'baseline' }),
    span(report ? `via ComputAI · ${taipeiDate(report.observedAt)}` : 'via ComputAI', { fontSize: 11, color: c.muted }),
  ], { justifyContent: 'space-between', alignItems: 'baseline' });
  if (!report) {
    return shell(c, [header, span('Waiting for the first ComputAI report.', { fontSize: 13, color: c.muted })]);
  }
  const stats = [[compactNumber(report.tokens), 'tokens'], [`${Math.round(report.agentHours)} h`, 'agent hours'],
    [String(report.peakParallel), 'sessions at once'], [`${Math.round(report.cacheHitPct)}%`, 'from prompt cache']];
  const peak = Math.max(1, ...report.daily);
  const top = report.models.slice(0, 3);
  const rest = Math.max(0, 100 - top.reduce((sum, m) => sum + m.sharePct, 0));
  const shares = [...top.map((m) => ({ name: m.model, pct: m.sharePct })), ...(rest > 0 ? [{ name: 'other', pct: rest }] : [])];
  return shell(c, [
    header,
    row(stats.map(([value, label]) => row([
      span(value, { fontSize: 24, fontWeight: 700, lineHeight: 1.1 }),
      span(label, { fontSize: 11, color: c.muted, marginTop: 2 }),
    ], { flexDirection: 'column', flex: 1 }))),
    row([
      row(report.daily.map((value, i) => h('div', { style: { display: 'flex', flex: 1, height: Math.max(2, 52 * value / peak),
        backgroundColor: i === report.daily.length - 1 ? c.today : c.bar, borderRadius: 1.5 } })), { height: 52, alignItems: 'flex-end', gap: 3 }),
      row([span('tokens per day', { fontSize: 10, color: c.muted }), span('today', { fontSize: 10, color: c.muted })], { justifyContent: 'space-between', marginTop: 5 }),
    ], { flexDirection: 'column' }),
    row([
      row(shares.map((s, i) => h('div', { style: { display: 'flex', width: `${s.pct}%`, height: 8, backgroundColor: c.models[i % c.models.length] } })),
        { height: 8, borderRadius: 4, overflow: 'hidden', backgroundColor: c.track }),
      row(shares.map((s, i) => row([
        h('div', { style: { display: 'flex', width: 8, height: 8, borderRadius: 4, backgroundColor: c.models[i % c.models.length] } }),
        span(s.name, { fontSize: 11 }), span(`${Math.round(s.pct)}%`, { fontSize: 11, color: c.muted }),
      ], { gap: 5, alignItems: 'center' })), { columnGap: 12, rowGap: 6, flexWrap: 'wrap', marginTop: 10 }),
    ], { flexDirection: 'column' }),
  ]);
}

function shell(c: Theme, content: unknown[]): Promise<string> {
  return renderCard(h('div', { style: {
    width: 520, height: '100%', display: 'flex', flexDirection: 'column', gap: 18, padding: 24,
    backgroundColor: c.background, color: c.text, fontFamily: 'Inter', border: `1px solid ${c.border}`, borderRadius: 6,
  } }, ...content), 520, 300);
}

export const buildAiAgentsCard = (data: ComputaiSnapshot) => aiAgentsCard(data, THEMES.dark);
export const buildAiAgentsLightCard = (data: ComputaiSnapshot) => aiAgentsCard(data, THEMES.light);

// Platform page sections: what the agents ran on, and the daily volume behind the card.
export function computaiDetails(extra: ComputaiExtra): string {
  const report = extra.report;
  if (!report) return '<section><div class="empty">Waiting for the first ComputAI report.</div></section>';
  const chips = (items: Array<[string, number]>) => items.map(([name, pct]) => `<span>${html(name)} · ${Math.round(pct)}%</span>`).join('');
  const peak = Math.max(1, ...report.daily);
  return `<section><div class="platform-section-heading"><h2>Models</h2><span>Share of tokens · last 30 days</span></div>
    <div class="platform-tags">${chips(report.models.map((m) => [m.model, m.sharePct]))}</div></section>
    <section><div class="platform-section-heading"><h2>Agents</h2><span>Share of tokens · last 30 days</span></div>
    <div class="platform-tags">${chips(report.fleet.map((f) => [f.source === 'claude' ? 'Claude Code' : f.source === 'codex' ? 'Codex' : f.source, f.pct]))}</div></section>
    <section><div class="platform-section-heading"><h2>Tokens per day</h2><span>Every computer ComputAI reads</span></div>
    <div class="health-days">${dailyTokens(report).filter((d) => d.tokens > 0).map((d) => `<article class="health-day"><time datetime="${d.day}">${d.day}</time><div class="health-step-track"><span style="width:${d.tokens / peak * 100}%"></span></div><strong>${compactNumber(d.tokens)}</strong><p>tokens</p></article>`).join('')}</div>
    <div class="platform-note">ComputAI counts Claude Code and Codex tokens from local session logs on every machine it reads, including prompt-cache reads. Only these aggregates reach infovore; spend, projects and prompts stay on the Mac.</div></section>`;
}
