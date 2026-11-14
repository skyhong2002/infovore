import type { QualityLabels } from './quality.js';
import type { DayflowBatch, DayflowCategory, DayflowDay } from './types.js';
import { dayflowKeywords } from './keywords.js';

export function summarizeDay(day: string, batches: DayflowBatch[], now = new Date(), quality?: QualityLabels): DayflowDay {
  const start = Date.parse(`${day}T04:00:00+08:00`), end = Math.min(start + 86400000, +now);
  const intervals = batches.flatMap((batch) => batch.cards.map((card) => {
    const category = batch.categories.find((c) => c.name === card.category);
    return { start: Math.max(start, Date.parse(card.start)), end: Math.min(end, Date.parse(card.end)),
      name: card.category, color: category?.color_hex ?? '#94a3b8',
      idle: category?.is_idle ?? card.category.toLowerCase() === 'idle',
      error: card.category.toLowerCase() === 'system' || card.subcategory?.toLowerCase() === 'error' };
  })).filter((i) => i.end > i.start);
  // Partition overlapping intervals once, preferring analyzed activity over errors/idle.
  const points = [...new Set(intervals.flatMap((i) => [i.start, i.end]))].sort((a, b) => a - b);
  const categories = new Map<string, DayflowCategory>();
  let errorMinutes = 0;
  for (let n = 1; n < points.length; n++) {
    const matching = intervals.filter((i) => i.start <= points[n - 1] && i.end >= points[n]);
    matching.sort((a, b) => Number(a.error) - Number(b.error) || Number(a.idle) - Number(b.idle) || b.start - a.start || a.name.localeCompare(b.name));
    const current = matching[0]; if (!current) continue;
    const minutes = (points[n] - points[n - 1]) / 60000;
    if (current.error) { errorMinutes += minutes; continue; }
    const category = categories.get(current.name) ?? { name: current.name, color: current.color, idle: current.idle, minutes: 0 };
    category.minutes += minutes; categories.set(current.name, category);
  }
  const values = [...categories.values()].sort((a, b) => b.minutes - a.minutes);
  const trackedMinutes = values.reduce((sum, c) => sum + c.minutes, 0);
  const idleMinutes = values.filter((c) => c.idle).reduce((sum, c) => sum + c.minutes, 0);
  return { day, trackedMinutes, activeMinutes: trackedMinutes - idleMinutes, idleMinutes, errorMinutes, categories: values, keywords: dayflowKeywords(batches, now, 10, quality) };
}
