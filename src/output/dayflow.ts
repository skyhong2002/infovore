import { readFileSync } from 'node:fs';
import type { DayflowExtra, DayflowSnapshot } from '../dayflow/types.js';
import { h, logo, renderCard, textFont, truncate } from './render.js';
import { html, timeAmount } from './pages.js';

const duration = (minutes: number) => timeAmount(Math.round(minutes * 60));
export function dayflowDetails(extra: DayflowExtra): string {
  const daily = extra.daily.filter((d) => d.trackedMinutes + d.errorMinutes > 0).slice(0, 30);
  const max = Math.max(1, ...daily.map((d) => d.trackedMinutes));
  const pools = extra.keywordPools;
  const keywords = pools?.all ?? extra.keywords ?? [];
  const special = pools?.distinctive ?? [];
  return `<section><div class="platform-section-heading"><h2>Distinctive lately</h2><span>Recent 7 days vs preceding 90 days</span></div>
    <div class="platform-tags">${special.map((k) => `<span title="${k.historicalMentions} activities in the comparison period; ${k.lift}× the previous mention rate">${html(k.name)} · ${k.mentions} activities</span>`).join('') || `<span>${pools?.status === 'insufficient_history' ? 'More historical activity is needed for comparison' : 'No distinctly rising keywords in this period'}</span>`}</div>
    <div class="platform-note">Less habitual topics whose activity mention rate has risen. ${pools ? `Recent: ${pools.recentFrom}–${pools.recentTo} (${pools.recentDays} recorded days). Comparison: ${pools.baselineFrom}–${pools.baselineTo} (${pools.baselineDays} recorded days).` : ''}</div></section>
    <section><div class="platform-section-heading"><h2>All recent keywords</h2><span>Last 7 Dayflow days · recurring words included</span></div>
    <div class="platform-tags">${keywords.map((k) => `<span>${html(k.name)} · ${k.mentions} activities</span>`).join('') || '<span>No keywords in this period</span>'}</div>
    <div class="platform-note">Tools, projects and topics found in activity descriptions. Repeated new words can appear alongside recognized tool names. Each activity counts once per keyword; counts are mentions, not time spent.</div></section><section><div class="platform-section-heading"><h2>Categories this week</h2><span>Monday–Sunday · 4am boundary</span></div>
    <div class="platform-tags">${extra.categories.map((c) => `<span><i style="display:inline-block;width:8px;height:8px;background:${html(c.color)};margin-right:6px"></i>${html(c.name)} · ${html(duration(c.minutes))}</span>`).join('') || '<span>No activity this week</span>'}</div></section>
    <section><div class="platform-section-heading"><h2>Recent recorded days</h2><span>Asia/Taipei · 4am–4am</span></div>
    <div class="health-days">${daily.map((d) => `<article class="health-day"><time datetime="${d.day}">${d.day}</time><div class="health-step-track" style="display:flex;height:10px">${d.categories.map((c) => `<span title="${html(c.name)}: ${html(duration(c.minutes))}" style="width:${c.minutes / max * 100}%;background:${html(c.color)};border-radius:0"></span>`).join('')}</div><strong>${html(duration(d.trackedMinutes))}</strong><p>${html(duration(d.activeMinutes))} active · ${html(duration(d.idleMinutes))} idle${d.errorMinutes ? ` · ${html(duration(d.errorMinutes))} analysis unavailable` : ''}${d.keywords?.length ? `<br>${d.keywords.map((k) => html(k.name)).join(' · ')}` : ''}</p></article>`).join('') || '<div class="empty">Waiting for the first Dayflow sync.</div>'}</div>
    <div class="platform-note">Computer time includes idle time and excludes analysis errors. Active means non-idle, not a focus score. It may overlap music and video time, so it is shown separately from cross-platform totals. Full activity titles, summaries and app lists remain private; recognized keyword labels are public. Missing days are not treated as zero.</div></section>`;
}

// Dayflow's native typography and warm surface palette. Extra fonts are scoped
// to this renderer so other platforms keep their existing font selection.
const dayflowFonts = [
  { name: 'Figtree', data: readFileSync(new URL('../../assets/fonts/Figtree-Regular.ttf', import.meta.url)), weight: 400 as const, style: 'normal' as const },
  { name: 'Figtree', data: readFileSync(new URL('../../assets/fonts/Figtree-Bold.ttf', import.meta.url)), weight: 700 as const, style: 'normal' as const },
  { name: 'Instrument Serif', data: readFileSync(new URL('../../assets/fonts/InstrumentSerif-Regular.ttf', import.meta.url)), weight: 400 as const, style: 'normal' as const },
];

