import { homeSnapshot } from './home-snapshot.js';
import { fork, type ChildProcess } from 'node:child_process';
import { createServer, request, type IncomingHttpHeaders, type ServerResponse } from 'node:http';

export interface SourceHealth { source: string; fresh: boolean; ageMs: number | null; error: string | null }
export interface HealthBody { status: string; maxSourceAgeHours: number; sources: SourceHealth[] }
export interface HealthSnapshot { capturedAt: number; body: HealthBody }

// This module must never import config, Repository, renderers or the app. Even
// cold startup/migrations and refresh persistence belong in the isolated child.
export function startGateway(options: {
  port?: number; hostname?: string; backendFile?: URL; staleMs?: number; requestDeadlineMs?: number; maxInFlight?: number;
  homeRefreshMs?: number; homeCooldownMs?: number; homeMaxAgeMs?: number; homeMaxBytes?: number;
} = {}) {
  const staleMs = options.staleMs ?? 3000;
  const deadlineMs = options.requestDeadlineMs ?? 3000;
  const maxInFlight = options.maxInFlight ?? 16;
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
    if (path === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
      const error = transportError();
      const elapsed = snapshot ? snapshotAge() : 0;
      const sources = snapshot?.body.sources.map((source) => {
        const ageMs = source.ageMs === null ? null : source.ageMs + elapsed;
        return { ...source, ageMs, fresh: ageMs !== null && ageMs <= snapshot!.body.maxSourceAgeHours * 3_600_000 };
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
    if (home.serve(req, res)) return;
    const error = transportError();
    if (!backendPort || error) return json(res, 503, { error: error ?? 'backend_starting' });
    if (inFlight >= maxInFlight) return json(res, 503, { error: 'backend_busy' });
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
    const timer = setTimeout(() => { json(res, 503, { error: 'backend_deadline' }); }, deadlineMs);
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
    upstream.on('error', () => { finish(); json(res, 503, { error: 'backend_unavailable' }); });
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

function json(res: ServerResponse, status: number, value: unknown, head = false): void {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' });
  res.end(head ? undefined : JSON.stringify(value));
}

function proxyHeaders(input: IncomingHttpHeaders): IncomingHttpHeaders {
  const result = { ...input };
  const hopByHop = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
  const connection = input.connection?.split(',').map((name) => name.trim().toLowerCase()) ?? [];
  for (const name of [...hopByHop, ...connection]) delete result[name];
  return result;
}
