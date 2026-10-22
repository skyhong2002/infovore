export type ReadPhase = 'repository_read' | 'activities_list' | 'activities_since' | 'coverage'
  | 'latest_public' | 'public_count' | 'source_counts' | 'health_status' | 'sleep_time'
  | 'health_snapshot' | 'new_entry_count' | 'dayflow_snapshot' | 'computai_snapshot'
  | 'agent_time' | 'cloud_terms' | 'homepage' | 'source_persistence' | 'time_ledger'
  | 'time_spent' | 'daily_time' | 'health_activity_counts';

// Observe existing synchronous work only: no additional reads, probes or
// freshness publication. Fixed phase names keep row contents and query
// parameters out of logs. Rate limiting bounds repeated slow-path output.
export function createReadTimer(options: {
  now?: () => number; wallNow?: () => number;
  report?: (entry: { phase: ReadPhase; startedAt: string; milliseconds: number; failed: boolean }) => void;
} = {}) {
  const now = options.now ?? (() => performance.now());
  const wallNow = options.wallNow ?? Date.now;
  const report = options.report ?? ((entry) => console.warn(`[read-duration] ${JSON.stringify(entry)}`));
  const reported = new Map<ReadPhase, number>();
  return function measureRead<T>(phase: ReadPhase, work: () => T): T {
    const start = now(), wallStart = wallNow();
    let failed = true;
    try { const result = work(); failed = false; return result; }
    finally {
      const end = now(), milliseconds = end - start;
      if (milliseconds >= 250 && end - (reported.get(phase) ?? -Infinity) >= 10_000) {
        reported.set(phase, end);
        try { report({ phase, startedAt: new Date(wallStart).toISOString(), milliseconds: Math.round(milliseconds), failed }); }
        catch { /* Diagnostics must preserve the operation's result/error. */ }
      }
    }
  };
}

export const measureRead = createReadTimer();
