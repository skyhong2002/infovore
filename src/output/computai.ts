import type { ComputaiSnapshot } from '../computai/types.js';
import { h, renderCard } from './render.js';

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

function compact(n: number): string {
  for (const [size, unit] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'k']] as const) if (n >= size) return `${(n / size).toFixed(1)}${unit}`;
  return String(Math.round(n));
}

function taipeiDate(iso: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Taipei', month: 'short', day: 'numeric' }).format(new Date(iso));
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
  const stats = [[compact(report.tokens), 'tokens'], [`${Math.round(report.agentHours)} h`, 'agent hours'],
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
