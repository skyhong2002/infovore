export function nextIntervalAt(now: number, intervalMinutes: number): number {
  const intervalMs = intervalMinutes * 60 * 1000;
  return (Math.floor(now / intervalMs) + 1) * intervalMs;
}

// Settle with `work` or reject once `ms` pass, whichever comes first. The work
// itself is not cancelled; callers must ignore a late result.
export function withDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

// What the scheduler is actually doing, for /status: the boundary a timer is
// armed for (null while a cycle runs) and the latest cycle's start/end.
export const scheduleState: { armedFor: number | null; cycleStartedAt: number | null; cycleCompletedAt: number | null } = {
  armedFor: null, cycleStartedAt: null, cycleCompletedAt: null,
};

// Include the initial cycle in the same completion-based scheduling used for
// later cycles. A slow refresh skips elapsed boundaries rather than overlaps,
// and a cycle that never settles is abandoned after `cycleDeadlineMs` so one
// hung upstream cannot stop every later boundary.
export async function refreshAndSchedule(refresh: () => Promise<void>, intervalMinutes: number, cycleDeadlineMs = intervalMinutes * 60_000): Promise<void> {
  scheduleState.armedFor = null;
  scheduleState.cycleStartedAt = Date.now();
  try {
    await withDeadline(refresh(), cycleDeadlineMs, 'refresh cycle');
  } finally {
    const now = Date.now();
    scheduleState.cycleCompletedAt = now;
    scheduleState.armedFor = nextIntervalAt(now, intervalMinutes);
    setTimeout(() => {
      refreshAndSchedule(refresh, intervalMinutes, cycleDeadlineMs).catch((err) => {
        console.error(`[refresh] cycle failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, scheduleState.armedFor - now);
  }
}
