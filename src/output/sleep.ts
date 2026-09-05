import { sleepAxis, sleepHour } from '../health/sleep.js';
import type { HealthConnectExtra, SleepSession, SleepStage } from '../health/types.js';
import { html, timeAmount } from './pages.js';

const stages: Array<{ key: SleepStage; label: string }> = [
  { key: 'deep', label: '深睡' }, { key: 'light', label: '淺睡' },
  { key: 'rem', label: 'REM' }, { key: 'awake', label: '清醒' },
  { key: 'asleep', label: '睡眠（未分期）' }, { key: 'unknown', label: '未提供階段' },
];
const clock = (timestamp: string) => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).format(new Date(timestamp));
const calendar = (timestamp: string) => new Intl.DateTimeFormat('zh-TW', {
  timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric',
}).format(new Date(timestamp));
const duration = (seconds: number) => {
  const minutes = Math.round(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
};
const asleep = (session: SleepSession) => session.stageSeconds.unknown === session.sessionSeconds
  ? '未提供' : `${session.stageSeconds.unknown > 0 ? '≥ ' : ''}${duration(session.asleepSeconds)}`;

export function sleepSection(extra: HealthConnectExtra): string {
  const days = extra.sleep?.days ?? [];
  const visible = days.slice(0, 14);
  const latest = days[0];
  const main = latest?.intervals.reduce<SleepSession | undefined>((longest, session) =>
    !longest || session.sessionSeconds > longest.sessionSeconds ? session : longest, undefined);
  if (!latest || !main) return `<section id="sleep"><div class="platform-section-heading"><h2>Sleep · 睡眠</h2></div>
    <div class="empty"><strong>尚未收到睡眠紀錄 · No sleep records received</strong>
    <p>已收到步數或運動，不代表睡眠已同步。請在 Infovore Health App 按「只同步睡眠」，查看睡眠筆數或錯誤。</p>
    <p>若顯示 0 筆，請到 Health Connect 的睡眠資料確認是否有紀錄，並檢查 Garmin Connect 的睡眠寫入權限與 Infovore 的睡眠讀取權限。</p></div></section>`;

  const axis = sleepAxis(visible);
  const position = (hour: number) => (hour - axis.start) / (axis.end - axis.start) * 100;
  const grid = axis.ticks.map((hour) => `<i class="sleep-gridline${hour % 4 === 0 ? ' major' : ''}${hour === 24 ? ' midnight' : ''}" style="left:${position(hour)}%"></i>`).join('');
  const ticks = axis.ticks.filter((hour) => hour % 4 === 0).map((hour) => {
    const h = ((hour % 24) + 24) % 24;
    const suffix = hour < 24 ? '前一天' : hour >= 48 ? '後一天' : '';
    return `<span class="sleep-tick${hour === axis.start ? ' first' : hour === axis.end ? ' last' : ''}" style="left:${position(hour)}%">${h % 12 || 12}${h < 12 ? 'am' : 'pm'}${suffix ? `<small>${suffix}</small>` : ''}</span>`;
  }).join('');
  const sleeping = main.segments.filter((segment) => !['awake', 'unknown'].includes(segment.stage));
  const onset = sleeping[0]?.startTime;
  const wake = sleeping.at(-1)?.endTime;
  const stageLegend = stages.map(({ key, label }) => `<span><i class="sleep-color ${key}"></i>${label}</span>`).join('');
  const rows = visible.map((day) => day.intervals.map((session, index) => {
    const range = `${calendar(session.startTime)} ${clock(session.startTime)} → ${calendar(session.endTime)} ${clock(session.endTime)}`;
    const segments = session.segments.map((segment) => {
      const left = position(sleepHour(day.day, segment.startTime));
      const width = position(sleepHour(day.day, segment.endTime)) - left;
      const label = stages.find((stage) => stage.key === segment.stage)!.label;
      return `<span class="sleep-segment ${segment.stage}" style="left:${left}%;width:${width}%" title="${html(`${label} · ${clock(segment.startTime)}–${clock(segment.endTime)}`)}"></span>`;
    }).join('');
    const breakdown = stages.map(({ key, label }) => `<span><i class="sleep-color ${key}"></i>${label}<strong>${duration(session.stageSeconds[key])}</strong></span>`).join('');
    return `<article class="sleep-row">
      <div class="sleep-date"><time datetime="${html(day.day)}">${html(calendar(`${day.day}T12:00:00+08:00`))}</time><small>${new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', weekday: 'short' }).format(new Date(`${day.day}T12:00:00+08:00`))}${day.sessions > 1 ? ` · 第 ${index + 1}/${day.sessions} 段` : ''}</small></div>
      <div class="sleep-track" role="img" aria-label="${html(`${range}，紀錄 ${duration(session.sessionSeconds)}，實睡 ${asleep(session)}`)}">${grid}<div class="sleep-range">${html(range)}</div>${segments}</div>
      <div class="sleep-quality"><strong>${asleep(session)} <small>實睡</small></strong><span>${session.efficiency === null ? '效率 — · 階段不完整' : `效率 ${session.efficiency}% · 清醒 ${duration(session.stageSeconds.awake)}`}</span>
        <details><summary>階段明細 · 紀錄 ${duration(session.sessionSeconds)}</summary><div class="sleep-breakdown">${breakdown}</div><ol class="sleep-segment-list">${session.segments.map((segment) => `<li>${clock(segment.startTime)}–${clock(segment.endTime)} · ${stages.find((stage) => stage.key === segment.stage)!.label}</li>`).join('')}</ol></details>
      </div></article>`;
  }).join('')).join('');

  return `<section id="sleep">
    <div class="platform-section-heading"><h2>Sleep · 睡眠</h2><span>Asia/Taipei · 依醒來日期</span></div>
    <div class="sleep-latest-label">最近一次主要睡眠 · ${html(latest.day)} 醒來</div>
    <div class="platform-stats sleep-stats">
      <div class="platform-stat"><span>入睡 · 首段睡眠</span><strong>${onset ? clock(onset) : '—'}</strong><small>紀錄開始 ${calendar(main.startTime)} ${clock(main.startTime)}</small></div>
      <div class="platform-stat"><span>醒來 · 末段睡眠結束</span><strong>${wake ? clock(wake) : '—'}</strong><small>紀錄結束 ${calendar(main.endTime)} ${clock(main.endTime)}</small></div>
      <div class="platform-stat"><span>實際睡眠 · 依階段加總</span><strong>${asleep(main)}</strong><small>整段紀錄 ${duration(main.sessionSeconds)} · 含清醒</small></div>
      <div class="platform-stat"><span>睡眠效率 · 非睡眠評分</span><strong>${main.efficiency === null ? '—' : `${main.efficiency}%`}</strong><small>${main.efficiency === null ? '階段資料不完整，無法計算' : `實睡 ÷ 整段紀錄 · 清醒 ${duration(main.stageSeconds.awake)}`}</small></div>
    </div>
    <div class="sleep-chart-heading"><div><h3>睡眠作息與品質</h3><p>每列是一段睡眠，位置代表實際時間。手機可左右滑動。</p></div><span>最近 ${visible.length} 個有紀錄的日子</span></div>
    <div class="sleep-legend">${stageLegend}</div>
    <div class="sleep-scroll" tabindex="0" role="region" aria-label="橫向睡眠時間軸，可左右捲動"><div class="sleep-timeline">
      <div class="sleep-axis"><span>醒來日期</span><div>${ticks}</div><span>睡眠品質</span></div>${rows}
    </div></div>
    <p class="platform-note">時間皆為台北時間；橫軸預設為前一天 8pm 至當天 12pm，有午睡或較晚起床時會自動延伸。入睡／醒來取首段／末段已記錄睡眠，不等同紀錄起迄。實睡包含深睡、淺睡、REM 與未分期睡眠，排除清醒；階段缺漏或衝突時顯示「未提供階段」，不推算效率。效率只依已同步階段計算，100% 不代表滿分睡眠品質。Health Connect 未提供 Garmin 睡眠評分，這裡呈現階段與效率，不另造分數。</p>
    <p class="sleep-history">已收到 ${extra.sleep?.totalSessions ?? 0} 段睡眠 · 最近 ${days.length} 個有紀錄日的平均紀錄時長 ${timeAmount(days.reduce((sum, day) => sum + day.sessionSeconds, 0) / days.length)}／日（含清醒${days.some((day) => day.sessions > 1) ? '與多段睡眠' : ''}）</p>
  </section>`;
}
