import type { HealthConnectSnapshot, SleepDay, SleepSession, SleepStage } from '../health/types.js';
import { sleepAxis, sleepHour } from '../health/sleep.js';
import { h, logo, renderCard, truncate } from './render.js';

const C = { bg: '#111418', panel: '#1e232b', text: '#e2e5eb', dim: '#b5becb', accent: '#a8c7fa', border: '#343b46', teal: '#67d5c3' };
const STAGES: Array<{ key: SleepStage; label: string; color: string }> = [
  { key: 'deep', label: 'Deep', color: '#669df6' },
  { key: 'light', label: 'Light', color: '#a8c7fa' },
  { key: 'rem', label: 'REM', color: '#67d5c3' },
  { key: 'awake', label: 'Awake', color: '#f6c177' },
  { key: 'asleep', label: 'Unstaged', color: '#c4b5fd' },
  { key: 'unknown', label: 'Unknown', color: '#535d6b' },
];
const amount = (n: number) => new Intl.NumberFormat('en').format(n);
const duration = (seconds: number) => {
  const m = Math.round(seconds / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
};
const clock = (timestamp: string) => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).format(new Date(timestamp));
const asleep = (s: SleepSession) => s.stageSeconds.unknown >= s.sessionSeconds ? '—'
  : `${s.stageSeconds.unknown > 0 ? '≥ ' : ''}${duration(s.asleepSeconds)}`;
const text = (value: string, style: Record<string, unknown> = {}) => h('span', { style: { display: 'block', color: C.text, fontSize: 11, ...style } }, value);
const row = (children: unknown[], style: Record<string, unknown> = {}) => h('div', { style: { display: 'flex', ...style } }, ...children);
// Reserve an actual gutter; text alignment alone can leave glyphs touching the chart.
const chartValueCell = (value: string, width: number, fontSize: number, color = C.text, fontWeight = 400) => row([
  text(value, { fontSize, color, fontWeight, whiteSpace: 'nowrap' }),
], { width, flexShrink: 0, paddingLeft: 16, justifyContent: 'flex-end', alignItems: 'center' });
const note = (value: string) => text(value, { color: C.dim, fontSize: 9, marginTop: 12, lineHeight: 1.5 });
const empty = (value: string) => row([text(value, { color: C.dim, fontSize: 12 })], { padding: '20px 0' });
const metric = (label: string, value: string) => row([
  text(label, { color: C.dim, fontSize: 10 }),
  text(value, { color: C.accent, fontSize: 23, fontWeight: 700, marginTop: 4 }),
], { flexDirection: 'column', flex: 1, minWidth: 0 });
const legend = () => row(STAGES.map((s) => row([
  h('div', { style: { display: 'flex', width: 6, height: 6, backgroundColor: s.color, borderRadius: 2, marginRight: 4 } }),
  text(s.label, { fontSize: 9, color: C.dim }),
], { alignItems: 'center' })), { gap: 12, marginTop: 10 });

function accessibleText(node: unknown): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(accessibleText).filter(Boolean).join(' · ');
  if (node && typeof node === 'object' && 'props' in node) return accessibleText((node.props as { children?: unknown }).children);
  return '';
}
const escapeXml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function shell(data: HealthConnectSnapshot, title: string, subtitle: string, body: unknown[], height = 350) {
  const node = row([
    row([
      h('img', { src: logo('healthconnect'), width: 26, height: 26, style: { backgroundColor: '#fff', borderRadius: 6, padding: 3, marginRight: 8 } }),
      text('Health Connect', { fontSize: 18, fontWeight: 700 }),
      text(truncate(data.profile.name, 20), { fontSize: 14, fontWeight: 700, marginLeft: 'auto' }),
    ], { alignItems: 'center', marginBottom: 16 }),
    text(title, { fontSize: 12, fontWeight: 700, letterSpacing: 1.2, color: C.accent }),
    text(subtitle, { fontSize: 10, color: C.dim, marginTop: 4, marginBottom: 14 }),
    ...body,
  ], { width: '100%', height: '100%', flexDirection: 'column', backgroundColor: C.bg, border: `1px solid ${C.border}`, borderRadius: 14, padding: '20px 24px', fontFamily: 'Roboto' });
  const svg = await renderCard(node, 520, height);
  // Satori outlines text; retain an accessible, searchable description in SVGs.
  return svg.replace(/(<svg\b[^>]*>)/, (_, opening: string) => `${opening}<title>Health Connect · ${title}</title><desc>${escapeXml(accessibleText(node))}</desc>`);
}

