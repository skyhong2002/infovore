import { gzip } from 'node:zlib';
import { request, type IncomingMessage, type ServerResponse } from 'node:http';

export interface HomeOptions {
  refreshMs?: number; cooldownMs?: number; maxAgeMs?: number; maxBytes?: number; deadlineMs: number;
  acquire(): { port: number; release(): void } | null;
  backendError(): string | null;
}

// One public canonical HTML page, never a cache of arbitrary visitor requests.
// Generation time is the START of the backend read, not its late completion.
export function homeSnapshot(options: HomeOptions) {
  const refreshMs = options.refreshMs ?? 60_000;
  const cooldownMs = options.cooldownMs ?? 5_000;
  const maxAgeMs = options.maxAgeMs ?? 15 * 60_000;
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  let page: { body: Buffer; zipped: Buffer; generatedAt: number; started: number } | null = null;
  let active: ReturnType<typeof request> | null = null;
  let nextAttempt = 0;
  let error: string | null = 'snapshot_missing';
  let closed = false;

  function refresh() {
    if (closed || active || performance.now() < nextAttempt) return;
    const slot = options.acquire();
    if (!slot) return;
    const generatedAt = Date.now();
    const started = performance.now();
    const upstream = request({ hostname: '127.0.0.1', port: slot.port, path: '/', method: 'GET',
      headers: { accept: 'text/html', 'accept-encoding': 'identity' }, agent: false });
    active = upstream;
    let settled = false;
    const deadline = setTimeout(() => { error = 'backend_deadline'; }, options.deadlineMs);
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      active = null;
      nextAttempt = performance.now() + cooldownMs;
      slot.release();
    };
    upstream.on('error', () => { error = 'backend_unavailable'; finish(); });
    upstream.on('response', (response) => {
      const cacheControl = response.headers['cache-control'] ?? '';
      const vary = response.headers.vary?.toLowerCase().split(',').map((s) => s.trim()) ?? [];
      let valid = response.statusCode === 200 && /^text\/html\b/i.test(response.headers['content-type'] ?? '')
        && !response.headers['set-cookie'] && !/\b(private|no-store)\b/i.test(cacheControl)
        && !response.headers['content-encoding'] && vary.every((name) => name === 'accept-encoding');
      if (!valid) error = 'invalid_home_response';
      let size = 0;
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {
        if (!valid) return;
        size += chunk.length;
        if (size > maxBytes) { valid = false; chunks.length = 0; error = 'snapshot_too_large'; }
        else chunks.push(chunk);
      });
      response.on('end', () => {
        if (valid && size === 0) error = 'invalid_home_response';
        if (!valid || size === 0 || closed) { finish(); return; }
        const body = Buffer.concat(chunks, size);
        chunks.length = 0;
        // Async zlib runs off the gateway event loop. Both encodings are bounded,
        // generated once, and belong to the same single page (not visitor variants).
        gzip(body, { maxOutputLength: maxBytes }, (failure, zipped) => {
          if (!closed && !settled) {
            if (failure) error = 'snapshot_encoding_failed';
            else { page = { body, zipped, generatedAt, started }; error = null; }
          }
          finish();
        });
      });
      response.on('error', () => { error = 'backend_unavailable'; finish(); });
      response.on('close', () => { if (!response.complete) { error = 'backend_unavailable'; finish(); } });
    });
    upstream.end();
  }
  const timer = setInterval(refresh, refreshMs);
  timer.unref();

  function serve(req: IncomingMessage, res: ServerResponse): boolean {
    if (req.url !== '/' || !['GET', 'HEAD'].includes(req.method ?? '') || req.headers.authorization || req.headers.cookie
      || req.headers.range || req.headers['if-none-match'] || req.headers['if-modified-since']) return false;
    const ageMs = page ? Math.max(0, performance.now() - page.started) : 0;
    if (page && ageMs > maxAgeMs) page = null;
    if (!page) {
      refresh();
      res.writeHead(503, { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ error: 'home_snapshot_unavailable' }));
      return true;
    }
    const gzipAccepted = (req.headers['accept-encoding'] ?? '').split(',').some((part) => {
      const [encoding, ...params] = part.trim().toLowerCase().split(';');
      const q = params.find((param) => param.trim().startsWith('q='))?.trim().slice(2);
      return encoding === 'gzip' && (q === undefined || Number(q) > 0);
    });
    const body = gzipAccepted ? page.zipped : page.body;
    const stale = ageMs >= refreshMs || Boolean(error || options.backendError());
    res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8', 'Cache-Control': 'no-store',
      'X-Home-Generated-At': new Date(page.generatedAt).toISOString(), Age: String(Math.floor(ageMs / 1000)),
      'X-Home-Stale': String(stale), 'X-Home-Error': error ?? options.backendError() ?? 'none',
      'Content-Length': String(body.length), Vary: 'Accept-Encoding',
      ...(gzipAccepted ? { 'Content-Encoding': 'gzip' } : {}) });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  }
  return { refresh, serve, close() { closed = true; clearInterval(timer); page = null; active?.destroy(); } };
}
