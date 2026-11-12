import { securityHeaders } from './security-headers.js';
import { homeSnapshot } from './home-snapshot.js';
import { fork, type ChildProcess } from 'node:child_process';
import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';

// delayed/delayAfterHours: the source's own (informational) delay threshold; absent from older backends.
export interface SourceHealth {
  source: string; fresh: boolean; ageMs: number | null; error: string | null; delayed?: boolean; delayAfterHours?: number;
}
export interface HealthBody { status: string; maxSourceAgeHours: number; sources: SourceHealth[] }
export interface HealthSnapshot { capturedAt: number; body: HealthBody }

// A gallery page fires one request per card image at once (~30 on /cards), so
// the cap must clear that burst; it still bounds work behind a stalled read.
export const DEFAULT_MAX_IN_FLIGHT = 64;

// This module must never import config, Repository, renderers or the app. Even
// cold startup/migrations and refresh persistence belong in the isolated child.
export function startGateway(options: {
  port?: number; hostname?: string; backendFile?: URL; staleMs?: number; requestDeadlineMs?: number; maxInFlight?: number;
  homeRefreshMs?: number; homeCooldownMs?: number; homeMaxAgeMs?: number; homeMaxBytes?: number; robotsTxt?: string;
} = {}) {
  const staleMs = options.staleMs ?? 3000;
  const deadlineMs = options.requestDeadlineMs ?? 3000;
  const maxInFlight = options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
  let snapshot: HealthSnapshot | null = null;
  let receivedAt = 0;
  let ageAtReceipt = 0;
  let backendPort = 0;
  let backendError: string | null = 'backend_starting';
  let inFlight = 0;
  let closed = false;
  const pending = new Set<ReturnType<typeof request>>();
  const child: ChildProcess = fork(options.backendFile ?? new URL('./app-backend.ts', import.meta.url), [], {
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  child.on('message', (message: any) => {
    if (closed) return;
    if (message.type === 'ready') { backendPort = message.port; home.refresh(); }
    if (message.type === 'health') {
      snapshot = message.snapshot;
      receivedAt = performance.now();
      ageAtReceipt = Math.max(0, Date.now() - snapshot!.capturedAt);
      backendError = null;
    }
    if (message.type === 'health-error') backendError = 'metadata_read_failed';
  });
  child.on('error', () => { backendError = 'backend_error'; backendPort = 0; });
  child.on('exit', () => { backendError = 'backend_exited'; backendPort = 0; });
  const snapshotAge = () => ageAtReceipt + Math.max(0, performance.now() - receivedAt);
  const transportError = () => backendError ?? (!snapshot ? 'snapshot_missing' : snapshotAge() > staleMs ? 'snapshot_stale' : null);

  const home = homeSnapshot({ refreshMs: options.homeRefreshMs, cooldownMs: options.homeCooldownMs,
    maxAgeMs: options.homeMaxAgeMs, maxBytes: options.homeMaxBytes, deadlineMs, backendError: transportError,
    acquire() {
      if (!backendPort || inFlight >= maxInFlight) return null;
      inFlight++;
      return { port: backendPort, release() { inFlight--; } };
    },
  });
  const server = createServer((req, res) => {
    let path: string;
    try { path = new URL(req.url ?? '/', 'http://localhost').pathname; }
    catch { return json(res, 400, { error: 'invalid_request_target' }); }
    // Liveness of this process only, for the container healthcheck. Traefik
    // routes only to healthy containers, so readiness or source freshness here
    // would replace the gateway's explicit 503s and last-good page with an
    // edge 404 for the whole host. Readiness stays in /healthz.
    if (path === '/livez' && (req.method === 'GET' || req.method === 'HEAD')) return json(res, 200, { status: 'alive' }, req.method === 'HEAD');
    if (path === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
      const error = transportError();
      const elapsed = snapshot ? snapshotAge() : 0;
      const sources = snapshot?.body.sources.map((source) => {
        const ageMs = source.ageMs === null ? null : source.ageMs + elapsed;
        const aged = { ...source, ageMs, fresh: ageMs !== null && ageMs <= snapshot!.body.maxSourceAgeHours * 3_600_000 };
        if (typeof source.delayAfterHours === 'number') aged.delayed = ageMs === null || ageMs > source.delayAfterHours * 3_600_000;
        return aged;
      }) ?? [];
      const saturated = inFlight >= maxInFlight;
      const status = error || saturated || !sources.some((source) => source.fresh) ? 'unhealthy'
        : sources.every((source) => source.fresh && !source.error) ? 'healthy' : 'degraded';
      return json(res, status === 'unhealthy' ? 503 : 200, {
        status, maxSourceAgeHours: snapshot?.body.maxSourceAgeHours ?? null, sources,
        backend: { inFlight, maxInFlight, error: saturated ? 'backend_busy' : null },
        metadata: { capturedAt: snapshot ? new Date(snapshot.capturedAt).toISOString() : null,
          ageMs: snapshot ? elapsed : null, fresh: !error, error },
      }, req.method === 'HEAD');
    }
    // Static and backend-independent: a robots.txt 5xx makes Google treat the
    // whole host as unavailable and pause crawling.
    if (path === '/robots.txt' && options.robotsTxt !== undefined && (req.method === 'GET' || req.method === 'HEAD')) {
      res.writeHead(200, { ...securityHeaders, 'Content-Type': 'text/plain; charset=UTF-8', 'Cache-Control': 'public, max-age=3600',
        'Content-Length': String(Buffer.byteLength(options.robotsTxt)) });
      res.end(req.method === 'HEAD' ? undefined : options.robotsTxt);
      return;
    }
    if (home.serve(req, res)) return;
    const error = transportError();
    if (!backendPort || error) return unavailable(req, res, error ?? 'backend_starting');
    if (inFlight >= maxInFlight) return unavailable(req, res, 'backend_busy');
    inFlight++;
    // Streaming proxy: preserve binary, compressed, MCP/SSE, Host, methods,
    // authorization, status codes and headers without buffering response bodies.
    const upstream = request({ hostname: '127.0.0.1', port: backendPort, path: req.url, method: req.method,
      headers: proxyHeaders(req.headers), agent: false });
    pending.add(upstream);
    let done = false;
    let responding = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      inFlight--;
      pending.delete(upstream);
    };
    // On deadline the client gets 503, but admission stays occupied until the
    // actual backend response settles. Never race a DB write then start another
    // copy of it, or accumulate an unbounded queue of abandoned operations.
    const timer = setTimeout(() => { unavailable(req, res, 'backend_deadline'); }, deadlineMs);
    upstream.on('response', (response) => {
      responding = true;
      clearTimeout(timer);
      response.on('end', finish);
      response.on('close', finish);
      response.on('error', () => { finish(); if (!res.writableEnded) res.destroy(); });
      if (res.writableEnded || res.destroyed) response.resume();
      else {
        res.writeHead(response.statusCode ?? 502, proxyHeaders(response.headers));
        response.pipe(res);
      }
    });
    upstream.on('error', () => { finish(); unavailable(req, res, 'backend_unavailable'); });
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => { if (responding && !res.writableFinished) upstream.destroy(); });
    req.pipe(upstream);
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.listen(options.port ?? Number(process.env.PORT ?? 3000), options.hostname ?? '0.0.0.0');
  return { server, child, close() {
    closed = true;
    home.close();
    for (const upstream of pending) upstream.destroy();
    server.closeAllConnections();
    server.close();
    if (child.connected) child.disconnect();
  } };
}

// A temporary 503 from the gateway. Browsers asking for a page get a short,
// readable page with a retry link; scripts and APIs keep the JSON body. Both
// carry Retry-After so clients back off instead of hammering a busy backend.
const UNAVAILABLE_RETRY_SECONDS = 15;
function unavailable(req: IncomingMessage, res: ServerResponse, reason: string): void {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  const wantsPage = (req.method === 'GET' || req.method === 'HEAD') && (req.headers.accept ?? '').includes('text/html');
  if (!wantsPage) {
    res.setHeader('Retry-After', String(UNAVAILABLE_RETRY_SECONDS));
    return json(res, 503, { error: reason });
  }
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Busy for a moment · infovore</title><style>body{background:#0e0f12;color:#f3f4f6;font:16px/1.6 system-ui,sans-serif;margin:0;padding:48px 20px}main{margin:0 auto;max-width:560px}h1{font-size:26px;margin:0 0 12px}p{color:#c4c9d0}a{color:#a9c1e6;display:inline-block;padding:10px 0}@media(prefers-color-scheme:light){body{background:#f4f3ef;color:#15171c}p{color:#3f454e}a{color:#2b4a76}}</style></head><body><main><h1>infovore is busy for a moment</h1><p>The site is starting up or handling too many requests. Nothing is lost: the data is safe and the page should work again within about ${UNAVAILABLE_RETRY_SECONDS} seconds.</p><p><a href="">Try again</a></p></main></body></html>`;
  res.writeHead(503, { ...securityHeaders, 'Content-Type': 'text/html; charset=UTF-8', 'Cache-Control': 'no-store', 'Retry-After': String(UNAVAILABLE_RETRY_SECONDS) });
  res.end(req.method === 'HEAD' ? undefined : page);
}

function json(res: ServerResponse, status: number, value: unknown, head = false): void {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  res.writeHead(status, { ...securityHeaders, 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' });
  res.end(head ? undefined : JSON.stringify(value));
}

function proxyHeaders(input: IncomingHttpHeaders): IncomingHttpHeaders {
  const result = { ...input };
  const hopByHop = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
  const connection = input.connection?.split(',').map((name) => name.trim().toLowerCase()) ?? [];
  for (const name of [...hopByHop, ...connection]) delete result[name];
  return result;
}