const C = { background: '#FBF7F2', text: '#333333', muted: '#766D66', accent: '#DB6B35', border: '#E6DDD5' };
const text = (value: string, style: Record<string, unknown> = {}) => h('span', {
    style: { display: 'flex', fontFamily: textFont(value, 'Figtree'), ...style },
  }, value);
const row = (children: unknown[], style: Record<string, unknown> = {}) => h('div', { style: { display: 'flex', ...style } }, ...children);
const serif = { fontFamily: 'Instrument Serif', fontWeight: 400 };

function dayflowShell(data: DayflowSnapshot, content: unknown[], note: string): Promise<string> {
  return renderCard(h('div', { style: {
    width: 520, height: '100%', display: 'flex', flexDirection: 'column', position: 'relative',
    backgroundColor: C.background, color: C.text, fontFamily: 'Figtree', padding: 24, gap: 20,
  } },
    // A finite header wash leaves the renderer's bottom trim on a solid surface.
    h('div', { style: { display: 'flex', position: 'absolute', top: 0, left: 0, width: 520, height: 180,
      backgroundImage: 'linear-gradient(145deg, #E8ECF5 0%, #FCE6DC 48%, #FBF7F2 95%)' } }),
    h('div', { style: { display: 'flex', position: 'absolute', top: 0, left: 0, width: 520, height: 180,
      backgroundImage: 'linear-gradient(180deg, rgba(251,247,242,0) 0%, #FBF7F2 100%)' } }),
    row([
      row([h('img', { src: logo('dayflow'), width: 32, height: 32 }), text('Dayflow', { fontSize: 19, fontWeight: 700 })], { gap: 9, alignItems: 'center' }),
      text(truncate(data.profile.name, 28), { fontSize: 12, color: C.muted }),
    ], { justifyContent: 'space-between', alignItems: 'center' }),
    ...content,
    row([
      text('Asia/Taipei · Days begin at 4am', { color: C.muted, fontSize: 10 }),
      text(note, { color: C.muted, fontSize: 10, marginTop: 4 }),
    ], { flexDirection: 'column', borderTop: `1px solid ${C.border}`, paddingTop: 12 }),
  ), 520, 650, dayflowFonts);
}

export function buildDayflowCard(data: DayflowSnapshot): Promise<string> {
  const days = data.extra.daily.filter((d) => d.trackedMinutes + d.errorMinutes > 0).slice(0, 7).reverse();
  const max = Math.max(1, ...days.map((d) => d.trackedMinutes));
  return dayflowShell(data, [
    row([
      text('This week', { ...serif, fontSize: 34, lineHeight: 1.1 }),
      row([
        row([text(`${data.stats.weeklyHours}h`, { ...serif, fontSize: 56, lineHeight: 1 }), text('Computer time', { fontSize: 12, color: C.muted, marginTop: 6 })], { flexDirection: 'column' }),
        row([text(`${data.stats.weeklyActiveHours}h`, { ...serif, fontSize: 38, lineHeight: 1, color: C.accent }), text('Active time', { fontSize: 12, color: C.muted, marginTop: 6 })], { flexDirection: 'column', borderLeft: '1px solid #DFD3CA', paddingLeft: 28, marginLeft: 36 }),
      ], { alignItems: 'flex-end', marginTop: 12 }),
    ], { flexDirection: 'column' }),
    row([
      row([text('Time by day', { ...serif, fontSize: 23 }), text(`${days.length} recorded days`, { fontSize: 10, color: C.muted })], { justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }),
      ...days.map((d) => row([
        text(d.day.slice(5).replace('-', '/'), { width: 44, fontSize: 12, color: C.muted, flexShrink: 0 }),
        row(d.categories.map((c) => h('div', { style: { display: 'flex', height: 16, width: 300 * c.minutes / max, backgroundColor: c.color, flexShrink: 0 } })),
          { width: 300, flexShrink: 0, backgroundColor: '#EFEAE4', height: 16, borderRadius: 4, overflow: 'hidden' }),
        text(duration(d.trackedMinutes), { width: 64, flexShrink: 0, fontSize: 12, justifyContent: 'flex-end' }),
      ], { alignItems: 'center', gap: 10, marginBottom: 12 })),
      ...(!days.length ? [text('Your days will appear here after the first sync.', { color: C.muted, fontSize: 13, paddingTop: 8, paddingBottom: 16 })] : []),
    ], { flexDirection: 'column', backgroundColor: '#FFFCF9', border: `1px solid ${C.border}`, borderRadius: 12, padding: '16px 20px 6px', boxShadow: '0 2px 5px #EDE2D8' }),
  ], 'Computer time may overlap other platforms.');
}