export async function buildHealthCard(data: HealthConnectSnapshot): Promise<string> {
  const days = (data.extra.sleep?.days ?? []).slice(0, 3);
  const workouts = (data.extra.exercise?.days ?? []).slice(0, 3);
  const steps = (data.extra.steps?.days ?? data.extra.daily).filter((day) => day.steps > 0).slice(0, 3);
  const heading = (label: string, latest?: string, first = false) => row([
    text(label, { color: C.accent, fontSize: 11, fontWeight: 700, letterSpacing: 1 }),
    text(latest ? `latest ${latest}` : 'no records', { marginLeft: 'auto', color: C.dim, fontSize: 9 }),
  ], { marginTop: first ? 0 : 16, marginBottom: 10, paddingTop: first ? 0 : 12, ...(first ? {} : { borderTop: `1px solid ${C.border}` }) });
  const dailyBar = (day: string, value: number, max: number, label: string, detail?: string) => row([
    row([text(day, { fontSize: 9 }), ...(detail ? [text(detail, { fontSize: 8, color: C.dim, marginTop: 2 })] : [])], { width: 94, flexDirection: 'column' }),
    row([h('div', { style: { display: 'flex', width: `${value / max * 100}%`, height: 8, backgroundColor: C.teal, borderRadius: 3 } })], { width: 302, borderRadius: 3, backgroundColor: C.panel }),
    chartValueCell(label, 74, 10),
  ], { height: 28, alignItems: 'center', flexShrink: 0 });
  return shell(data, 'HEALTH OVERVIEW', 'Latest 3 recorded days per category · Asia/Taipei', [
    heading('SLEEP', days[0]?.day, true),
    ...(days.length ? sleepTimeline(days) : [empty('No sleep records received yet.')]),
    heading('WORKOUT', workouts[0]?.day),
    ...(workouts.length ? workouts.map((day) => dailyBar(day.day, day.seconds, Math.max(1, ...workouts.map((d) => d.seconds)), duration(day.seconds), `${day.sessions} workout${day.sessions === 1 ? '' : 's'}`)) : [empty('No workouts received yet.')]),
    heading('STEPS', steps[0]?.day),
    ...(steps.length ? steps.map((day) => dailyBar(day.day, day.steps, Math.max(1, ...steps.map((d) => d.steps)), amount(day.steps))) : [empty('No positive step totals received yet.')]),
    note('Recorded dates may differ across categories; missing days are not zero.'),
    note('Sleep colors are synced stages, not a quality score. Unknown time stays unknown.'),
  ], 420 + days.reduce((sum, day) => sum + day.intervals.length * 28, 0));
}

export async function buildHealthSleepCard(data: HealthConnectSnapshot): Promise<string> {
  const days = (data.extra.sleep?.days ?? []).slice(0, 14);
  if (!days.length) return shell(data, 'SLEEP RHYTHM', 'Asia/Taipei · recorded wake-up days', [empty('No sleep records received yet.')]);
  return shell(data, 'SLEEP RHYTHM', `${days.length} recorded wake-up days · Asia/Taipei · ${days[0]!.day}`, [
    ...sleepTimeline(days), note('8pm is the previous evening; axis extends for naps / late wakes.'),
    note('One compact row per session. Unknown stages are not counted as sleep.'),
  ], 210 + days.reduce((sum, day) => sum + day.intervals.length * 28, 0));
}

function sleepTimeline(days: SleepDay[]): unknown[] {
  const axis = sleepAxis(days);
  const width = 302;
  const x = (hour: number) => (hour - axis.start) / (axis.end - axis.start) * width;
  const ticks = axis.ticks.filter((hour) => hour % 4 === 0);
  const labels = ticks.map((hour) => {
    const hour24 = ((hour % 24) + 24) % 24;
    return text(`${hour24 % 12 || 12}${hour24 < 12 ? 'am' : 'pm'}`, { position: 'absolute', left: Math.max(0, Math.min(width - 27, x(hour) - 13)), top: 0, fontSize: 9, color: C.dim });
  });
  const rows = days.flatMap((day) => day.intervals.map((s) => row([
    row([text(day.day.slice(5), { fontSize: 10 }), text(`${clock(s.startTime)}–${clock(s.endTime)}`, { color: C.dim, fontSize: 8, marginTop: 2 })], { width: 94, flexDirection: 'column' }),
    row([
      ...axis.ticks.map((hour) => h('div', { style: { display: 'flex', position: 'absolute', left: x(hour), top: 0, height: 28, width: 1, backgroundColor: hour % 4 === 0 ? '#455263' : '#262e39' } })),
      ...s.segments.map((segment) => h('div', { style: { display: 'flex', position: 'absolute', top: 9, left: x(sleepHour(day.day, segment.startTime)), width: x(sleepHour(day.day, segment.endTime)) - x(sleepHour(day.day, segment.startTime)), height: 10, backgroundColor: STAGES.find((stage) => stage.key === segment.stage)!.color } })),
    ], { position: 'relative', width, height: 28 }),
    chartValueCell(asleep(s), 74, 9),
  ], { alignItems: 'center', height: 28, flexShrink: 0 })));
  return [
    row([text('Date / record', { width: 94, fontSize: 9, color: C.dim }), row(labels, { width, position: 'relative', height: 18 }), chartValueCell('Asleep', 74, 9, C.dim)]),
    ...rows, legend(),
  ];
}

