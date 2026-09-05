import type { Activity } from '../data/types.js';

export function healthActivityMeta(activity: Activity): string {
  const clock = (value: unknown) => typeof value === 'string' ? new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(value)) : '';
  const span = (seconds: unknown) => {
    const minutes = Math.round(Number(seconds ?? 0) / 60);
    return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
  };
  if (activity.status === 'sleep') return [
    `${clock(activity.extra.startTime)}–${clock(activity.extra.endTime)}`,
    activity.extra.asleepSeconds == null ? `紀錄 ${span(activity.extra.sessionSeconds)} · 實睡未提供`
      : `${activity.extra.partialStages ? '≥ ' : ''}${span(activity.extra.asleepSeconds)} 實睡`,
    activity.extra.efficiency == null ? '效率未提供' : `效率 ${activity.extra.efficiency}%（非評分）`,
    ...(activity.extra.asleepSeconds == null ? [] : [`深睡 ${span(activity.extra.deepSeconds)} · REM ${span(activity.extra.remSeconds)}`]),
  ].join(' · ');
  if (activity.status === 'workout') return `${activity.extra.durationMinutes ?? 0} min exercise`;
  return 'Daily step total · Taipei';
}