export function buildDayflowKeywordsCard(data: DayflowSnapshot): Promise<string> {
  const pools = data.extra.keywordPools;
  const keywords = (pools?.all ?? data.extra.keywords ?? []).slice(0, 24);
  const special = (pools?.distinctive ?? []).slice(0, 12);
  const chips = (items: Array<{ name: string; mentions: number }>, accent: boolean) => row(items.map((k) => row([
    text(k.name, { fontSize: 12, color: accent ? '#A44C25' : C.text }),
    text(String(k.mentions), { fontSize: 11, color: C.muted }),
  ], { gap: 7, alignItems: 'center', backgroundColor: accent ? '#FFF0E6' : '#FFFCF9', border: `1px solid ${accent ? '#F2D2BD' : C.border}`, borderRadius: 7, padding: '7px 9px' })), { gap: 8, flexWrap: 'wrap' });
  return dayflowShell(data, [
    row([
      text('Recent keywords', { ...serif, fontSize: 34, lineHeight: 1.1 }),
      text(pools ? `${pools.recentFrom} – ${pools.recentTo} · Last 7 days` : 'Last 7 Dayflow days', { color: C.muted, fontSize: 12, marginTop: 8 }),
    ], { flexDirection: 'column' }),
    row([
      text('Distinctive lately', { ...serif, fontSize: 24, marginBottom: 10 }),
      special.length ? chips(special, true) : text(pools?.status === 'insufficient_history' ? 'Building historical context…' : 'No distinctly rising topics yet.', { fontSize: 12, color: C.muted }),
    ], { flexDirection: 'column' }),
    row([
      text('All recent keywords', { ...serif, fontSize: 24, marginBottom: 10 }),
      keywords.length ? chips(keywords, false) : text('No keywords in this period.', { fontSize: 12, color: C.muted }),
    ], { flexDirection: 'column' }),
  ], 'Activity mentions · Distinctive topics compare with the preceding 90 days.');
}

export function buildDayflowCategoriesCard(data: DayflowSnapshot): Promise<string> {
  const categories = data.extra.categories;
  const total = categories.reduce((sum, c) => sum + c.minutes, 0);
  const shown = categories.slice(0, 8);
  if (categories.length > 8) shown.push({ name: 'Other categories', color: '#94a3b8', idle: false, minutes: categories.slice(8).reduce((sum, c) => sum + c.minutes, 0) });
  return dayflowShell(data, [
    row([
      text('Categories this week', { ...serif, fontSize: 34, lineHeight: 1.1 }),
      text(`${duration(total)} recorded · ${categories.length} categories`, { fontSize: 12, color: C.muted, marginTop: 8 }),
    ], { flexDirection: 'column' }),
    row(shown.length ? shown.map((c) => row([
      row([text(truncate(c.name, 23), { fontSize: 12 }), text(`${Math.round(c.minutes / Math.max(1, total) * 100)}%`, { fontSize: 11, color: C.muted })], { justifyContent: 'space-between', gap: 8 }),
      text(duration(c.minutes), { ...serif, fontSize: 28, marginTop: 5, marginBottom: 8 }),
      row([h('div', { style: { display: 'flex', width: `${c.minutes / Math.max(1, total) * 100}%`, height: 5, backgroundColor: c.color } })], { height: 5, backgroundColor: '#EFEAE4', borderRadius: 3, overflow: 'hidden' }),
    ], { width: 231, flexDirection: 'column', backgroundColor: '#FFFCF9', border: `1px solid ${C.border}`, borderRadius: 9, padding: 12 }))
      : [text('No categorized activity this week.', { color: C.muted, fontSize: 13 })], { flexWrap: 'wrap', gap: 10 }),
  ], 'Includes idle time; excludes analysis errors.');
}