export async function buildHealthSleepStagesCard(data: HealthConnectSnapshot): Promise<string> {
  const days = (data.extra.sleep?.days ?? []).slice(0, 10);
  const rows = days.map((day) => {
    const totals = Object.fromEntries(STAGES.map(({ key }) => [key, day.intervals.reduce((sum, s) => sum + s.stageSeconds[key], 0)])) as Record<SleepStage, number>;
    const total = day.sessionSeconds;
    const knownAsleep = total - totals.awake - totals.unknown;
    const efficiency = totals.unknown > 0 || total <= 0 ? '—' : `${Math.round(knownAsleep / total * 100)}%`;
    return row([
      text(day.day.slice(5), { width: 50, fontSize: 10 }),
      row(STAGES.map(({ key, color }) => h('div', { style: { display: 'flex', height: 12, width: `${total > 0 ? totals[key] / total * 100 : 0}%`, backgroundColor: color } })), { width: 294, borderRadius: 3, overflow: 'hidden' }),
      chartValueCell(totals.unknown >= total ? '—' : `${totals.unknown ? '≥ ' : ''}${duration(knownAsleep)}`, 76, 10),
      chartValueCell(efficiency, 50, 10, C.accent),
    ], { alignItems: 'center', height: 26, flexShrink: 0 });
  });
  return shell(data, 'SLEEP STAGES', `${days.length} recorded days${days[0] ? ` · latest ${days[0].day}` : ''} · stage proportions`, [
    ...(days.length ? [row([text('Date', { width: 50, color: C.dim, fontSize: 9 }), text('Share of recorded time', { width: 294, color: C.dim, fontSize: 9 }), chartValueCell('Asleep', 76, 9, C.dim), chartValueCell('Eff.', 50, 9, C.dim)], { marginBottom: 5 }), ...rows, legend()] : [empty('No sleep records received yet.')]),
    note('Efficiency = asleep / recorded time, not a sleep score. Gaps stay unknown.'),
    note('Bars show proportions, not duration. Multiple sessions are summed per day.'),
  ], 210 + rows.length * 26);
}

export async function buildHealthExerciseCard(data: HealthConnectSnapshot): Promise<string> {
  const entries = data.entries.filter((entry) => entry.status === 'workout').slice(0, 7);
  const maxMinutes = Math.max(1, ...entries.map((entry) => Number(entry.extra.durationMinutes) || 0));
  return shell(data, 'EXERCISE', 'Recorded workouts · most recent first', [
    row([metric('Workouts received', amount(data.stats.workouts ?? 0)), metric('Recorded active time', duration(data.stats.totalExerciseSeconds ?? 0))], { marginBottom: 12 }),
    ...(entries.length ? entries.map((entry) => row([
      text(entry.activityAt ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(entry.activityAt)) : '—', { width: 82, fontSize: 10, color: C.dim }),
      row([
        text(truncate(entry.title, 33), { fontSize: 11 }),
        row([h('div', { style: { display: 'flex', height: 3, width: `${(Number(entry.extra.durationMinutes) || 0) / maxMinutes * 100}%`, backgroundColor: C.teal, borderRadius: 2 } })], { width: 318, marginTop: 4, backgroundColor: C.panel }),
      ], { flexDirection: 'column', width: 318 }),
      chartValueCell(`${entry.extra.durationMinutes ?? 0}m`, 70, 11, C.teal, 700),
    ], { alignItems: 'center', height: 34, borderBottom: `1px solid ${C.border}`, flexShrink: 0 })) : [empty('No workouts received yet.')]),
    note('Workout duration only. Sleep is shown separately, not counted as exercise.'),
  ], 260 + entries.length * 34);
}

export async function buildHealthStepsCard(data: HealthConnectSnapshot): Promise<string> {
  const days = (data.extra.steps?.days ?? data.extra.daily).filter((day) => day.steps > 0).slice(0, 10);
  const max = Math.max(1, ...days.map((day) => day.steps));
  return shell(data, 'DAILY STEPS', `${days.length} recent positive step days${days[0] ? ` · latest ${days[0].day}` : ''}`, [
    row([metric('Latest recorded day', days[0] ? amount(days[0].steps) : '—'), metric('Total steps received', amount(data.stats.totalSteps ?? 0))], { marginBottom: 14 }),
    ...(days.length ? days.map((day) => row([
      text(day.day.slice(5), { width: 50, color: C.dim, fontSize: 10 }),
      row([h('div', { style: { display: 'flex', height: 9, width: `${day.steps / max * 100}%`, backgroundColor: C.teal, borderRadius: 3 } })], { width: 340, backgroundColor: C.panel, borderRadius: 3 }),
      chartValueCell(amount(day.steps), 80, 10),
    ], { height: 25, alignItems: 'center', flexShrink: 0 })) : [empty('No positive step totals in the recent data window.')]),
    note('Recorded daily totals, not a continuous streak. Missing days are not zero.'),
  ], 250 + days.length * 25);
}
