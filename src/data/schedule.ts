export function nextIntervalAt(now: number, intervalMinutes: number): number {
  const intervalMs = intervalMinutes * 60 * 1000;
  return (Math.floor(now / intervalMs) + 1) * intervalMs;
}

// Include the initial cycle in the same completion-based scheduling used for
// later cycles. A slow refresh skips elapsed boundaries rather than overlaps.
export async function refreshAndSchedule(refresh: () => Promise<void>, intervalMinutes: number): Promise<void> {
  try {
    await refresh();
  } finally {
    const now = Date.now();
    setTimeout(() => {
      void refreshAndSchedule(refresh, intervalMinutes);
    }, nextIntervalAt(now, intervalMinutes) - now);
  }
}
