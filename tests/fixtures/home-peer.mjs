import { createServer } from 'node:http';
let mode = 'hang';
let count = 0;
let serial = 0;
const pending = new Set();
const html = '<!doctype html><p>Genuine last synced: synthetic source label</p>';
function respond(res) {
  res.statusCode = mode === 'error' ? 503 : 200;
  res.setHeader('content-type', 'text/html; charset=UTF-8');
  if (mode === 'private') res.setHeader('cache-control', 'private');
  if (mode === 'cookie') res.setHeader('set-cookie', 'private=value');
  if (mode === 'vary') res.setHeader('vary', 'Cookie');
  if (mode === 'encoded') res.setHeader('content-encoding', 'gzip');
  if (mode === 'empty') { res.end(); return; }
  if (mode === 'reset') { res.destroy(); return; }
  res.end(mode === 'oversize' ? 'x'.repeat(16384) : `${html}<!--${serial}-->`);
}
const server = createServer((req, res) => {
  if (req.url !== '/' || req.headers.authorization || req.headers.cookie) {
    res.setHeader('content-type', 'application/octet-stream');
    res.end(Buffer.from([0, 255, 17, 128]));
    return;
  }
  count++;
  if (mode === 'hang') { pending.add(res); res.on('close', () => pending.delete(res)); }
  else respond(res);
});
server.listen(0, '127.0.0.1', () => process.send?.({ type: 'ready', port: server.address().port }));
process.on('message', (m) => {
  if (m.health) process.send?.({ type: 'health', snapshot: { capturedAt: Date.now(), body: { status: 'healthy', maxSourceAgeHours: 1, sources: [{ source: 'synthetic', fresh: true, ageMs: 0, error: null }] } } });
  if (m.mode) { mode = m.mode; serial++; }
  if (m.release) { for (const res of pending) respond(res); pending.clear(); }
  process.send?.({ type: 'stats', count, pending: pending.size, serial });
});
process.on('disconnect', () => process.exit());
