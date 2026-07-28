export function nextIntervalAt(now: number, intervalMinutes: number): number {
  const intervalMs = intervalMinutes * 60 * 1000;
  return (Math.floor(now / intervalMs) + 1) * intervalMs;
}
