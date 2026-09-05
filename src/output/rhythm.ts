import type { CoverageDay } from '../data/coverage.js';
import { h, renderCard, textFont, truncate } from './render.js';
import { timeAmount } from './pages.js';

export const coverageSources: Record<string, { label: string; color: string }> = {
  dayflow: { label: 'Dayflow', color: '#f59b45' },
  'health-sleep': { label: 'Sleep', color: '#a8c7fa' },
  health: { label: 'Exercise', color: '#67d5c3' },
  statsfm: { label: 'Music', color: '#1ed760' },
};
const row = (children: unknown[], style: Record<string, unknown> = {}) => h('div', { style: { display: 'flex', ...style } }, ...children);
const text = (value: string, style: Record<string, unknown> = {}) => h('span', { style: { display: 'flex', fontFamily: textFont(value, 'Inter'), ...style } }, value);

export function buildRhythmCard(owner: string, days: CoverageDay[]): Promise<string> {
  const width = 472;
  const total = days.reduce((sum, day) => sum + day.recordedSeconds, 0);
  return renderCard(row([
    row([text('INFOVORE', { color: '#a8c7fa', fontSize: 10, fontWeight: 700, letterSpacing: 2 }), text(truncate(owner, 32), { color: '#92949c', fontSize: 11 })], { justifyContent: 'space-between' }),
    text('Activity rhythm', { fontSize: 30, fontWeight: 700, marginTop: 14 }),
    text(`${days.at(-1)?.day ?? ''} — ${days[0]?.day ?? ''} · Taipei`, { fontSize: 11, color: '#92949c', marginTop: 7 }),
    row([text(timeAmount(total), { fontSize: 35, fontWeight: 700 }), text('recorded / 168h', { fontSize: 12, color: '#92949c', marginLeft: 12, marginBottom: 4 })], { alignItems: 'flex-end', marginTop: 18 }),
    row([0, 6, 12, 18, 24].map(hour => text(hour === 24 ? '24h' : String(hour).padStart(2, '0'), { fontSize: 10, color: '#92949c' })), { justifyContent: 'space-between', marginTop: 20, marginBottom: 2 }),
    ...days.map(day => row([
      row([text(day.day.slice(5), { fontSize: 11, color: '#b8bbc4' }), text(`${timeAmount(day.recordedSeconds)} / 24h`, { fontSize: 11, color: '#b8bbc4' })], { justifyContent: 'space-between', marginBottom: 6 }),
      row([
        ...Array.from({ length: 25 }, (_, i) => h('div', { style: { display: 'flex', position: 'absolute', left: Math.min(width - 1, width * i / 24), top: 0, bottom: 0, width: 1, backgroundColor: i % 6 ? '#292b31' : '#3a3c44' } })),
        ...(day.lanes.length ? day.lanes : [{ source: '', spans: [] }]).map(lane => row(lane.spans.map(span => h('div', { style: { display: 'flex',
          position: 'absolute', left: width * span.startHour / 24, width: width * (span.endHour - span.startHour) / 24,
          height: 6, backgroundColor: coverageSources[lane.source]?.color ?? '#8caacb', borderRadius: 1,
        } })), { position: 'relative', width, height: 6, marginTop: 1, marginBottom: 1 })),
      ], { position: 'relative', width, minHeight: 20, paddingTop: 2, paddingBottom: 2, flexDirection: 'column', backgroundColor: '#22242b', borderRadius: 3, overflow: 'hidden', justifyContent: 'center' }),
    ], { flexDirection: 'column', marginTop: 13 })),
    row([...Object.values(coverageSources), { label: 'Unrecorded', color: '#3a3c44' }].map(source => row([
      h('div', { style: { display: 'flex', width: 7, height: 7, backgroundColor: source.color, marginRight: 4 } }), text(source.label, { fontSize: 10, color: '#b8bbc4' }),
    ], { alignItems: 'center' })), { gap: 12, marginTop: 18 }),
    text('Overlaps counted once · Today is still in progress', { color: '#92949c', fontSize: 10, marginTop: 14 }),
    text('Dayflow includes idle · Sleep sessions · Music duration', { color: '#92949c', fontSize: 10, marginTop: 5 }),
  ], { width: 520, height: '100%', flexDirection: 'column', padding: 24, backgroundColor: '#18191f', color: '#f4f5f7', fontFamily: 'Inter' }), 520, 720);
}
