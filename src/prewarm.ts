import { createReadStream } from 'node:fs';

// Startup aggregates (Health status and snapshot, all-time counts) scan whole
// tables. On a cold page cache SQLite fetches those pages as 4 KiB random reads,
// which took minutes on the shared host, while one large sequential read of the
// file runs at disk bandwidth. Reading it once before SQLite opens leaves the
// pages in the OS cache. Purely advisory: errors, a missing file or the deadline
// only end the warmup early, and nothing about the data or queries changes.
export async function prewarmFiles(paths: string[], deadlineMs = 60_000): Promise<{ bytes: number; ms: number; complete: boolean }> {
  const started = performance.now();
  let bytes = 0;
  let stream: ReturnType<typeof createReadStream> | null = null;
  let stopped = false;
  const read = async () => {
    let complete = true;
    for (const path of paths) {
      if (stopped) break;
      try {
        stream = createReadStream(path, { highWaterMark: 4 << 20 });
        for await (const chunk of stream) {
          if (stopped) break;
          bytes += (chunk as Buffer).length;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') complete = false;
      }
    }
    return complete;
  };
  // An in-flight open/read on a stalled disk cannot be cancelled, so the
  // deadline races it rather than waiting for the stream to acknowledge.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const complete = await Promise.race([
    read(),
    new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), deadlineMs); }),
  ]);
  clearTimeout(timer);
  if (!complete) {
    stopped = true;
    (stream as ReturnType<typeof createReadStream> | null)?.destroy();
  }
  return { bytes, ms: Math.round(performance.now() - started), complete };
}
