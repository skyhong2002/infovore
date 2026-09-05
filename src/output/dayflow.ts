import { readFileSync } from 'node:fs';
import type { DayflowExtra, DayflowSnapshot } from '../dayflow/types.js';
import { h, logo, renderCard, textFont, truncate } from './render.js';
import { html, timeAmount } from './pages.js';

const duration = (minutes: number) => timeAmount(Math.round(minutes * 60));
export function dayflowDetails(extra: DayflowExtra): string {
  const daily = extra.daily.filter((d) => d.trackedMinutes + d.errorMinutes > 0).slice(0, 30);
  const max = Math.max(1, ...daily.map((d) => d.trackedMinutes));
  return `<section><div class="platform-section-heading"><h2>Categories this week</h2><span>Monday–Sunday · 4am boundary</span></div>
    <div class="platform-tags">${extra.categories.map((c) => `<span><i style="display:inline-block;width:8px;height:8px;background:${html(c.color)};margin-right:6px"></i>${html(c.name)} · ${html(duration(c.minutes))}</span>`).join('') || '<span>No activity this week</span>'}</div></section>
    <section><div class="platform-section-heading"><h2>Recent recorded days</h2><span>Asia/Taipei · 4am–4am</span></div>
    <div class="health-days">${daily.map((d) => `<article class="health-day"><time datetime="${d.day}">${d.day}</time><div class="health-step-track" style="display:flex;height:10px">${d.categories.map((c) => `<span title="${html(c.name)}: ${html(duration(c.minutes))}" style="width:${c.minutes / max * 100}%;background:${html(c.color)};border-radius:0"></span>`).join('')}</div><strong>${html(duration(d.trackedMinutes))}</strong><p>${html(duration(d.activeMinutes))} active · ${html(duration(d.idleMinutes))} idle${d.errorMinutes ? ` · ${html(duration(d.errorMinutes))} analysis unavailable` : ''}</p></article>`).join('') || '<div class="empty">Waiting for the first Dayflow sync.</div>'}</div>
    <div class="platform-note">Computer time includes idle time and excludes analysis errors. Active means non-idle, not a focus score. It may overlap music and video time, so it is shown separately from cross-platform totals. Activity titles, summaries and app names remain private. Missing days are not treated as zero.</div></section>`;
}

// Dayflow's native typography and warm surface palette. Extra fonts are scoped
// to this renderer so other platforms keep their existing font selection.
const dayflowFonts = [
  { name: 'Figtree', data: readFileSync(new URL('../../assets/fonts/Figtree-Regular.ttf', import.meta.url)), weight: 400 as const, style: 'normal' as const },
  { name: 'Figtree', data: readFileSync(new URL('../../assets/fonts/Figtree-Bold.ttf', import.meta.url)), weight: 700 as const, style: 'normal' as const },
  { name: 'Instrument Serif', data: readFileSync(new URL('../../assets/fonts/InstrumentSerif-Regular.ttf', import.meta.url)), weight: 400 as const, style: 'normal' as const },
];

export async function buildDayflowCard(data: DayflowSnapshot): Promise<string> {
  const days = data.extra.daily.filter((d) => d.trackedMinutes + d.errorMinutes > 0).slice(0, 7).reverse();
  const max = Math.max(1, ...days.map((d) => d.trackedMinutes));
  const C = { background: '#FBF7F2', text: '#333333', muted: '#766D66', accent: '#DB6B35', border: '#E6DDD5' };
  const text = (value: string, style: Record<string, unknown> = {}) => h('span', {
    style: { display: 'flex', fontFamily: textFont(value, 'Figtree'), ...style },
  }, value);
  const row = (children: unknown[], style: Record<string, unknown> = {}) => h('div', { style: { display: 'flex', ...style } }, ...children);
  const serif = { fontFamily: 'Instrument Serif', fontWeight: 400 };
  return renderCard(h('div', { style: {
    width: 520, height: '100%', display: 'flex', flexDirection: 'column', position: 'relative',
    backgroundColor: C.background, color: C.text, fontFamily: 'Figtree', padding: 24, gap: 20,
  } },
    // A finite header wash leaves the renderer's bottom trim on a solid surface.
    h('div', { style: { display: 'flex', position: 'absolute', top: 0, left: 0, width: 520, height: 226,
      backgroundImage: 'linear-gradient(145deg, #E8ECF5 0%, #FCE6DC 48%, #FBF7F2 95%)' } }),
    h('div', { style: { display: 'flex', position: 'absolute', top: 0, left: 0, width: 520, height: 226,
      backgroundImage: 'linear-gradient(180deg, rgba(251,247,242,0) 0%, #FBF7F2 100%)' } }),
    row([
      row([h('img', { src: logo('dayflow'), width: 32, height: 32 }), text('Dayflow', { fontSize: 19, fontWeight: 700 })], { gap: 9, alignItems: 'center' }),
      text(truncate(data.profile.name, 28), { fontSize: 12, color: C.muted }),
    ], { justifyContent: 'space-between', alignItems: 'center' }),
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
    ...(data.extra.categories.length ? [row([
      text('Categories this week', { ...serif, fontSize: 23, marginBottom: 10 }),
      row(data.extra.categories.slice(0, 6).map((c) => row([
        h('div', { style: { display: 'flex', width: 7, height: 7, borderRadius: 4, backgroundColor: c.color, flexShrink: 0 } }),
        text(truncate(c.name, 23), { fontSize: 11 }),
        text(duration(c.minutes), { fontSize: 11, color: C.muted }),
      ], { gap: 6, alignItems: 'center', backgroundColor: '#FFFCF9', border: `1px solid ${C.border}`, borderRadius: 6, padding: '6px 8px' })), { gap: 7, flexWrap: 'wrap' }),
    ], { flexDirection: 'column' })] : []),
    row([
      text('Asia/Taipei · Days begin at 4am', { color: C.muted, fontSize: 10 }),
      text('Computer time may overlap other platforms.', { color: C.muted, fontSize: 10, marginTop: 4 }),
    ], { flexDirection: 'column', borderTop: `1px solid ${C.border}`, paddingTop: 12 }),
  ), 520, 620, dayflowFonts);
}
