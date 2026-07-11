import type { Activity } from '../data/types.js';

function xml(value: string): string {
  return value.replace(/[<>&'"]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[char]!));
}

export function activityRss(activities: Activity[], baseUrl: string, ownerName: string): string {
  const items = activities.map((activity) => {
    const link = `${baseUrl}/now#activity-${activity.id}`;
    const when = activity.occurredAt && /^\d{4}-/.test(activity.occurredAt)
      ? new Date(activity.occurredAt).toUTCString()
      : new Date(activity.firstSeenAt).toUTCString();
    const details = [activity.mediaKind, activity.status, activity.extra.venue].filter(Boolean).join(' · ');
    return `<item><guid isPermaLink="false">${activity.id}</guid><title>${xml(activity.title)}</title><link>${xml(link)}</link><pubDate>${xml(when)}</pubDate><description>${xml(details)}</description></item>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${xml(ownerName)} · infovore</title><link>${xml(baseUrl)}</link><description>Cross-media activity from infovore</description>${items}</channel></rss>`;
}
